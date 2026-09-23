import { getSettings } from '../lib/storage.js';
import { processBatch } from '../lib/providers.js';

const ICONS_DEFAULT = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const ICONS_ACTIVE = { 16: 'icons/icon16-active.png', 48: 'icons/icon48-active.png', 128: 'icons/icon128-active.png' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'process-selection',
    title: '转为 B1 英文（选中内容）',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'process-page',
    title: '转为 B1 英文（整个页面）',
    contexts: ['page'],
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PROCESS_BATCH') {
    getSettings()
      .then((settings) => processBatch(settings, message.texts))
      .then((result) => sendResponse({ ok: true, results: result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the message channel open for the async response
  }
  if (message?.type === 'STATE_CHANGED') {
    const tabId = sender.tab?.id;
    if (tabId != null) setTabIcon(tabId, !!message.active);
    return false;
  }
});

// A tab's B1 state is per-page-load: once it starts loading a new document,
// drop back to the default icon so a stale checkmark doesn't linger.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') setTabIcon(tabId, false);
});

function setTabIcon(tabId, active) {
  chrome.action.setIcon({ tabId, path: active ? ICONS_ACTIVE : ICONS_DEFAULT }).catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'process-selection' || info.menuItemId === 'process-page') {
    const mode = info.menuItemId === 'process-selection' ? 'selection' : 'page';
    await injectAndStart(tab.id, mode);
  }
});

async function injectAndStart(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content-script.js'] });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content-style.css'] });
  await chrome.tabs.sendMessage(tabId, { type: 'START_PROCESS', mode });
}
