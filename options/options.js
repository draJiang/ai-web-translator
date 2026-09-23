import { getSettings, saveSettings } from '../lib/storage.js';
import { processBatch } from '../lib/providers.js';

const form = document.getElementById('settingsForm');
const providerEl = document.getElementById('provider');
const apiKeyEl = document.getElementById('apiKey');
const baseUrlEl = document.getElementById('baseUrl');
const modelEl = document.getElementById('model');
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
  updateFieldVisibility();
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
      showResult('未授权访问该地址，已取消保存。', true);
      return;
    }
  }

  await saveSettings({
    provider,
    apiKey: apiKeyEl.value.trim(),
    baseUrl,
    model: modelEl.value.trim(),
  });
  showResult('已保存', false);
}

async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    const url = new URL(baseUrl);
    origin = `${url.protocol}//${url.host}/*`;
  } catch {
    showResult('Base URL 格式不正确', true);
    return false;
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

testBtn.addEventListener('click', async () => {
  showResult('测试中…', false);
  try {
    const provider = providerEl.value;
    const baseUrl = baseUrlEl.value.trim();
    if ((provider === 'custom' || provider === 'ollama') && baseUrl) {
      const granted = await ensureHostPermission(baseUrl);
      if (!granted) throw new Error('未授权访问该地址');
    }
    const settings = {
      provider,
      apiKey: apiKeyEl.value.trim(),
      baseUrl,
      model: modelEl.value.trim(),
    };
    const [rewritten] = await processBatch(settings, [
      'The implementation of the new policy was met with considerable reluctance from employees.',
    ]);
    showResult(`连接成功，示例改写结果：${rewritten}`, false);
  } catch (err) {
    showResult('测试失败：' + (err?.message || err), true);
  }
});

function showResult(text, isError) {
  resultEl.textContent = text;
  resultEl.className = 'result' + (isError ? ' error' : text === '已保存' || text.startsWith('连接成功') ? ' success' : '');
}
