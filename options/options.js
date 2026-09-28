import { getSettings, saveSettings } from '../lib/storage.js';
import { processBatch } from '../lib/providers.js';
import { buildRewritePrompt, isBuiltInPrompt, normalizeLevel } from '../lib/prompts.js';

const form = document.getElementById('settingsForm');
const providerEl = document.getElementById('provider');
const apiKeyEl = document.getElementById('apiKey');
const baseUrlEl = document.getElementById('baseUrl');
const modelEl = document.getElementById('model');
const targetLevelEl = document.getElementById('targetLevel');
const rewritePromptEl = document.getElementById('rewritePrompt');
const resetPromptBtn = document.getElementById('resetPromptBtn');
const resultEl = document.getElementById('result');
const testBtn = document.getElementById('testBtn');
const baseUrlField = document.getElementById('baseUrlField');

const PROVIDER_DEFAULTS = {
  openai: { baseUrl: '', model: 'gpt-4o-mini', showBaseUrl: false },
  anthropic: { baseUrl: '', model: 'claude-haiku-4-5', showBaseUrl: false },
  ollama: { baseUrl: 'https://ollama.com', model: 'gemma4', showBaseUrl: true },
  custom: { baseUrl: '', model: 'gpt-4o-mini', showBaseUrl: true },
};

init();

async function init() {
  const settings = await getSettings();
  providerEl.value = settings.provider || 'openai';
  apiKeyEl.value = settings.apiKey || '';
  baseUrlEl.value = settings.baseUrl || '';
  modelEl.value = settings.model || '';
  targetLevelEl.value = normalizeLevel(settings.targetLevel);
  // A saved copy of a built-in prompt (older versions saved the box's
  // contents even when left at the default) is shown as the built-in prompt
  // for the selected level, not as a custom prompt frozen at B1.
  rewritePromptEl.value =
    settings.rewritePrompt && !isBuiltInPrompt(settings.rewritePrompt)
      ? settings.rewritePrompt
      : buildRewritePrompt(targetLevelEl.value);
  updateFieldVisibility();
}

resetPromptBtn.addEventListener('click', () => {
  rewritePromptEl.value = buildRewritePrompt(targetLevelEl.value);
});

// The box shows the built-in prompt for the selected level, so follow a
// level change — unless it holds a custom prompt, which is left alone.
targetLevelEl.addEventListener('change', () => {
  if (!rewritePromptEl.value.trim() || isBuiltInPrompt(rewritePromptEl.value)) {
    rewritePromptEl.value = buildRewritePrompt(targetLevelEl.value);
  }
});

// Empty means "use the built-in prompt for whatever level is requested"; a
// box left at a built-in prompt is saved that way, so the target level and
// the per-paragraph "simpler" button keep working.
function customPromptValue() {
  const value = rewritePromptEl.value.trim();
  return isBuiltInPrompt(value) ? '' : value;
}

providerEl.addEventListener('change', () => {
  const def = PROVIDER_DEFAULTS[providerEl.value];
  if (def) {
    if (!baseUrlEl.value) baseUrlEl.value = def.baseUrl;
    if (!modelEl.value) modelEl.value = def.model;
  }
  updateFieldVisibility();
});

function updateFieldVisibility() {
  const def = PROVIDER_DEFAULTS[providerEl.value] || {};
  baseUrlField.style.display = def.showBaseUrl ? '' : 'none';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await persist();
});

async function persist() {
  const provider = providerEl.value;
  const baseUrl = baseUrlEl.value.trim();

  if ((provider === 'custom' || provider === 'ollama') && baseUrl) {
    const granted = await ensureHostPermission(baseUrl);
    if (!granted) {
      showResult('Access to this address was not granted; save canceled.', true);
      return;
    }
  }

  await saveSettings({
    provider,
    apiKey: apiKeyEl.value.trim(),
    baseUrl,
    model: modelEl.value.trim(),
    rewritePrompt: customPromptValue(),
    targetLevel: targetLevelEl.value,
  });
  showResult('Saved', false);
}

async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    const url = new URL(baseUrl);
    origin = `${url.protocol}//${url.host}/*`;
  } catch {
    showResult('Invalid Base URL', true);
    return false;
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

testBtn.addEventListener('click', async () => {
  showResult('Testing…', false);
  try {
    const provider = providerEl.value;
    const baseUrl = baseUrlEl.value.trim();
    if ((provider === 'custom' || provider === 'ollama') && baseUrl) {
      const granted = await ensureHostPermission(baseUrl);
      if (!granted) throw new Error('Access to this address was not granted');
    }
    const settings = {
      provider,
      apiKey: apiKeyEl.value.trim(),
      baseUrl,
      model: modelEl.value.trim(),
      rewritePrompt: customPromptValue(),
      targetLevel: targetLevelEl.value,
    };
    const [rewritten] = await processBatch(settings, [
      'The implementation of the new policy was met with considerable reluctance from employees.',
    ]);
    showResult(`Connected. Example rewrite: ${rewritten}`, false);
  } catch (err) {
    showResult('Test failed: ' + (err?.message || err), true);
  }
});

function showResult(text, isError) {
  resultEl.textContent = text;
  resultEl.className = 'result' + (isError ? ' error' : text === 'Saved' || text.startsWith('Connected') ? ' success' : '');
}
