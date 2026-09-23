const DEFAULTS = {
  provider: '', // 'openai' | 'anthropic' | 'ollama' | 'custom'
  apiKey: '',
  model: '',
  baseUrl: '',
};

export async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
