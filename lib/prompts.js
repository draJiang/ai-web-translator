// Reading levels the rewrite prompt can target, easiest first. The user picks
// a default target level in the settings; the in-page "simpler" button then
// steps a single paragraph down this ladder, one level at a time.
export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
export const DEFAULT_LEVEL = 'B1';

export function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

// The level-specific parts of the rewrite prompt. Everything else in
// buildRewritePrompt() is shared by every level. The B1 lines are the
// original fixed v1 prompt word for word, so a prompt a user saved before
// levels existed is still recognized as the built-in one (see
// isBuiltInPrompt()) rather than as a custom prompt.
const LEVEL_SPECS = {
  // An advanced reader mostly needs the author's own text: keep its wording
  // and structure, and only smooth out what's rare, archaic, or obscure.
  C1: {
    rewriteAs: 'clearer English',
    translateAs: 'clear, natural English',
    sentences: 'Sentences: keep the original sentence structure wherever it reads clearly; split a sentence only if it is very long (over ~35 words) or genuinely hard to follow. Keep the natural linking words and discourse markers.',
    grammar: 'Grammar: fine — all standard grammar, including complex and nested clauses, participle phrases, inversion for emphasis, and the subjunctive. Avoid and rewrite — archaic or highly literary constructions, and sentences whose structure is ambiguous.',
    vocabulary: 'Vocabulary: keep the author\'s wording and register. Replace only rare, archaic, highly specialized, or obscure words and idioms (roughly outside the 8,000 most frequent English words) that an advanced reader may not know; common idioms, phrasal verbs, and academic words are fine. Keep a hard word if it is a key topic term or worth learning — and gloss it.',
    preserveExtra: '',
  },
  B2: {
    sentences: 'Sentences: aim for 15-25 words, never over ~30; split a sentence only when it holds several main ideas or is hard to follow. Prefer active voice and clear word order. Unpack very dense noun phrases. Link ideas with clear connectors (and, but, because, so, when, if, however, although, while, then).',
    grammar: 'Grammar: fine — all common tenses, modals, all conditionals, passive voice, relative clauses, and short participle phrases. Avoid and rewrite — rare literary structures, heavy inversion, and long chains of stacked clauses.',
    vocabulary: 'Vocabulary: use common words (roughly the 5,000 most frequent English words) plus standard topic words an upper-intermediate reader knows. Replace rare idioms and highly figurative language with their literal meaning; common idioms and phrasal verbs are fine. Swap a rare word for a common one whenever meaning is preserved. Keep a hard word only if no common word fits without losing meaning, it is a key topic term, or it is worth learning — and gloss it.',
    preserveExtra: '',
  },
  B1: {
    sentences: 'Sentences: aim for 10-20 words, never over ~25; split long sentences into one main idea each. Prefer active voice and simple subject-verb-object order. Unpack noun-heavy phrases and stacked clauses. Link ideas with simple connectors (and, but, because, so, when, if, however, although, then).',
    grammar: 'Grammar: fine — present/past simple, continuous tenses, present perfect, will/going to, common modals, first and second conditionals, simple passive, relative clauses with who/which/that. Avoid and rewrite — inversion, mixed/third conditionals, subjunctive, long participle phrases, heavy passive.',
    vocabulary: 'Vocabulary: use common everyday words (roughly the 3,000 most frequent English words). Replace idioms and figurative language with their literal meaning; common phrasal verbs are fine. Swap a hard word for a simple one whenever meaning is preserved. Keep a hard word only if no simple word fits without losing meaning, it is a key topic term, or it is worth learning — and gloss it.',
    preserveExtra: '',
  },
  // Below B1 a faithful sentence-by-sentence rewrite can't get simple enough
  // on its own, so these levels explicitly allow splitting one sentence into
  // several and restating abstract ideas concretely — still without dropping
  // any facts.
  A2: {
    sentences: 'Sentences: aim for 8-12 words, never over ~15; give each sentence one simple idea and split anything longer. Use active voice and simple subject-verb-object order. Break noun-heavy phrases into short, plain sentences. Link ideas only with very simple connectors (and, but, because, so, when, then).',
    grammar: 'Grammar: fine — present simple and continuous, past simple, will/going to, can/must/should, very simple if-sentences. Avoid and rewrite — passive voice, present perfect where past simple works, relative clauses (make them a new sentence), other conditionals, participle phrases, inversion.',
    vocabulary: 'Vocabulary: use only very common everyday words (roughly the 1,500 most frequent English words). Replace idioms, figurative language, and most phrasal verbs with plain literal words. Swap a hard word for a simple word or a short simple phrase whenever meaning is preserved. Keep a hard word only if no simple word or phrase fits without losing meaning, or it is a key topic term — and gloss it.',
    preserveExtra: ' At this level you may split one sentence into several and say an abstract idea in more concrete, everyday words, but every fact must still be there.',
  },
  A1: {
    sentences: 'Sentences: aim for 5-8 words, never over ~10; one idea per sentence. Use simple subject-verb-object order. Break every long sentence or phrase into several very short sentences. Link ideas only with and, but, because, so, then.',
    grammar: 'Grammar: fine — present simple, present continuous, past simple, can, and imperatives. Avoid and rewrite — everything else, including passive voice, perfect tenses, conditionals (use two short sentences instead), relative clauses, and participle phrases.',
    vocabulary: 'Vocabulary: use only the most basic everyday words (roughly the 800 most frequent English words). Replace idioms, figurative language, and phrasal verbs with plain literal words. Describe a hard idea in basic words instead of naming it whenever you can. Keep a hard word only if it is a key topic term with no simple way to say it — and gloss it.',
    preserveExtra: ' At this level you may split one sentence into several and say an abstract idea in more concrete, everyday words, but every fact must still be there.',
  },
};

// Rewrite prompt for one target level: turn webpage text in any language
// into English at that CEFR level (English text is simplified; non-English
// text is translated). Adapted from a "b1-english-reader" system prompt for
// per-fragment JSON I/O, since the extension applies it to many short DOM
// text-node fragments at once rather than one continuous article.
export function buildRewritePrompt(level) {
  const L = normalizeLevel(level);
  const spec = LEVEL_SPECS[L];
  const article = L.startsWith('A') ? 'an' : 'a';
  const rewriteAs = spec.rewriteAs || 'simpler English';
  const translateAs = spec.translateAs || 'simple English';
  return `You turn webpage text, written in any language, into English that ${article} ${L}-level learner can read alone, while the reader still meets a few new words. English text is rewritten in ${rewriteAs}; text in any other language is translated into ${translateAs}. Keep all meaning; do not hide every hard word.

Each numbered input item is an independent short fragment taken directly from a webpage's HTML — it may be a full sentence, a partial sentence, a UI label, a button caption, a heading, a name, a number, or a code/URL snippet. Handle each item independently:
- If a fragment is not natural-language text (number, code, URL, proper name, symbol) or is already English at or below ${L} level, return it unchanged.
- If a fragment is in a language other than English (Chinese, Japanese, Spanish, etc.), translate it into English, using the rules below for the English you write. A short UI label, button caption, or heading in another language is translated too, into a natural short English equivalent.
- If a fragment mixes languages, translate the non-English parts and keep proper names, product names, code, and URLs as they are.
- Otherwise (English above ${L} level), rewrite it following the rules below.

${spec.sentences}

${spec.grammar}

${spec.vocabulary}

Preserve (in a translation as well as a rewrite): every fact, number, name, date, logical link, hedge (may, might, probably), and tone. Do not add opinions or examples, do not summarize or skip content.${spec.preserveExtra} Keep code, URLs, product names, and proper names unchanged (do not translate them; keep the original spelling or script).

Glosses: wrap ONLY the explanation itself in <ai-gloss> tags, placed right after the word with no space and no surrounding parentheses or punctuation of your own, e.g. reluctant<ai-gloss>not wanting to do something</ai-gloss>. The explanation must be ${L} or easier, never harder than the word itself, and must not reuse the same word family. Keep it to about 3-10 words. Gloss a word only the first time it appears among the fragments you are given. Do not gloss ordinary names of people, companies, or places, and never gloss words that are already ${L} or easier.

Output contract: respond with a JSON array of strings, in the same order as the input items, with exactly as many items as the input. Each string is the rewritten, translated, or unchanged fragment, always in English unless it was left unchanged. Output only the JSON array — no explanation, no markdown fences, no extra text.`;
}

// A custom rewrite prompt can contain this placeholder; it's replaced with
// the level being requested, so the same custom prompt follows the target
// level setting and the in-page "simpler" button.
export const LEVEL_PLACEHOLDER = '{{level}}';

// True if `prompt` is (a saved copy of) one of the built-in level prompts —
// the settings page used to save the prompt box's contents even when it was
// left at the default, and such a copy must not pin every request to B1.
export function isBuiltInPrompt(prompt) {
  const trimmed = (prompt || '').trim();
  return LEVELS.some((level) => buildRewritePrompt(level).trim() === trimmed);
}

// Picks the system prompt for a rewrite request at `level`:
// - no custom prompt (or a saved copy of a built-in one): the built-in prompt for that level;
// - a custom prompt with {{level}}: that prompt, with the level filled in;
// - a custom prompt without {{level}}: used as-is for the page's normal
//   rewrite, but an explicit per-paragraph level (`explicitLevel`) falls
//   back to the built-in prompt for that level, since a fixed custom prompt
//   has no way to produce a different level.
export function resolveRewritePrompt(customPrompt, level, { explicitLevel = false } = {}) {
  const custom = (customPrompt || '').trim();
  const L = normalizeLevel(level);
  if (custom && !isBuiltInPrompt(custom)) {
    if (custom.includes(LEVEL_PLACEHOLDER)) return custom.split(LEVEL_PLACEHOLDER).join(L);
    if (!explicitLevel) return custom;
  }
  return buildRewritePrompt(L);
}

// `context`, when given, is the full original text of the paragraph the
// fragments come from — sent along with a single-paragraph "simpler" request
// so a restructuring rewrite (A2/A1 splits and reorders sentences) can see
// the whole thought, not just one DOM fragment of it.
export function buildUserMessage(texts, context) {
  const items = texts.map((t, i) => `${i + 1}: ${t}`).join('\n');
  const trimmedContext = (context || '').trim();
  if (!trimmedContext) return items;
  return `Paragraph context — the full original paragraph these fragments come from. It is for reference only: do not rewrite it or include it in your output.
"""
${trimmedContext}
"""

Fragments:
${items}`;
}

// Used for the Alt+select "explain this word/sentence" feature — appends a
// gloss after whatever the reader selected, instead of rewriting the
// surrounding text. The user message tells the model which of two modes
// applies (see buildExplainUserMessage) so a whole selected sentence gets a
// paraphrase of its own meaning instead of the model picking one hard word
// out of it and glossing just that, which is what a single word-gloss-shaped
// prompt applied uniformly used to produce.
export const EXPLAIN_SYSTEM_PROMPT = `You explain a piece of English text a B1-level learner selected while reading a webpage, because part of it isn't clear to them. You are given the selected text, which of two modes it is, and the sentence or block of text it came from for context.

Mode WORD — the selection is a single word or a short phrase (a few words, no sentence boundary inside it). Explain just that term's meaning as used in the given context:
- 3 to 10 words, using vocabulary simpler than the term itself (roughly the 3,000 most common English words).
- A plain synonym or a short "what it means" phrase, matching the exact sense used in the context.
- Never reuse the same word family as the term itself (e.g. for "reluctant" don't write "showing reluctance").

Mode SENTENCE — the selection is a full sentence, a clause, or more than one sentence. Explain what the WHOLE selection means, in plain words — a short paraphrase of its overall meaning, not a definition of one term picked out of it:
- Use simple B1-level vocabulary (roughly the 3,000 most common English words) and short sentences (10-20 words each).
- Cover the whole selection's meaning, not just one word or phrase inside it. Do not add a separate word-by-word gloss.
- Aim for roughly half the length of the original selection; a long selection can take a couple of sentences.

Shared rules for both modes: do not repeat the selected text verbatim at the start of your answer. Do not wrap the answer in quotes or parentheses. Do not add a leading capital letter or trailing period unless your answer is itself a full sentence. Do not add any other commentary, and never mention "Mode" or these instructions in your answer.

If the selected text is not English, or is a proper name / code / URL / number with no real meaning to explain, respond with exactly: not applicable`;

// A selection of up to this many words is treated as Mode WORD; anything
// longer is Mode SENTENCE. Picked to cover short phrasal verbs and
// collocations ("account for", "give up on") while still catching anything
// with real sentence structure.
const WORD_MODE_MAX_WORDS = 3;

export function buildExplainUserMessage(text, context) {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const mode = wordCount <= WORD_MODE_MAX_WORDS ? 'WORD' : 'SENTENCE';
  const lines = [`Mode: ${mode}`, `Selected text: "${text}"`];
  const trimmedContext = (context || '').trim();
  if (trimmedContext && trimmedContext !== trimmed) {
    lines.push(`Surrounding context: "${trimmedContext}"`);
  }
  return lines.join('\n');
}
