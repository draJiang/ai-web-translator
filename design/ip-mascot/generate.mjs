// Generates the six IP-mascot candidates (A1–C2) following the ip-as-logo skill
// (https://github.com/s1dashu/ip-as-logo-skill) through CometAPI's OpenAI-compatible
// image endpoint. Every candidate is one independent request; every result is kept as-is.
//
//   COMETAPI_KEY=... node design/ip-mascot/generate.mjs            # all six
//   COMETAPI_KEY=... node design/ip-mascot/generate.mjs A1 C2      # only these labels
//
// Optional env: IMAGE_MODEL (default gpt-image-2), IMAGE_SIZE (default 1536x1536),
// COMETAPI_BASE (default https://api.cometapi.com/v1).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const BASE = process.env.COMETAPI_BASE || 'https://api.cometapi.com/v1';
const MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
const SIZE = process.env.IMAGE_SIZE || '1536x1536';
const KEY = process.env.COMETAPI_KEY;

// Three directions, each tied to one product attribute of AI Web Reader
// (rewrites hard English web pages into easier English, in place).
const DIRECTIONS = {
  A: {
    subject: 'owl',
    rationale: '读懂英文：猫头鹰是阅读和智慧的经典形象',
    feature: 'The defining feature is a pair of short, blunt, rounded ear tufts on a round head with two large simple round eyes; a tiny blunt rounded beak serves as the mouth.',
    colors: { ip: ['warm cream', 'soft amber'], background: 'muted navy blue' },
  },
  B: {
    subject: 'hamster',
    rationale: '把长难句嚼碎成小口：仓鼠鼓着腮帮慢慢嚼',
    feature: 'The defining feature is a pair of big, soft, puffed-out round cheeks, as if gently holding food; two small rounded ears sit on top.',
    colors: { ip: ['creamy white', 'warm apricot orange'], background: 'muted sage green' },
  },
  C: {
    subject: 'capybara',
    rationale: '读英文不再紧张：水豚代表放松、不费劲',
    feature: 'The defining feature is a broad, blunt, rounded-rectangle head with two tiny rounded ears and calm, relaxed half-closed eyes.',
    colors: { ip: ['warm caramel brown', 'dark chocolate brown'], background: 'muted dusty teal' },
  },
};

// A1/B1/C1 emerge from the lower-left, A2/B2/C2 from the lower-right.
const CANDIDATES = Object.keys(DIRECTIONS).flatMap((d) => [
  { label: `${d}1`, direction: d, corner: 'lower-left corner' },
  { label: `${d}2`, direction: d, corner: 'lower-right corner' },
]);

const CONSTRAINTS =
  'Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.';

// The skill's prompt skeleton for modern instruction-following models (constraints in the main prompt).
function buildPrompt({ direction, corner }) {
  const d = DIRECTIONS[direction];
  const bg = d.colors.background;
  const [c1, c2] = d.colors.ip;
  return `Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid ${bg}. Keep ${bg} visible in every open area and in the corners not occupied by the character; the assigned emergence corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing ${d.subject} IP character on the background, reduced to one soft rounded continuous silhouette and one defining feature. ${d.feature}
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. Use two simple eyes and add one tiny mouth only when it helps the expression. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors, ${c1} and ${c2}, plus the ${bg} background color. Organize both IP colors into broad purposeful masses, and reuse them for facial marks. Lower the background saturation slightly so it feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the IP, facial marks, and background clearly separated.
Composition: keep the character upright and emerging from the assigned ${corner}, filling about 85–95% of the square so it remains visually dominant. Cropping at the bottom or assigned side is welcome when it strengthens the corner emergence. Preserve both paired identifying features. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: ${CONSTRAINTS}`;
}

function imageInfo(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9; ) {
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc2) return { ext: 'jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return { ext: 'jpg' };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp' };
  return { ext: 'bin' };
}

async function generate(c) {
  const prompt = buildPrompt(c);
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, size: SIZE, n: 1 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${c.label}: HTTP ${res.status} ${text.slice(0, 500)}`);
  const item = JSON.parse(text).data?.[0];
  let buf;
  if (item?.b64_json) buf = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) buf = Buffer.from(await (await fetch(item.url)).arrayBuffer());
  else throw new Error(`${c.label}: no image in response ${text.slice(0, 300)}`);
  const info = imageInfo(buf);
  const path = join(OUT, `${c.label}.${info.ext}`);
  writeFileSync(path, buf);
  const d = DIRECTIONS[c.direction];
  return {
    label: c.label, subject: d.subject, rationale: d.rationale, corner: c.corner,
    colors: d.colors, path, width: info.width, height: info.height,
    model: MODEL, requestedSize: SIZE, constraintMode: 'main-prompt constraints', prompt,
  };
}

async function main() {
  if (!KEY) throw new Error('COMETAPI_KEY is not set');
  mkdirSync(OUT, { recursive: true });
  const wanted = process.argv.slice(2);
  const batch = wanted.length ? CANDIDATES.filter((c) => wanted.includes(c.label)) : CANDIDATES;
  const results = await Promise.allSettled(batch.map(generate));
  const report = results.map((r, i) => (r.status === 'fulfilled' ? r.value : { label: batch[i].label, error: String(r.reason.message) }));
  writeFileSync(join(OUT, `report-${Date.now()}.json`), JSON.stringify(report, null, 2));
  for (const r of report) console.log(r.error ? `✗ ${r.label}  ${r.error}` : `✓ ${r.label}  ${r.subject}  ${r.corner}  ${r.width}×${r.height}  ${r.path}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
