// Turns a chosen mascot candidate into the extension's icons/: a rounded tile at
// 16/32/48/128px, plus an "-active" copy carrying the green check badge.
//
//   node design/ip-mascot/make-icons.mjs C2
//
// Needs Playwright's Chromium (set PLAYWRIGHT_PATH if `playwright` isn't resolvable).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, '..', '..', 'icons');
const SIZES = [16, 32, 48, 128];

// Same badge geometry as the previous icon set, in a 128-unit box.
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <circle cx="100" cy="100" r="24" fill="#16A34A" stroke="#fff" stroke-width="6"/>
  <path d="M89 100.5l7.5 7.5 14-14.5" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function main() {
  const label = process.argv[2];
  if (!label) throw new Error('usage: node design/ip-mascot/make-icons.mjs <label>');
  const src = `data:image/png;base64,${readFileSync(join(HERE, 'out', `${label}.png`)).toString('base64')}`;
  const badge = `data:image/svg+xml;base64,${Buffer.from(BADGE).toString('base64')}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(async ({ src, badge, sizes }) => {
    const load = async (url) => { const im = new Image(); im.src = url; await im.decode(); return im; };
    const [art, check] = await Promise.all([load(src), load(badge)]);

    // Halve repeatedly before the final draw so small sizes average every source
    // pixel instead of sampling a few (a single 1536→16 draw aliases badly).
    const downscale = (n) => {
      let cur = art;
      let w = art.width;
      while (w / 2 >= n * 2) {
        w = Math.round(w / 2);
        const c = document.createElement('canvas');
        c.width = c.height = w;
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(cur, 0, 0, w, w);
        cur = c;
      }
      return cur;
    };

    const result = {};
    for (const n of sizes) {
      for (const active of [false, true]) {
        const c = document.createElement('canvas');
        c.width = c.height = n;
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.beginPath();
        x.roundRect(0, 0, n, n, (28 / 128) * n);
        x.clip();
        x.drawImage(downscale(n), 0, 0, n, n);
        if (active) x.drawImage(check, 0, 0, n, n);
        result[`icon${n}${active ? '-active' : ''}.png`] = c.toDataURL('image/png').split(',')[1];
      }
    }
    return result;
  }, { src, badge, sizes: SIZES });
  await browser.close();

  for (const [name, b64] of Object.entries(out)) writeFileSync(join(ICONS, name), Buffer.from(b64, 'base64'));
  console.log(`wrote ${Object.keys(out).length} icons from ${label} to icons/`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
