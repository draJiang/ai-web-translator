import {
  resolveRewritePrompt,
  buildUserMessage,
  buildExplainPrompt,
  buildExplainUserMessage,
  PARAGRAPH_EXPLAIN_PROMPT,
  buildParagraphExplainUserMessage,
} from './prompts.js';

// A request that hangs would block the content script's serial batch queue
// forever, so every call gets a hard deadline.
const REQUEST_TIMEOUT_MS = 45000;
// Transient failures (network blips, rate limits, overloaded servers) are
// retried here, silently, before the error ever reaches the page.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;
// 529 is Anthropic's "overloaded".
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
// Rewrites normally go out at temperature 0, which makes a resend of a
// request that came back malformed come back the same way. A retry the user
// asked for samples instead, so each attempt gets a fresh answer.
const RETRY_TEMPERATURE = 0.7;

// Carries enough structure across the extension message boundary for the
// page to decide what to do next: `retryable` false means retrying won't
// help until the user changes something (bad key, missing config), so the
// page stops sending more requests instead of failing every batch the same way.
export class ProviderError extends Error {
  constructor(message, { kind, status, retryable = false, retryAfterMs } = {}) {
    super(message);
    this.kind = kind; // 'network' | 'timeout' | 'http' | 'config' | 'parse'
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// `options.level` is the reading level to rewrite to (defaults to the
// settings' target level); `options.explicitLevel` marks a per-paragraph
// level the user picked with the "simpler" button (see
// resolveRewritePrompt()); `options.context` is that paragraph's full
// original text (see buildUserMessage()); `options.retry` marks a resend of
// texts that failed before (see RETRY_TEMPERATURE).
export async function processBatch(settings, texts, options = {}) {
  const { level = settings.targetLevel, explicitLevel = false, context, retry = false } = options;
  const systemPrompt = resolveRewritePrompt(settings.rewritePrompt, level, { explicitLevel });
  const temperature = retry ? RETRY_TEMPERATURE : 0;
  try {
    const raw = await chatWithRetry(settings, systemPrompt, buildUserMessage(texts, context), temperature);
    return parseJsonArray(raw, texts.length);
  } catch (err) {
    // With temperature 0 an identical resend tends to come back just as
    // malformed, so split the batch instead: the halves that parse keep their
    // results, and only the genuinely troublesome item(s) end up as null.
    // Anything other than a parse error (network, auth…) still propagates.
    if (err?.kind !== 'parse') throw err;
    if (texts.length === 1) return [null];
    const mid = Math.ceil(texts.length / 2);
    const left = await processBatch(settings, texts.slice(0, mid), options);
    const right = await processBatch(settings, texts.slice(mid), options);
    return [...left, ...right];
  }
}

// Explains a single selected word/phrase in context; returns null when the
// model says there's nothing meaningful to explain (see prompts.js).
// `options.level` is the reading level to explain at (defaults to the
// settings' target level); `options.previous` is the explanation the reader
// found too hard (see buildExplainPrompt()).
export async function explainSelection(settings, text, context, options = {}) {
  const { level = settings.targetLevel, previous } = options;
  const raw = await chatWithRetry(settings, buildExplainPrompt(level), buildExplainUserMessage(text, context, previous));
  const cleaned = cleanExplanation(raw);
  if (!cleaned || cleaned.toLowerCase() === 'not applicable') return null;
  return cleaned;
}

// Explains a whole paragraph for the Explain button's memo card.
export async function explainParagraph(settings, text) {
  const raw = await chatWithRetry(settings, PARAGRAPH_EXPLAIN_PROMPT, buildParagraphExplainUserMessage(text));
  return (raw || '').trim();
}

async function chatWithRetry(settings, systemPrompt, userMessage, temperature = 0) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chat(settings, systemPrompt, userMessage, temperature);
    } catch (err) {
      if (!err?.retryable || attempt >= MAX_RETRIES) throw err;
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt) * (0.5 + Math.random());
      await sleep(err.retryAfterMs ?? backoff);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Transport: one function per provider, same (system, user) -> content shape ---

function chat(settings, systemPrompt, userMessage, temperature) {
  switch (settings.provider) {
    case 'openai':
      return chatOpenAI(settings, systemPrompt, userMessage, temperature);
    case 'anthropic':
      return chatAnthropic(settings, systemPrompt, userMessage, temperature);
    case 'ollama':
      // Left at Ollama's own default temperature, which already samples.
      return chatOllama(settings, systemPrompt, userMessage);
    case 'custom':
      return chatOpenAICompatible(settings, systemPrompt, userMessage, temperature);
    default:
      throw configError('No AI provider configured — set one up in the extension options first');
  }
}

async function chatOpenAI(settings, systemPrompt, userMessage, temperature) {
  const { apiKey, model } = settings;
  if (!apiKey) throw configError('OpenAI API key not configured');
  const data = await fetchJson('OpenAI', 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  return requireContent('OpenAI', data?.choices?.[0]?.message?.content);
}

async function chatAnthropic(settings, systemPrompt, userMessage, temperature) {
  const { apiKey, model } = settings;
  if (!apiKey) throw configError('Anthropic API key not configured');
  const data = await fetchJson('Anthropic', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || 'claude-haiku-4-5',
      max_tokens: 4096,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  return requireContent('Anthropic', (data?.content || []).map((b) => b.text || '').join(''));
}

async function chatOllama(settings, systemPrompt, userMessage) {
  const { apiKey, model, baseUrl } = settings;
  const host = (baseUrl || 'https://ollama.com').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = await fetchJson('Ollama', `${host}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gemma4',
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  return requireContent('Ollama', data?.message?.content);
}

async function chatOpenAICompatible(settings, systemPrompt, userMessage, temperature) {
  const { apiKey, model, baseUrl } = settings;
  if (!baseUrl) throw configError('Please fill in the Base URL for the custom API');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = await fetchJson('Custom API', `${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  return requireContent('Custom API', data?.choices?.[0]?.message?.content);
}

// fetch + status check + JSON body, all under one timeout (the body read can
// stall too, not just the headers), with every failure mapped to a
// ProviderError so chatWithRetry() knows whether it's worth another attempt.
async function fetchJson(name, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let resp;
    try {
      resp = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ProviderError(`${name} request timed out`, { kind: 'timeout', retryable: true });
      }
      throw new ProviderError(`${name} request failed: ${err?.message || err}`, { kind: 'network', retryable: true });
    }
    if (!resp.ok) {
      throw new ProviderError(`${name} request failed (${resp.status}): ${await safeText(resp)}`, {
        kind: 'http',
        status: resp.status,
        retryable: RETRYABLE_STATUSES.has(resp.status),
        retryAfterMs: parseRetryAfter(resp.headers.get('retry-after')),
      });
    }
    try {
      return await resp.json();
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ProviderError(`${name} request timed out`, { kind: 'timeout', retryable: true });
      }
      throw new ProviderError(`${name} returned a malformed response`, { kind: 'network', retryable: true });
    }
  } finally {
    clearTimeout(timer);
  }
}

function requireContent(name, content) {
  if (!content) throw new ProviderError(`${name} returned an empty response`, { kind: 'http', retryable: true });
  return content;
}

function parseError(message) {
  return new ProviderError(message, { kind: 'parse' });
}

function configError(message) {
  return new ProviderError(message, { kind: 'config', retryable: false });
}

// Retry-After is either delta-seconds or an HTTP date. Only honored up to
// the normal backoff cap, so a server asking for minutes can't leave the page
// silently stuck; past that, fall back to regular backoff and let the failure
// surface to the user if it persists.
function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return ms <= RETRY_MAX_MS ? ms : undefined;
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return '';
  }
}

// --- Response parsing -----------------------------------------------------

function parseJsonArray(raw, expectedLen) {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    try {
      if (start === -1 || end <= start) throw new Error('no array found');
      arr = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw parseError("Couldn't parse the AI response as a JSON array: " + text.slice(0, 200));
    }
  }
  if (!Array.isArray(arr)) throw parseError('AI response is not an array');
  if (arr.length !== expectedLen) {
    throw parseError(`AI returned ${arr.length} item(s), expected ${expectedLen}`);
  }
  return arr.map((x) => (typeof x === 'string' ? x : String(x)));
}

// The prompt tells the model not to wrap its answer in quotes/parens, but
// strip a stray matching pair defensively in case it does anyway.
function cleanExplanation(raw) {
  let text = (raw || '').trim();
  text = text.replace(/^[("'“‘]+/, '').replace(/[)"'”’]+$/, '');
  return text.trim();
}
