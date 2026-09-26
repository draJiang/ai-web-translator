(function () {
  // chrome.scripting.executeScript re-runs this whole file on every injection
  // (e.g. each popup click). Guard so we don't attach duplicate listeners —
  // the first injection's closures keep working for the rest of the page's life.
  if (window.__aiReaderInjected) return;
  window.__aiReaderInjected = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEMPLATE', 'MATH', 'CANVAS',
    'IFRAME', 'TITLE', 'SVG',
  ]);
  // Ancestor selector, not just the immediate parent's tagName — syntax
  // highlighters (Prism, highlight.js) wrap code tokens in nested <span>s,
  // so a text node's direct parent is rarely CODE/PRE itself. Also honors
  // the standard translate="no" / .notranslate opt-out convention.
  const SKIP_SELECTOR = [...SKIP_TAGS].join(',') + ', [translate="no"], .notranslate';

  // How far below the viewport (in px) a block is "about to" scroll into
  // view and should be pre-processed, instead of waiting until it's visible.
  const PRELOAD_MARGIN_PX = 600;
  // Kept small so a batch comes back quickly — segments near the preload
  // edge need to finish before the user scrolls the rest of the way to them.
  const MAX_BATCH_CHARS = 900;
  const MAX_BATCH_ITEMS = 20;
  // How long to wait after the DOM goes quiet before treating it as a real
  // content swap (SPA route change, "load more", etc.) worth rescanning.
  const NAV_DEBOUNCE_MS = 500;
  // A selection longer than this isn't "a word or a sentence" any more —
  // decline rather than send an oversized ad-hoc explain request.
  const EXPLAIN_MAX_CHARS = 300;
  // After this many batches fail in a row, stop sending more (newly visible
  // text keeps queueing) until the user hits Retry — otherwise an outage or a
  // rate limit turns every scroll into another round of doomed requests.
  const MAX_CONSECUTIVE_FAILURES = 3;

  // The B1 rewrite prompt (lib/prompts.js) wraps an in-line gloss's
  // explanation in this tag so it can be styled like the Alt+select gloss
  // (italic + dimmed) instead of reading as plain sentence text. Kept
  // deliberately unlike any real word so it can't collide with a webpage's
  // own text.
  const GLOSS_TAG_RE = /<ai-gloss>([\s\S]*?)<\/ai-gloss>/g;
  const STRAY_GLOSS_TAG_RE = /<\/?ai-gloss>/g;

  const state = {
    active: false, // true once the user has turned B1 mode on for this page
    busy: false, // a batch request is currently in flight
    generation: 0, // bumped on every start/restore so stale async results are dropped
    originalMap: new Map(), // text node -> original text
    rewriteCache: new Map(), // original text -> rewritten text, survives restore() so turning rewrite mode back on doesn't re-call the API for text seen before
    trackedNodes: new WeakSet(), // nodes already scheduled at least once (processed or pending)
    observer: null,
    elToSegments: null, // Element -> segment[] awaiting that element's visibility
    queue: [], // segments that are visible/near-visible and not yet processed
    draining: false,
    navObserver: null, // MutationObserver that detects SPA-style content swaps
    navDebounceTimer: null,
    glossElements: new Set(), // <span> nodes inserted by the Alt+select explain feature
    glossTailNodes: new Set(), // text nodes split off by a gloss inserted mid-node; removed (not reverted) on restore
    rewriteWrappers: new Map(), // original text node -> <span> wrapper, for rewrites that contained an in-line gloss
    failedSegments: new Set(), // segments (or the leftover nodes of one) whose rewrite failed, waiting for Retry
    paused: false, // set after a non-retryable error or too many failures in a row; drain() stays idle until Retry
    consecutiveFailures: 0,
    lastError: null, // most recent batch failure, for the reason shown on the failure toast
  };

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return !!style && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function getMainRoot() {
    return document.querySelector('main') || document.body;
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.ai-reader-ignore')) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Group consecutive text nodes that share the same parent element into one
  // "segment" — segments are what we watch for scroll visibility and what we
  // send to the AI as one unit, so a sentence split across inline tags stays
  // reasonably coherent instead of firing one request per tiny fragment.
  function buildSegments(nodes) {
    const segments = [];
    let current = null;
    for (const node of nodes) {
      const el = node.parentElement;
      if (current && current.el === el) {
        current.nodes.push(node);
      } else {
        current = { el, nodes: [node], queued: false, done: false };
        segments.push(current);
      }
    }
    return segments;
  }

  function chunkNodes(nodes, maxChars, maxItems) {
    const chunks = [];
    let cur = [];
    let curChars = 0;
    for (const node of nodes) {
      const len = node.nodeValue.length;
      if (cur.length && (curChars + len > maxChars || cur.length >= maxItems)) {
        chunks.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(node);
      curChars += len;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  // Builds the plain-text-plus-gloss-spans replacement for a rewritten
  // string that contains one or more <ai-gloss> tags. Returns null if, once
  // any stray/malformed tags are stripped out, there's nothing left to show
  // (caller then falls back to a plain sanitized string instead).
  function buildGlossFragment(text) {
    const fragment = document.createDocumentFragment();
    const plainNodes = [];
    let lastIndex = 0;
    let match;
    GLOSS_TAG_RE.lastIndex = 0;
    const appendPlain = (raw) => {
      const cleaned = raw.replace(STRAY_GLOSS_TAG_RE, '');
      if (!cleaned) return;
      const t = document.createTextNode(cleaned);
      fragment.appendChild(t);
      plainNodes.push(t);
    };
    while ((match = GLOSS_TAG_RE.exec(text))) {
      appendPlain(text.slice(lastIndex, match.index));
      let explanation = match[1].replace(STRAY_GLOSS_TAG_RE, '').trim();
      // Defensive: the prompt asks the model not to add its own parentheses,
      // but strip a redundant pair if it does anyway, so we never render "((…))".
      if (explanation.startsWith('(') && explanation.endsWith(')')) {
        explanation = explanation.slice(1, -1).trim();
      }
      if (explanation) {
        const gloss = document.createElement('span');
        gloss.className = 'ai-reader-gloss ai-reader-ignore';
        gloss.textContent = ` (${explanation})`;
        fragment.appendChild(gloss);
      }
      lastIndex = GLOSS_TAG_RE.lastIndex;
    }
    appendPlain(text.slice(lastIndex));
    return fragment.childNodes.length ? { fragment, plainNodes } : null;
  }

  // Applies one rewritten string to the text node it came from. Most
  // fragments have no gloss and take the original fast path (set nodeValue
  // in place, no DOM structure change). A fragment with an <ai-gloss> tag
  // can't be represented in a single text node — CSS can't style part of a
  // text node's characters — so it's replaced with a small wrapper element
  // containing plain text nodes plus a styled span for the gloss.
  function applyRewrite(node, rewritten) {
    // Checks for either tag, not just the opening one — a lone stray
    // "</ai-gloss>" (no matching open tag) must still go through sanitizing
    // below instead of leaking into nodeValue verbatim.
    if (!rewritten.includes('ai-gloss')) {
      node.nodeValue = rewritten;
      return;
    }
    const built = buildGlossFragment(rewritten);
    if (!built) {
      node.nodeValue = rewritten.replace(STRAY_GLOSS_TAG_RE, '');
      return;
    }
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-reader-rewrite';
    wrapper.appendChild(built.fragment);
    node.replaceWith(wrapper);
    // These plain-text children are brand new nodes the tree walker hasn't
    // seen — without this they'd look like fresh unprocessed content on the
    // next SPA-nav rescan and get sent back to the AI a second time.
    for (const t of built.plainNodes) state.trackedNodes.add(t);
    state.rewriteWrappers.set(node, wrapper);
  }

  // Returns the nodes that came back without a rewrite (the background could
  // only salvage part of a malformed AI response — see processBatch() in
  // lib/providers.js) so the caller can mark just those as failed. Throws if
  // the request as a whole failed.
  async function processNodeBatch(nodes, gen) {
    // Captured once, up front: applyRewrite() may detach a node from the DOM
    // (node.replaceWith(wrapper) when it contains a gloss), so re-deriving
    // parentElement from `nodes` afterwards would silently miss those
    // elements and leave their loading outline stuck on.
    const els = new Set(nodes.map((n) => n.parentElement).filter(Boolean));
    for (const el of els) el.classList.add('ai-reader-loading');
    try {
      // A node's rewrite depends only on its own text (see PROCESS_BATCH in
      // the background worker — each text is rewritten independently), so a
      // cache keyed on the original string is valid across restore()/re-run
      // cycles, not just within one. Only texts we haven't rewritten before
      // go to the API.
      const toFetchTexts = [];
      for (const node of nodes) {
        const text = node.nodeValue;
        if (!state.rewriteCache.has(text) && !toFetchTexts.includes(text)) toFetchTexts.push(text);
      }
      if (toFetchTexts.length) {
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: 'PROCESS_BATCH', texts: toFetchTexts });
        } catch (err) {
          throw messagingError(err);
        }
        if (gen !== state.generation) return []; // superseded by a restore/new run — discard
        if (!res?.ok) throw responseError(res, 'Processing request failed');
        res.results.forEach((rewritten, i) => {
          if (typeof rewritten === 'string' && rewritten.length) {
            state.rewriteCache.set(toFetchTexts[i], rewritten);
          }
        });
      }
      const missing = [];
      for (const node of nodes) {
        if (!state.originalMap.has(node)) state.originalMap.set(node, node.nodeValue);
        const rewritten = state.rewriteCache.get(node.nodeValue);
        if (rewritten) applyRewrite(node, rewritten);
        else missing.push(node);
      }
      return missing;
    } finally {
      for (const el of els) el.classList.remove('ai-reader-loading');
    }
  }

  // The background flattens provider errors into plain fields (see
  // errorResponse() in background/service-worker.js); rebuild an Error that
  // carries them so failure handling can tell "retry later" from "retrying
  // won't help until the settings change".
  function responseError(res, fallback) {
    const err = new Error(res?.error || fallback);
    err.kind = res?.kind;
    err.status = res?.status;
    err.retryable = res?.retryable ?? true;
    return err;
  }

  // sendMessage itself failing: usually the service worker was shut down
  // mid-request (worth retrying), but after the extension is reloaded this
  // old content script is orphaned for good and only a page refresh helps.
  function messagingError(err) {
    const message = err?.message || 'Failed to communicate with the extension background';
    const wrapped = new Error(message);
    if (/context invalidated/i.test(message)) {
      wrapped.kind = 'context';
      wrapped.retryable = false;
    } else {
      wrapped.retryable = true;
    }
    return wrapped;
  }

  // Used when a request succeeded but some items in it came back empty.
  function partialResultError() {
    const err = new Error("Couldn't read part of the AI response");
    err.kind = 'parse';
    err.retryable = true;
    return err;
  }

  // --- Failure tracking and retry ------------------------------------------
  //
  // A failed segment keeps its original text, gets a dashed outline, and
  // waits in state.failedSegments. Every manual retry — the toast's Retry
  // button, clicking a failed block, the popup — goes through retrySegments(),
  // which puts them back at the front of the normal drain() queue.

  function markFailed(seg, err) {
    seg.queued = false;
    seg.done = true;
    seg.el.classList.add('ai-reader-failed');
    state.failedSegments.add(seg);
    state.lastError = err;
  }

  // Nodes that aren't part of a scroll-pipeline segment (selection mode, or
  // the leftovers of a partially-rewritten one) are regrouped by parent so
  // they can be retried through the same queue.
  function markNodesFailed(nodes, err) {
    for (const seg of buildSegments(nodes)) markFailed(seg, err);
  }

  function retrySegments(segs) {
    state.paused = false;
    state.consecutiveFailures = 0;
    for (const seg of segs) {
      state.failedSegments.delete(seg);
      seg.queued = true;
      seg.done = false;
    }
    // Several segments can share an element (same parent, non-adjacent
    // text) — only drop the outline once none of them is still failed.
    for (const seg of segs) {
      if (![...state.failedSegments].some((s) => s.el === seg.el)) seg.el.classList.remove('ai-reader-failed');
    }
    state.queue.unshift(...segs);
    // Retry could come while the queue was paused with nothing in flight,
    // or mid-drain — scheduleDrain() covers both.
    scheduleDrain(state.generation);
  }

  function retryAllFailed() {
    retrySegments([...state.failedSegments]);
  }

  function failureReason(err) {
    if (!err) return 'Unknown error';
    if (err.kind === 'context') return 'Extension was updated. Refresh the page, then retry';
    if (err.retryable === false) {
      if (err.status === 401 || err.status === 403) return 'API key rejected. Check your settings, then retry';
      if (err.kind === 'config') return `${err.message}. Check your settings, then retry`;
      if (err.status) return `Request rejected (${err.status}). Check your settings, then retry`;
      return `${err.message}. Check your settings, then retry`;
    }
    if (err.status === 429) return 'Rate limited (429)';
    if (err.status >= 500) return `Server error (${err.status})`;
    if (err.status) return `Request failed (${err.status})`;
    if (err.kind === 'timeout') return 'Timed out';
    if (err.kind === 'network') return 'Network error';
    if (err.kind === 'parse') return "Couldn't read the AI response";
    return String(err.message || err).slice(0, 60);
  }

  // What the user sees as "a block" is an element with a dashed outline; one
  // element can hold several failed segments (text split around a <a>, etc.).
  function failedBlockCount() {
    return new Set([...state.failedSegments].map((s) => s.el)).size;
  }

  function showFailure() {
    const count = failedBlockCount();
    if (!count) return;
    const err = state.lastError;
    const reason = failureReason(err);
    let text;
    if (err?.retryable === false) text = reason;
    else if (state.paused) text = `Paused after repeated failures · ${reason}`;
    else text = `${count} ${count === 1 ? 'block' : 'blocks'} failed · ${reason}`;
    showStatus(text, 0, true, { label: 'Retry', onClick: retryAllFailed });
  }

  document.addEventListener('click', (event) => {
    if (event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const el = target?.closest('.ai-reader-failed');
    if (!el) return;
    // Leave real controls inside a failed block (links, buttons…) alone, and
    // don't treat the end of a drag-to-select as a click.
    if (target.closest('a, button, input, select, textarea, label, summary')) return;
    if (!window.getSelection()?.isCollapsed) return;
    const segs = [...state.failedSegments].filter((s) => s.el === el);
    if (segs.length) retrySegments(segs);
  });

  // --- Lazy, scroll-driven pipeline for "process whole page" -------------

  function ensureObserver(gen) {
    if (!state.observer) {
      state.elToSegments = new Map();
      state.observer = new IntersectionObserver(
        (entries) => onIntersect(entries, gen),
        { root: null, rootMargin: `0px 0px ${PRELOAD_MARGIN_PX}px 0px`, threshold: 0 }
      );
    }
    return state.observer;
  }

  // Adds newly-discovered segments to the running observer without
  // disturbing segments that are already pending or mid-flight — used both
  // for the initial scan and for incremental rescans after the page's
  // content changes underneath us.
  function addSegments(segments, gen) {
    if (!segments.length) return;
    const observer = ensureObserver(gen);
    for (const seg of segments) {
      if (!state.elToSegments.has(seg.el)) state.elToSegments.set(seg.el, []);
      state.elToSegments.get(seg.el).push(seg);
      observer.observe(seg.el);
    }
  }

  // Scan the current main root for text nodes we haven't seen yet (skips
  // anything already translated or already queued/observed) and start
  // watching them. Safe to call repeatedly — e.g. once up front, then again
  // whenever the page's content changes without a full reload.
  function scanAndObserve(gen) {
    const root = getMainRoot();
    const nodes = collectTextNodes(root).filter(
      (n) => !state.originalMap.has(n) && !state.trackedNodes.has(n) && !state.glossTailNodes.has(n)
    );
    if (!nodes.length) return;
    for (const n of nodes) state.trackedNodes.add(n);
    addSegments(buildSegments(nodes), gen);
  }

  // Some sites replace the page's content via client-side routing (History
  // API) or dynamic loading without a full navigation — the content script
  // stays alive and state.active stays true, but the DOM underneath it is
  // now different. Watch for that and pick up newly-appeared text instead of
  // requiring the user to manually restore and re-trigger B1 mode.
  function startNavWatcher(gen) {
    if (state.navObserver) return;
    state.navObserver = new MutationObserver(() => {
      clearTimeout(state.navDebounceTimer);
      state.navDebounceTimer = setTimeout(() => {
        if (!state.active || gen !== state.generation) return;
        scanAndObserve(gen);
      }, NAV_DEBOUNCE_MS);
    });
    // The batch pipeline usually only touches nodeValue (characterData), so
    // it doesn't trigger this itself — except when a rewrite contains an
    // in-line gloss, where applyRewrite() replaces the text node with a
    // wrapper element (a childList change). Its new plain-text children are
    // added to state.trackedNodes right away so scanAndObserve() doesn't
    // mistake them for fresh unprocessed content. Alt+select's gloss
    // insertion is the same kind of change, but can additionally split an
    // already-processed text node into a head + a brand new tail (see
    // insertGlossNode) — state.glossTailNodes covers that tail the same way.
    state.navObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopNavWatcher() {
    if (state.navObserver) {
      state.navObserver.disconnect();
      state.navObserver = null;
    }
    clearTimeout(state.navDebounceTimer);
  }

  function onIntersect(entries, gen) {
    if (gen !== state.generation) return;
    let added = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const segs = state.elToSegments.get(entry.target) || [];
      for (const seg of segs) {
        if (!seg.queued && !seg.done) {
          seg.queued = true;
          state.queue.push(seg);
          added = true;
        }
      }
      state.observer.unobserve(entry.target);
      state.elToSegments.delete(entry.target);
    }
    if (added) scheduleDrain(gen);
  }

  function scheduleDrain(gen) {
    if (state.draining || state.paused) return;
    drain(gen);
  }

  async function drain(gen) {
    state.draining = true;
    state.busy = true;
    showStatus('Rewriting…');
    try {
      while (state.queue.length && gen === state.generation && !state.paused) {
        const batch = [];
        const batchSegs = [];
        let chars = 0;
        while (state.queue.length) {
          const seg = state.queue[0];
          const segChars = seg.nodes.reduce((s, n) => s + n.nodeValue.length, 0);
          if (batch.length && (batch.length + seg.nodes.length > MAX_BATCH_ITEMS || chars + segChars > MAX_BATCH_CHARS)) {
            break;
          }
          state.queue.shift();
          seg.done = true;
          batchSegs.push(seg);
          batch.push(...seg.nodes);
          chars += segChars;
        }
        if (!batch.length) break;
        try {
          const missing = new Set(await processNodeBatch(batch, gen));
          if (gen !== state.generation) break;
          state.consecutiveFailures = 0;
          if (missing.size) {
            // Only the nodes that came back empty — the rest of the segment
            // was already rewritten in place and mustn't be sent again.
            const err = partialResultError();
            for (const seg of batchSegs) {
              const failedNodes = seg.nodes.filter((n) => missing.has(n));
              if (failedNodes.length) markNodesFailed(failedNodes, err);
            }
          }
        } catch (err) {
          if (gen !== state.generation) break;
          for (const seg of batchSegs) markFailed(seg, err);
          state.consecutiveFailures += 1;
          if (err?.retryable === false || state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            state.paused = true;
          }
        }
      }
      if (gen === state.generation) {
        if (state.failedSegments.size) showFailure();
        else showStatus('Rewritten', 1200);
      }
    } finally {
      state.draining = false;
      state.busy = false;
    }
  }

  function startPage() {
    if (state.active) return;
    state.generation += 1;
    const gen = state.generation;
    state.active = true;
    state.busy = false;
    notifyState();
    showStatus('Rewrite mode on — processing visible content…');
    scanAndObserve(gen);
    startNavWatcher(gen);
  }

  // --- Immediate path for an explicit user selection ----------------------

  async function processSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const gen = state.generation;
    state.busy = true;
    showStatus('Rewriting…');
    try {
      const nodes = collectTextNodes(document.body).filter((n) => range.intersectsNode(n));
      if (!nodes.length) return;
      const chunks = chunkNodes(nodes, MAX_BATCH_CHARS, MAX_BATCH_ITEMS);
      // A failed chunk no longer aborts the rest: it's marked failed (and
      // retryable like any scroll-pipeline block) and the next one goes on —
      // unless the error says retrying can't help, in which case the
      // remaining chunks are marked failed without sending doomed requests.
      let fatalErr = null;
      let anyFailed = false;
      for (const batch of chunks) {
        if (fatalErr) {
          markNodesFailed(batch, fatalErr);
          continue;
        }
        try {
          const missing = await processNodeBatch(batch, gen);
          if (gen !== state.generation) return;
          if (missing.length) {
            markNodesFailed(missing, partialResultError());
            anyFailed = true;
          }
        } catch (err) {
          if (gen !== state.generation) return;
          markNodesFailed(batch, err);
          anyFailed = true;
          if (err?.retryable === false) fatalErr = err;
        }
      }
      // Active even if some parts failed — the page now has rewritten text
      // and/or failure outlines that only restore() clears.
      if (!state.active) {
        state.active = true;
        notifyState();
      }
      if (anyFailed) showFailure();
      else showStatus('Rewritten', 1500);
    } finally {
      state.busy = false;
    }
  }

  // --- Alt+select "explain this" ------------------------------------------
  //
  // Independent of B1 mode: holding Alt while selecting a word or sentence
  // anywhere on the page asks the AI for a short gloss and appends it right
  // after the selection, using the same gloss rules as the B1 rewrite. This
  // necessarily inserts new content (the explanation has to go somewhere) —
  // expected here since the reader explicitly asked for an annotation, same
  // as the in-line <ai-gloss> case in applyRewrite().

  function getExplainContext(range) {
    const container = range.commonAncestorContainer;
    const el = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    const block = el
      ? el.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, figcaption') || el
      : null;
    const text = (block || document.body).textContent || '';
    return text.slice(0, 400);
  }

  // Inserts the gloss element right after the selection — either a "(……)"
  // loading placeholder or, when called with a final explanation already in
  // hand, the finished gloss. Returns the inserted element so the caller can
  // update or remove it later.
  function insertGlossNode(range, text) {
    const insertionPoint = range.cloneRange();
    insertionPoint.collapse(false); // end of the original selection

    // If the insertion point lands in the middle of a text node that's
    // already tracked in originalMap (i.e. B1 already rewrote it), inserting
    // here will make the browser split that node into a head (truncated,
    // same node object) and a brand new tail text node right after our
    // gloss. originalMap still holds the FULL original string for the head
    // node — if we let restore() just set that back onto the head, the
    // tail's (rewritten) text is untouched and ends up duplicated after it.
    // So: track the tail node here and have restore() remove it outright
    // instead of trying to revert it — the head's restore already covers
    // that whole original sentence.
    const container = insertionPoint.startContainer;
    const offset = insertionPoint.startOffset;
    const willSplitTrackedNode =
      container.nodeType === Node.TEXT_NODE &&
      offset > 0 &&
      offset < container.nodeValue.length &&
      state.originalMap.has(container);

    const gloss = document.createElement('span');
    gloss.className = 'ai-reader-gloss ai-reader-ignore';
    gloss.textContent = ` (${text})`;
    insertionPoint.insertNode(gloss);
    state.glossElements.add(gloss);

    if (willSplitTrackedNode) {
      const tailNode = gloss.nextSibling;
      if (tailNode && tailNode.nodeType === Node.TEXT_NODE) {
        state.glossTailNodes.add(tailNode);
      }
    }
    return gloss;
  }

  function removeGloss(gloss) {
    state.glossElements.delete(gloss);
    gloss.remove();
  }

  async function explainRange(range, text) {
    if (text.length > EXPLAIN_MAX_CHARS) {
      showStatus('Selection is too long — choose a single word or sentence', 2500, true);
      return;
    }
    // "ethnicity" -> "ethnicity(……)" while the request is in flight, so the
    // loading state sits right next to the word it's about instead of
    // outlining the whole surrounding paragraph.
    let gloss;
    try {
      gloss = insertGlossNode(range, '……');
      gloss.classList.add('ai-reader-gloss--loading');
    } catch (err) {
      showStatus("Couldn't insert an explanation here: " + (err?.message || err), 3000, true);
      return;
    }
    requestExplanation(gloss, range, text);
  }

  // On failure the placeholder stays put as a clickable "(failed · retry)"
  // instead of vanishing, so retrying doesn't mean re-selecting the text.
  async function requestExplanation(gloss, range, text) {
    gloss.textContent = ' (……)';
    gloss.classList.remove('ai-reader-gloss--failed');
    gloss.classList.add('ai-reader-gloss--loading');
    gloss.removeAttribute('title');
    gloss.onclick = null;
    showStatus('Generating explanation…');
    try {
      const context = getExplainContext(range);
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: 'EXPLAIN_TEXT', text, context });
      } catch (err) {
        throw messagingError(err);
      }
      if (!res?.ok) throw responseError(res, 'Explanation request failed');
      const explanation = (res.explanation || '').trim();
      if (!explanation) {
        removeGloss(gloss);
        showStatus("Couldn't generate an explanation for the selection", 2000, true);
        return;
      }
      gloss.textContent = ` (${explanation})`;
      gloss.classList.remove('ai-reader-gloss--loading');
      if (!state.active) {
        state.active = true;
        notifyState();
      }
      showStatus('Explanation added', 1200);
    } catch (err) {
      gloss.textContent = ' (failed · retry)';
      gloss.classList.remove('ai-reader-gloss--loading');
      gloss.classList.add('ai-reader-gloss--failed');
      gloss.title = String(err?.message || err);
      gloss.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        requestExplanation(gloss, range, text);
      };
      // The failed placeholder stays on the page, so mark it active the same
      // as a successful gloss would — otherwise the popup has no way to
      // restore() it away.
      if (!state.active) {
        state.active = true;
        notifyState();
      }
      showStatus('Explanation failed · ' + failureReason(err), 3000, true);
    }
  }

  document.addEventListener('mouseup', (event) => {
    if (!event.altKey) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    explainRange(sel.getRangeAt(0).cloneRange(), text);
  });

  function stopObserving() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.elToSegments = null;
    state.queue = [];
  }

  function restore() {
    state.generation += 1; // invalidate any in-flight batch so late results are dropped
    stopObserving();
    stopNavWatcher();
    state.trackedNodes = new WeakSet();
    for (const [node, original] of state.originalMap.entries()) {
      const wrapper = state.rewriteWrappers.get(node);
      if (wrapper) {
        // node itself was detached by applyRewrite()'s replaceWith — put a
        // fresh plain text node with the original text where the wrapper is,
        // instead of writing nodeValue onto the now-disconnected node.
        wrapper.replaceWith(document.createTextNode(original));
      } else {
        node.nodeValue = original;
      }
    }
    state.originalMap.clear();
    state.rewriteWrappers.clear();
    for (const tailNode of state.glossTailNodes) {
      tailNode.remove();
    }
    state.glossTailNodes.clear();
    for (const gloss of state.glossElements) {
      gloss.remove();
    }
    state.glossElements.clear();
    for (const seg of state.failedSegments) seg.el.classList.remove('ai-reader-failed');
    state.failedSegments.clear();
    state.paused = false;
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.active = false;
    state.busy = false;
    notifyState();
    showStatus('Original text restored', 1200);
  }

  function notifyState() {
    chrome.runtime.sendMessage({ type: 'STATE_CHANGED', active: state.active }).catch(() => {});
  }

  let statusEl;
  let statusTimer;
  // `action` ({ label, onClick }) adds a button plus a close ×; such a toast
  // stays up (pass no timeout) until acted on, dismissed, or replaced.
  function showStatus(text, timeout, isError, action) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'ai-reader-status ai-reader-ignore';
      document.documentElement.appendChild(statusEl);
    }
    statusEl.textContent = text;
    if (action) {
      statusEl.append(
        statusButton(action.label, 'ai-reader-status__action', action.onClick),
        statusButton('×', 'ai-reader-status__close', () => statusEl.classList.remove('ai-reader-status--show'), 'Dismiss')
      );
    }
    statusEl.classList.toggle('ai-reader-status--error', !!isError);
    statusEl.classList.add('ai-reader-status--show');
    clearTimeout(statusTimer);
    if (timeout) {
      statusTimer = setTimeout(() => statusEl.classList.remove('ai-reader-status--show'), timeout);
    }
  }

  function statusButton(label, className, onClick, ariaLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'START_PROCESS') {
      if (message.mode === 'selection') {
        processSelection()
          .then(() => sendResponse({ ok: true, active: state.active }))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;
      }
      startPage();
      sendResponse({ ok: true, active: state.active });
      return false;
    }
    if (message?.type === 'RESTORE') {
      restore();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'PING') {
      sendResponse({ ok: true, active: state.active, busy: state.busy, failed: failedBlockCount() });
      return false;
    }
    if (message?.type === 'RETRY_FAILED') {
      retryAllFailed();
      sendResponse({ ok: true });
      return false;
    }
  });
})();
