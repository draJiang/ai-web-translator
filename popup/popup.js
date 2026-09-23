import { getSettings } from '../lib/storage.js';

// Broad host access, requested once (and only from here — a proper
// extension page, since chrome.permissions.request needs a user-gesture
// page context, not the background service worker), so the background can
// re-inject and auto-continue rewrite mode on pages you navigate to afterwards.
const CROSS_PAGE_ORIGINS = ['http://*/*', 'https://*/*'];

const processBtn = document.getElementById('processBtn');
const statusEl = document.getElementById('status');
const warningEl = document.getElementById('warning');
document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

let currentTabId = null;
let isActive = false;

init();

async function init() {
  const settings = await getSettings();
  if (!settings.provider) {
    warningEl.textContent = 'Please configure a provider and API key in "AI Provider Settings" first';
    warningEl.classList.remove('hidden');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
    processBtn.disabled = true;
    setStatus("This page can't be processed");
    return;
  }
  currentTabId = tab.id;

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    if (res?.ok) {
      isActive = !!res.active;
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
    if (isActive) {
      await chrome.tabs.sendMessage(currentTabId, { type: 'RESTORE' });
      isActive = false;
      setStatus('Original text restored');
    } else {
      setStatus('Turning on rewrite mode…');
      await chrome.scripting.executeScript({ target: { tabId: currentTabId }, files: ['content/content-script.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: currentTabId }, files: ['content/content-style.css'] });
      const res = await chrome.tabs.sendMessage(currentTabId, { type: 'START_PROCESS', mode: 'page' });
      if (!res?.ok) throw new Error(res?.error || 'Processing failed');
      isActive = true;
      const canFollowNav = await ensureCrossPageHostPermission().catch(() => false);
      setStatus(
        canFollowNav
          ? 'On — scrolling or navigating to a new page will keep processing'
          : 'On — cross-page permission not granted; click again after navigating to a new page'
      );
    }
  } catch (err) {
    setStatus('Error: ' + (err?.message || err));
  } finally {
    processBtn.disabled = false;
    updateButton();
  }
});

async function ensureCrossPageHostPermission() {
  const has = await chrome.permissions.contains({ origins: CROSS_PAGE_ORIGINS });
  if (has) return true;
  return chrome.permissions.request({ origins: CROSS_PAGE_ORIGINS });
}

function updateButton() {
  processBtn.textContent = isActive ? 'Restore Original' : 'Rewrite';
}

function setStatus(text) {
  statusEl.textContent = text;
}
