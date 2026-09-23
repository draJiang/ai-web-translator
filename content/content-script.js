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

  const state = {
    processed: false,
    busy: false,
    originalMap: new Map(), // text node -> original text
  };

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return !!style && style.display !== 'none' && style.visibility !== 'hidden';
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

  function chunk(nodes, maxChars = 1800, maxItems = 40) {
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

  async function processNodes(nodes) {
    const batches = chunk(nodes);
    for (const batch of batches) {
      const texts = batch.map((n) => n.nodeValue);
      const res = await chrome.runtime.sendMessage({ type: 'PROCESS_BATCH', texts });
      if (!res?.ok) throw new Error(res?.error || '处理请求失败');
      res.results.forEach((rewritten, i) => {
        const node = batch[i];
        // Node identity is stable across this call since we never touch the
        // DOM structure — only nodeValue — so batch[i] still points at the
        // same text node the AI's i-th result corresponds to.
        if (!state.originalMap.has(node)) state.originalMap.set(node, node.nodeValue);
        if (typeof rewritten === 'string' && rewritten.length) node.nodeValue = rewritten;
      });
    }
  }

  async function processPage() {
    if (state.busy) return;
    state.busy = true;
    showStatus('正在转为 B1 英文…');
    try {
      const nodes = collectTextNodes(document.body);
      await processNodes(nodes);
      state.processed = true;
      showStatus('已转为 B1 英文', 1500);
    } catch (err) {
      showStatus('处理失败：' + (err?.message || err), 4000, true);
      throw err;
    } finally {
      state.busy = false;
    }
  }

  async function processSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (state.busy) return;
    state.busy = true;
    showStatus('正在转为 B1 英文…');
    try {
      const nodes = collectTextNodes(document.body).filter((n) => range.intersectsNode(n));
      await processNodes(nodes);
      state.processed = state.processed || nodes.length > 0;
      showStatus('已转为 B1 英文', 1500);
    } catch (err) {
      showStatus('处理失败：' + (err?.message || err), 4000, true);
      throw err;
    } finally {
      state.busy = false;
    }
  }

  function restore() {
    for (const [node, original] of state.originalMap.entries()) {
      node.nodeValue = original;
    }
    state.originalMap.clear();
    state.processed = false;
    showStatus('已还原原文', 1200);
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
      const job = message.mode === 'selection' ? processSelection() : processPage();
      Promise.resolve(job)
        .then(() => sendResponse({ ok: true, processed: state.processed }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (message?.type === 'RESTORE') {
      restore();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'PING') {
      sendResponse({ ok: true, processed: state.processed, busy: state.busy });
      return true;
    }
  });
})();
