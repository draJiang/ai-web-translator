import { B1_SYSTEM_PROMPT, buildUserMessage, EXPLAIN_SYSTEM_PROMPT, buildExplainUserMessage } from './prompts.js';

export async function processBatch(settings, texts) {
  const raw = await chat(settings, B1_SYSTEM_PROMPT, buildUserMessage(texts));
  return parseJsonArray(raw, texts.length);
}

// Explains a single selected word/phrase in context; returns null when the
// model says there's nothing meaningful to explain (see prompts.js).
export async function explainSelection(settings, text, context) {
  const raw = await chat(settings, EXPLAIN_SYSTEM_PROMPT, buildExplainUserMessage(text, context));
  const cleaned = cleanExplanation(raw);
  if (!cleaned || cleaned.toLowerCase() === 'not applicable') return null;
  return cleaned;
}

// --- Transport: one function per provider, same (system, user) -> content shape ---

function chat(settings, systemPrompt, userMessage) {
  switch (settings.provider) {
    case 'openai':
      return chatOpenAI(settings, systemPrompt, userMessage);
    case 'anthropic':
      return chatAnthropic(settings, systemPrompt, userMessage);
    case 'ollama':
      return chatOllama(settings, systemPrompt, userMessage);
    case 'custom':
      return chatOpenAICompatible(settings, systemPrompt, userMessage);
    default:
      throw new Error('No AI provider configured — set one up in the extension options first');
  }
}

async function chatOpenAI(settings, systemPrompt, userMessage) {
  const { apiKey, model } = settings;
  if (!apiKey) throw new Error('OpenAI API key not configured');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI request failed (${resp.status}): ${await safeText(resp)}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned an empty response');
  return content;
}

async function chatAnthropic(settings, systemPrompt, userMessage) {
  const { apiKey, model } = settings;
  if (!apiKey) throw new Error('Anthropic API key not configured');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
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
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic request failed (${resp.status}): ${await safeText(resp)}`);
  const data = await resp.json();
  const content = (data?.content || []).map((b) => b.text || '').join('');
  if (!content) throw new Error('Anthropic returned an empty response');
  return content;
}

async function chatOllama(settings, systemPrompt, userMessage) {
  const { apiKey, model, baseUrl } = settings;
  const host = (baseUrl || 'https://ollama.com').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetch(`${host}/api/chat`, {
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
  if (!resp.ok) throw new Error(`Ollama request failed (${resp.status}): ${await safeText(resp)}`);
  const data = await resp.json();
  const content = data?.message?.content;
  if (!content) throw new Error('Ollama returned an empty response');
  return content;
}

async function chatOpenAICompatible(settings, systemPrompt, userMessage) {
  const { apiKey, model, baseUrl } = settings;
  if (!baseUrl) throw new Error('Please fill in the Base URL for the custom API');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`Custom API request failed (${resp.status}): ${await safeText(resp)}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Custom API returned an empty response');
  return content;
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
    if (start !== -1 && end !== -1 && end > start) {
      arr = JSON.parse(text.slice(start, end + 1));
    } else {
      throw new Error("Couldn't parse the AI response as a JSON array: " + text.slice(0, 200));
    }
  }
  if (!Array.isArray(arr)) throw new Error('AI response is not an array');
  if (arr.length !== expectedLen) {
    throw new Error(`AI returned ${arr.length} item(s), expected ${expectedLen}`);
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
