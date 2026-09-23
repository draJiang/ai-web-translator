import { getSettings } from '../lib/storage.js';

const processBtn = document.getElementById('processBtn');
const statusEl = document.getElementById('status');
const warningEl = document.getElementById('warning');
document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

let currentTabId = null;
let isProcessed = false;

init();

async function init() {
  const settings = await getSettings();
  if (!settings.provider) {
    warningEl.textContent = '请先在“AI 服务商设置”中配置服务商和 API Key';
    warningEl.classList.remove('hidden');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
    processBtn.disabled = true;
    setStatus('当前页面不支持处理');
    return;
  }
  currentTabId = tab.id;

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (res?.ok) {
      isProcessed = !!res.processed;
      updateButton();
    }
  } catch {
    // content script not injected into this tab yet — that's fine, first
    // click will inject it.
  }
}

processBtn.addEventListener('click', async () => {
  if (!currentTabId) return;
  processBtn.disabled = true;
  try {
    if (isProcessed) {
      await chrome.tabs.sendMessage(currentTabId, { type: 'RESTORE' });
      isProcessed = false;
      setStatus('已还原原文');
    } else {
      setStatus('正在转为 B1 英文…');
      await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content/content-script.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: currentTabId }, files: ['content/content-style.css'] });
      const res = await chrome.tabs.sendMessage(currentTabId, { type: 'START_PROCESS', mode: 'page' });
      if (!res?.ok) throw new Error(res?.error || '处理失败');
      isProcessed = true;
      setStatus('已转为 B1 英文');
    }
  } catch (err) {
    setStatus('出错：' + (err?.message || err));
  } finally {
    processBtn.disabled = false;
    updateButton();
  }
});

function updateButton() {
  processBtn.textContent = isProcessed ? '还原原文' : '转为 B1 英文';
}

function setStatus(text) {
  statusEl.textContent = text;
}
