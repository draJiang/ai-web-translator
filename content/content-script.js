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

  const state = {
    active: false, // true once the user has turned B1 mode on for this page
    busy: false, // a batch request is currently in flight
    generation: 0, // bumped on every start/restore so stale async results are dropped
    originalMap: new Map(), // text node -> original text
    trackedNodes: new WeakSet(), // nodes already scheduled at least once (processed or pending)
    observer: null,
    elToSegments: null, // Element -> segment[] awaiting that element's visibility
    queue: [], // segments that are visible/near-visible and not yet processed
    draining: false,
    navObserver: null, // MutationObserver that detects SPA-style content swaps
    navDebounceTimer: null,
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

  // Elements whose text is part of the batch currently in flight, marked
  // with a non-intrusive outline (see content-style.css) so the reader can
  // see what's loading without the original characters themselves changing
  // in any way while they're still on screen.
  function setLoading(nodes, isLoading) {
    const els = new Set(nodes.map((n) => n.parentElement).filter(Boolean));
    for (const el of els) el.classList.toggle('ai-reader-loading', isLoading);
  }

  async function processNodeBatch(nodes, gen) {
    setLoading(nodes, true);
    try {
      const texts = nodes.map((n) => n.nodeValue);
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: 'PROCESS_BATCH', texts });
      } catch (err) {
        throw new Error(err?.message || '与插件后台通信失败');
      }
      if (gen !== state.generation) return; // superseded by a restore/new run — discard
      if (!res?.ok) throw new Error(res?.error || '处理请求失败');
      res.results.forEach((rewritten, i) => {
        const node = nodes[i];
        if (!state.originalMap.has(node)) state.originalMap.set(node, node.nodeValue);
        if (typeof rewritten === 'string' && rewritten.length) node.nodeValue = rewritten;
      });
    } finally {
      setLoading(nodes, false);
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
      (n) => !state.originalMap.has(n) && !state.trackedNodes.has(n)
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
    // Our own writes only ever touch nodeValue (characterData), never
    // childList, so this never re-triggers itself.
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
    showStatus('正在转为 B1 英文…');
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
          showStatus('处理失败：' + (err?.message || err), 4000, true);
        }
      }
      if (gen === state.generation) showStatus('已更新为 B1 英文', 1200);
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
    showStatus('B1 模式已开启，正在处理可见内容…');
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
    showStatus('正在转为 B1 英文…');
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
      showStatus('已转为 B1 英文', 1500);
    } catch (err) {
      showStatus('处理失败：' + (err?.message || err), 4000, true);
      throw err;
    } finally {
      state.busy = false;
    }
  }

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
      node.nodeValue = original;
    }
    state.originalMap.clear();
    state.active = false;
    state.busy = false;
    notifyState();
    showStatus('已还原原文', 1200);
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
