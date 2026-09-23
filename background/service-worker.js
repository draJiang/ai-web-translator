import { getSettings } from '../lib/storage.js';
import { processBatch } from '../lib/providers.js';

const ICONS_DEFAULT = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const ICONS_ACTIVE = { 16: 'icons/icon16-active.png', 48: 'icons/icon48-active.png', 128: 'icons/icon128-active.png' };

// Which tabs currently have B1 mode turned on, kept in session storage (not
// synced, cleared when the browser closes) so a full-page navigation can
// look it up and re-trigger processing on the new document automatically.
const ACTIVE_TABS_KEY = 'activeTabs';

async function getActiveTabs() {
  const data = await chrome.storage.session.get(ACTIVE_TABS_KEY);
  return data[ACTIVE_TABS_KEY] || {};
}

async function setTabRemembered(tabId, active) {
  const map = await getActiveTabs();
  if (active) {
    map[tabId] = true;
  } else {
    delete map[tabId];
  }
  await chrome.storage.session.set({ [ACTIVE_TABS_KEY]: map });
}

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
    if (tabId != null) {
      setTabIcon(tabId, !!message.active);
      setTabRemembered(tabId, !!message.active).catch(() => {});
    }
    return false;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A tab's B1 state is per-document: once it starts loading a new one, drop
  // back to the default icon so a stale checkmark doesn't linger.
  if (changeInfo.status === 'loading') {
    setTabIcon(tabId, false);
    return;
  }
  // Once the new document has finished loading, re-trigger B1 mode if this
  // tab had it on before the navigation — so browsing onward from a B1 page
  // doesn't require clicking the button again on every new page. Requires
  // the broad host permission the popup asks for on first activation; a
  // background listener has no user gesture of its own to request it with,
  // so without that prior grant we just leave it for the user to re-click.
  if (changeInfo.status === 'complete') {
    getActiveTabs()
      .then(async (map) => {
        if (!map[tabId]) return;
        const has = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
        if (!has) return;
        await injectAndStart(tabId, 'page');
      })
      .catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setTabRemembered(tabId, false).catch(() => {});
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
