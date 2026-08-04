#!/usr/bin/env node
/**
 * Renders logo candidates for Fillmark.
 *
 *   node scripts/build-logo-options.mjs
 *
 * Every mark obeys §3: no border radius, no gradient, no glow, one accent.
 * They are built from rectangles only, so they stay crisp at favicon size and
 * survive being rendered by anything.
 *
 * Output: docs/design/logo/*.png, plus a contact sheet showing each mark at the
 * four sizes it actually has to work at — 16px favicon, 24px nav, 64px, and the
 * full lockup.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { MARKS } from './logo-marks.mjs';

const RD = '#E23B2E';
const WH = '#F5F6F7';
const G = '#7E858E';

const OUT = fileURLToPath(new URL('../docs/design/logo', import.meta.url));

const mark = (key, px) =>
  `<svg viewBox="0 0 24 24" width="${px}" height="${px}" shape-rendering="crispEdges">${MARKS[key].svg}</svg>`;

const lockup = (key, px = 30) => `
  <span style="display:inline-flex;align-items:center;gap:${(px * 0.42).toFixed(0)}px">
    ${mark(key, px)}
    <span style="font-family:Archivo,sans-serif;font-size:${(px * 0.92).toFixed(0)}px;
      font-weight:700;font-variation-settings:'wdth' 108;letter-spacing:-.03em;color:${WH}">FILL<span
      style="font-weight:300;color:${G}">MARK</span></span>
  </span>`;

const SHEET = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,300..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060607;color:${WH};font-family:Archivo,sans-serif;width:1240px;padding:52px 56px}
h1{font-weight:700;font-variation-settings:'wdth' 104;letter-spacing:-.04em;font-size:34px}
.sub{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.2em;
  text-transform:uppercase;color:${G};margin-top:12px}
table{width:100%;border-collapse:collapse;margin-top:40px}
th{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.18em;
  text-transform:uppercase;color:${G};font-weight:400;text-align:left;padding:0 0 12px;
  border-bottom:1px solid #1B1E22}
td{padding:24px 0;border-bottom:1px solid #1B1E22;vertical-align:middle}
.key{font-family:'JetBrains Mono',monospace;font-size:13px;color:${RD};width:34px}
.nm{font-size:15px;font-weight:600;letter-spacing:-.02em;width:120px}
.idea{font-size:12.5px;font-weight:300;color:#A3A9B0;line-height:1.5;padding-right:28px}
.sz{width:auto;text-align:center}
.sz span{display:block;font-family:'JetBrains Mono',monospace;font-size:9px;color:#464C53;margin-top:8px}
.lk{width:290px}
</style></head><body>
<h1>Fillmark — mark options</h1>
<div class="sub">Six candidates · rectangles only · one accent · no radius, no gradient</div>
<table>
<tr><th></th><th>Name</th><th>Idea</th><th>16</th><th>24</th><th>64</th><th>Lockup</th></tr>
${Object.keys(MARKS)
  .map(
    (k) => `<tr>
  <td class="key">${k.toUpperCase()}</td>
  <td class="nm">${MARKS[k].name}</td>
  <td class="idea">${MARKS[k].idea}</td>
  <td class="sz">${mark(k, 16)}<span>16</span></td>
  <td class="sz">${mark(k, 24)}<span>24</span></td>
  <td class="sz">${mark(k, 64)}<span>64</span></td>
  <td class="lk">${lockup(k, 26)}</td>
</tr>`,
  )
  .join('')}
</table>
</body></html>`;

const CARD = (key) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,300..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#060607;width:760px;height:400px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:44px;font-family:Archivo,sans-serif}
.row{display:flex;align-items:center;gap:42px}
.cap{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.2em;
  text-transform:uppercase;color:#464C53}
</style></head><body>
<div class="row">${mark(key, 96)}${lockup(key, 44)}</div>
<div class="row">${mark(key, 16)}${mark(key, 24)}${mark(key, 32)}${lockup(key, 18)}</div>
<div class="cap">${String(key).toUpperCase()} · ${MARKS[key].name}</div>
</body></html>`;

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: 1240, height: 900 },
  deviceScaleFactor: 2,
});

await page.setContent(SHEET, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await writeFile(`${OUT}/contact-sheet.png`, await page.screenshot({ fullPage: true }));
console.log('  contact-sheet.png');

await page.setViewportSize({ width: 760, height: 400 });
for (const key of Object.keys(MARKS)) {
  await page.setContent(CARD(key), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await writeFile(`${OUT}/option-${key}.png`, await page.screenshot());
  console.log(`  option-${key}.png  ${MARKS[key].name}`);
}

await browser.close();
console.log(`\nWrote ${Object.keys(MARKS).length + 1} files to docs/design/logo/`);
