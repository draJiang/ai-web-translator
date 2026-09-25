// Generates the icon candidates (SVG + PNG at every size, default + active state).
// Run: node design/icon-candidates/build.mjs  (needs Playwright's Chromium)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const OUT = dirname(fileURLToPath(import.meta.url));

const bg = (fill) => `<rect x="4" y="4" width="120" height="120" rx="28" fill="${fill}"/>`;
const sparkle = (cx, cy, r, fill) => {
  const k = r * 0.18;
  return `<path fill="${fill}" d="M${cx} ${cy - r} C${cx + k} ${cy - k} ${cx + k} ${cy - k} ${cx + r} ${cy} C${cx + k} ${cy + k} ${cx + k} ${cy + k} ${cx} ${cy + r} C${cx - k} ${cy + k} ${cx - k} ${cy + k} ${cx - r} ${cy} C${cx - k} ${cy - k} ${cx - k} ${cy - k} ${cx} ${cy - r}Z"/>`;
};
const badge = `<circle cx="100" cy="100" r="24" fill="#16A34A" stroke="#fff" stroke-width="6"/>
  <path d="M89 100.5l7.5 7.5 14-14.5" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`;

export const VERSIONS = [
  {
    id: 'v1-untangle', name: '理顺', color: '#1F2B4D',
    idea: '第一行是一段打结的波浪线，走到后面变成直线：绕口的句子被理顺，后面两行本来就是平直的正文。',
    art: `${bg('#1F2B4D')}
  <g fill="none" stroke-linecap="round" stroke-width="11">
    <path d="M24 46C28 30 38 30 40 46S52 62 54 46C56 32 62 46 70 46" stroke="#FFB547" stroke-linejoin="round"/>
    <path d="M70 46H104" stroke="#fff"/>
    <path d="M24 70H104M24 94H78" stroke="#fff"/>
  </g>`,
  },
  {
    id: 'v2-lens', name: '放大镜', color: '#4F46E5',
    idea: '背景是又细又密的文字行，镜片里只剩两行粗而短的字：同一段内容，透过插件看就更好读。',
    art: `${bg('#4F46E5')}
  <path d="M20 26H108M20 40H108M20 54H108M20 68H108M20 82H108M20 96H70" stroke="#fff" stroke-opacity=".3" stroke-width="5" stroke-linecap="round"/>
  <path d="M82 82L104 104" stroke="#fff" stroke-width="14" stroke-linecap="round"/>
  <circle cx="58" cy="58" r="33" fill="#fff"/>
  <path d="M42 51H74M42 67H64" stroke="#4F46E5" stroke-width="9" stroke-linecap="round"/>`,
  },
  {
    id: 'v3-book', name: '书页 + 火花', color: '#F26B3A',
    idea: '一本摊开的书，上方一颗 AI 火花：用 AI 帮你读。书页干净没有字，意思是读起来轻松。',
    art: `${bg('#F26B3A')}
  <path fill="#fff" d="M61 54C52 48 39 46 24 47V100C39 99 52 101 61 107Z"/>
  <path fill="#fff" d="M67 54C76 48 89 46 104 47V100C89 99 76 101 67 107Z"/>
  ${sparkle(64, 26, 15, '#fff')}`,
  },
  {
    id: 'v4-letter', name: '字母 a + 火花', color: '#0D9488',
    idea: '一个几何感的小写 a 配一颗火花：a 是最基础的字母，代表回到简单的英文；火花代表 AI。16px 下也最容易认。',
    art: `${bg('#0D9488')}
  <circle cx="48" cy="72" r="21" fill="none" stroke="#fff" stroke-width="13"/>
  <path d="M75 51V93" stroke="#fff" stroke-width="13" stroke-linecap="round"/>
  ${sparkle(93, 32, 15, '#FFE58A')}`,
  },
  {
    id: 'v5-level', name: '难度滑杆', color: '#FFC940',
    idea: '两行正文加一根滑杆，滑块停在靠左的「简单」一侧。难度以后能配置，图标里就不写死级别。',
    art: `${bg('#FFC940')}
  <g stroke="#1F2B4D" stroke-linecap="round">
    <path d="M26 38H102M26 58H84" stroke-width="10"/>
    <path d="M26 88H102" stroke-width="6" stroke-opacity=".3"/>
    <path d="M26 88H48" stroke-width="6"/>
  </g>
  <circle cx="48" cy="88" r="11" fill="#fff" stroke="#1F2B4D" stroke-width="6"/>`,
  },
];

export const svg = (v, active) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  ${v.art}${active ? '\n  ' + badge : ''}
</svg>
`;

const SIZES = [16, 32, 48, 128];

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const v of VERSIONS) {
    const dir = join(OUT, v.id);
    mkdirSync(dir, { recursive: true });
    for (const active of [false, true]) {
      const s = svg(v, active);
      const suffix = active ? '-active' : '';
      writeFileSync(join(dir, `icon${suffix}.svg`), s);
      for (const n of SIZES) {
        await page.setViewportSize({ width: n, height: n });
        await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${n}px;height:${n}px}</style>${s}`);
        await page.screenshot({ path: join(dir, `icon${n}${suffix}.png`), omitBackground: true });
      }
    }
  }
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
