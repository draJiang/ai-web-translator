(function () {
  // chrome.scripting.executeScript re-runs this whole file on every injection
  // (e.g. each popup click). Guard so we don't attach duplicate listeners —
  // the first injection's closures keep working for the rest of the page's life.
  if (window.__aiReaderInjected) return;
  window.__aiReaderInjected = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'CODE', 'PRE', 'IFRAME', 'TITLE', 'SVG',
  ]);

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
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
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
          throw new Error(err?.message || 'Failed to communicate with the extension background');
        }
        if (gen !== state.generation) return; // superseded by a restore/new run — discard
        if (!res?.ok) throw new Error(res?.error || 'Processing request failed');
        res.results.forEach((rewritten, i) => {
          if (typeof rewritten === 'string' && rewritten.length) {
            state.rewriteCache.set(toFetchTexts[i], rewritten);
          }
        });
      }
      for (const node of nodes) {
        if (!state.originalMap.has(node)) state.originalMap.set(node, node.nodeValue);
        const rewritten = state.rewriteCache.get(node.nodeValue);
        if (rewritten) applyRewrite(node, rewritten);
      }
    } finally {
      for (const el of els) el.classList.remove('ai-reader-loading');
    }
  }

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
    if (state.draining) return;
    drain(gen);
  }

  async function drain(gen) {
    state.draining = true;
    state.busy = true;
    showStatus('Rewriting…');
    try {
      while (state.queue.length && gen === state.generation) {
        const batch = [];
        let chars = 0;
        while (state.queue.length) {
          const seg = state.queue[0];
          const segChars = seg.nodes.reduce((s, n) => s + n.nodeValue.length, 0);
          if (batch.length && (batch.length + seg.nodes.length > MAX_BATCH_ITEMS || chars + segChars > MAX_BATCH_CHARS)) {
            break;
          }
          state.queue.shift();
          seg.done = true;
          batch.push(...seg.nodes);
          chars += segChars;
        }
        if (!batch.length) break;
        try {
          await processNodeBatch(batch, gen);
        } catch (err) {
          showStatus('Processing failed: ' + (err?.message || err), 4000, true);
        }
      }
      if (gen === state.generation) showStatus('Rewritten', 1200);
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
      for (const batch of chunks) {
        await processNodeBatch(batch, gen);
      }
      if (!state.active) {
        state.active = true;
        notifyState();
      }
      showStatus('Rewritten', 1500);
    } catch (err) {
      showStatus('Processing failed: ' + (err?.message || err), 4000, true);
      throw err;
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
    showStatus('Generating explanation…');
    try {
      const context = getExplainContext(range);
      const res = await chrome.runtime.sendMessage({ type: 'EXPLAIN_TEXT', text, context });
      if (!res?.ok) throw new Error(res?.error || 'Explanation request failed');
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
      removeGloss(gloss);
      showStatus('Explanation failed: ' + (err?.message || err), 3000, true);
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
  function showStatus(text, timeout, isError) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.className = 'ai-reader-status ai-reader-ignore';
      document.documentElement.appendChild(statusEl);
    }
    statusEl.textContent = text;
    statusEl.classList.toggle('ai-reader-status--error', !!isError);
    statusEl.classList.add('ai-reader-status--show');
    clearTimeout(statusTimer);
    if (timeout) {
      statusTimer = setTimeout(() => statusEl.classList.remove('ai-reader-status--show'), timeout);
    }
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
      sendResponse({ ok: true, active: state.active, busy: state.busy });
      return false;
    }
  });
})();
