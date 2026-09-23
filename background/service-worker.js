import { getSettings } from '../lib/storage.js';
import { processBatch, explainSelection } from '../lib/providers.js';

// chrome.action.setIcon's `path` option must be resolved via chrome.runtime.getURL()
// here — plain relative strings like 'icons/icon16.png' resolve against this script's
// own location (background/), not the extension root, so the fetch 404s and setIcon
// silently no-ops (the .catch below swallows it), leaving the icon stuck on whatever
// default_icon manifest.json declared no matter what state we pass in.
const ICONS_DEFAULT = {
  16: chrome.runtime.getURL('icons/icon16.png'),
  48: chrome.runtime.getURL('icons/icon48.png'),
  128: chrome.runtime.getURL('icons/icon128.png'),
};
const ICONS_ACTIVE = {
  16: chrome.runtime.getURL('icons/icon16-active.png'),
  48: chrome.runtime.getURL('icons/icon48-active.png'),
  128: chrome.runtime.getURL('icons/icon128-active.png'),
};

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
    title: 'Rewrite Selection',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'process-page',
    title: 'Rewrite Page',
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
  if (message?.type === 'EXPLAIN_TEXT') {
    getSettings()
      .then((settings) => explainSelection(settings, message.text, message.context))
      .then((explanation) => sendResponse({ ok: true, explanation }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
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
        const res = await injectAndStart(tabId, 'page');
        // The content script's own STATE_CHANGED message normally sets this,
        // but a real page can fire extra tabs.onUpdated 'loading' events after
        // this point (redirects, client-side route swaps right after load,
        // etc.), each of which resets the icon to default — racing that
        // message and leaving the icon stuck on default even though the page
        // did get processed. Set it here too, as the last, authoritative step
        // once we actually know the resulting state, so it always ends up
        // correct regardless of that race.
        setTabIcon(tabId, !!res?.active);
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
    const res = await injectAndStart(tab.id, mode);
    setTabIcon(tab.id, !!res?.active);
  }
});

async function injectAndStart(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content-script.js'] });
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content-style.css'] });
  return chrome.tabs.sendMessage(tabId, { type: 'START_PROCESS', mode });
}
