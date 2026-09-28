const DEFAULTS = {
  provider: '', // 'openai' | 'anthropic' | 'ollama' | 'custom'
  apiKey: '',
  model: '',
  baseUrl: '',
  rewritePrompt: '', // empty means use the built-in prompt for the target level (buildRewritePrompt() in lib/prompts.js)
  targetLevel: 'B1', // default reading level for the page rewrite — one of LEVELS in lib/prompts.js
};

export async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
