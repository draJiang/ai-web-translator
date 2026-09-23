const DEFAULTS = {
  provider: '', // 'openai' | 'anthropic' | 'ollama' | 'custom'
  apiKey: '',
  model: '',
  baseUrl: '',
  rewritePrompt: '', // empty means use the built-in B1_SYSTEM_PROMPT (lib/prompts.js)
};

export async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
