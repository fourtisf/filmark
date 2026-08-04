#!/usr/bin/env node
/**
 * Renders the X profile assets: avatar candidates and header banners.
 *
 *   node scripts/build-social.mjs
 *
 * Output: docs/design/social/*.png
 *
 * Two constraints drive every decision here, and neither applies to the OG
 * cards this borrows its palette from.
 *
 * The avatar is cropped to a circle and shown at 32px in a timeline. The
 * wordmark is illegible at that size, so the avatar carries the mark alone —
 * and the mark's geometry has to fit inside the inscribed circle, which the
 * favicon's square proportions do not. It is laid out in pixels here rather
 * than scaled from the 24-unit grid, so the corner distance can be checked
 * against the circle radius instead of hoped at.
 *
 * The header has an avatar overlapping its bottom-left corner and is cropped
 * horizontally on narrow viewports. Nothing that must be read goes in the
 * bottom-left, and nothing sits near the outer edges.
 *
 * Rule §7.4: no figures, fabricated or otherwise. The banners carry the
 * positioning line and the domain, nothing that reads as a measurement.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const OUT = fileURLToPath(new URL('../docs/design/social', import.meta.url));

const BK = '#060607';
const WH = '#F5F6F7';
const G3 = '#7E858E';
const RD = '#E23B2E';
const LN = '#1B1E22';

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,300..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">`;

/**
 * The Ledger mark, laid out for a 1000px square.
 *
 * `k` is the unit of the original 24-grid: bar height 2k, centres 6k apart,
 * long bar 20k wide, short bar 11k. The mark's furthest point from centre is
 * sqrt((10k)^2 + (7k)^2) ~= 12.21k, which must stay inside the 500px circle
 * with room to breathe — k=34 puts it at 415px.
 */
function mark({ k = 34, long = WH, short = RD, bleed = false } = {}) {
  const h = 2 * k;
  const yTop = 500 - 6 * k - k;
  const rows = [0, 1, 2].map((i) => yTop + i * 6 * k);
  const x = bleed ? 0 : 500 - 10 * k;
  const wLong = bleed ? 1000 : 20 * k;
  const wShort = bleed ? 550 : 11 * k;

  return `
    <rect x="${x}" y="${rows[0]}" width="${wLong}" height="${h}" fill="${long}"/>
    <rect x="${x}" y="${rows[1]}" width="${wShort}" height="${h}" fill="${short}"/>
    <rect x="${x}" y="${rows[2]}" width="${wLong}" height="${h}" fill="${long}"/>`;
}

const avatar = (body, background) => `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1000px;height:1000px;overflow:hidden;background:${background}}
svg{display:block}
</style></head><body>
<svg width="1000" height="1000" viewBox="0 0 1000 1000" shape-rendering="crispEdges">${body}</svg>
</body></html>`;

const AVATARS = {
  // The default: mark alone on the product's own background. Reads at 32px
  // because there are three shapes and one of them is red.
  'x-avatar-a-dark.png': avatar(mark(), BK),

  // For a light timeline, and for anywhere the mark is printed on paper.
  'x-avatar-b-light.png': avatar(mark({ long: '#16181C' }), WH),

  // Bars run to the edge, so the circle crops them. Loudest at small sizes;
  // the mark stops being an object in a field and becomes the field.
  'x-avatar-c-bleed.png': avatar(mark({ bleed: true }), BK),

  // Red field, near-black bars. One accent, inverted — use only if the
  // timeline presence matters more than the restraint everywhere else does.
  'x-avatar-d-red.png': avatar(mark({ long: '#0B0C0E', short: WH }), RD),
};

/** The six-column hairline grid the site sits on, at banner width. */
const GRID = `
<div class="grid" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>`;

const banner = (body, extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>
:root{--bk:${BK};--wh:${WH};--g3:${G3};--rd:${RD};--ln:${LN};
  --sans:'Archivo',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1500px;height:500px;background:var(--bk);color:var(--wh);
  font-family:var(--sans);overflow:hidden;position:relative}
.grid{position:absolute;inset:0;display:grid;grid-template-columns:repeat(6,1fr);padding:0 150px}
.grid i{border-left:1px solid rgba(245,246,247,.032)}
.grid i:last-child{border-right:1px solid rgba(245,246,247,.032)}
.w{position:relative;height:100%;padding:64px 150px}
.logo{display:flex;align-items:center;gap:20px}
.logo svg{width:44px;height:44px;flex:none;display:block}
.logo b{font-size:44px;font-weight:700;letter-spacing:-.035em;
  font-variation-settings:'wdth' 108}
.logo b i{font-style:normal;font-weight:300;color:var(--g3)}
.kick{font-family:var(--mono);font-size:15px;letter-spacing:.26em;text-transform:uppercase;
  color:var(--g3);display:flex;align-items:center;gap:14px}
.kick::before{content:"";width:30px;height:1px;background:var(--rd)}
h1{font-weight:700;font-variation-settings:'wdth' 104;letter-spacing:-.04em;line-height:1}
h1 em{font-style:normal;font-weight:300;color:#949BA4}
h1 u{text-decoration:none;color:var(--rd)}
.dom{font-family:var(--mono);font-size:15px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--g3)}
${extra}
</style></head><body>${GRID}<div class="w">${body}</div></body></html>`;

/** The mark at nav scale, for use inside a banner's wordmark. */
const NAV_MARK = `<svg viewBox="0 0 24 24" shape-rendering="crispEdges">
  <rect x="2" y="5" width="20" height="2" fill="${G3}"/>
  <rect x="2" y="11" width="11" height="2" fill="${RD}"/>
  <rect x="2" y="17" width="20" height="2" fill="${G3}"/></svg>`;

/**
 * X puts the profile avatar over the banner's bottom-left corner and crops the
 * sides on narrow viewports. Everything below is laid out around a reserved
 * block — x 0..340, y 320..500 — which is why the left column stops where it
 * does rather than filling the height.
 */
const BANNERS = {
  // The line the whole product rests on. §7.1: it describes a mechanic — on an
  // AMM the other side of your fill exists — and claims nothing about proof.
  'x-header-a.png': banner(
    `
    <div class="top">
      <div class="logo"><span>${NAV_MARK}</span><b>FILL<i>MARK</i></b></div>
      <span class="dom">fillmark.xyz</span>
    </div>
    <h1>Every loss has<br><em>a</em> <u>counterparty.</u></h1>
    <div class="ribbon">
      <svg viewBox="0 0 480 260" width="480" height="260" aria-hidden="true">
        <g fill="${RD}">
          <path opacity=".62" d="M14,26 C180,26 230,14 474,8 L474,46 C230,52 180,72 14,72 Z"/>
          <path opacity=".42" d="M14,96 C180,96 230,140 474,150 L474,192 C230,182 180,128 14,128 Z"/>
          <path opacity=".28" d="M14,182 C180,182 230,166 474,158 L474,192 C230,200 180,226 14,226 Z"/>
          <rect x="0" y="26" width="10" height="102"/>
          <rect x="0" y="182" width="10" height="44"/>
        </g>
        <g fill="${WH}" opacity=".7">
          <rect x="474" y="8" width="10" height="38"/>
          <rect x="474" y="150" width="10" height="42"/>
        </g>
      </svg>
    </div>`,
    `.top{display:flex;align-items:center;justify-content:space-between}
     h1{margin-top:52px;font-size:68px;max-width:720px}
     .ribbon{position:absolute;right:118px;top:126px}`,
  ),

  // Quieter: the lockup and one line of what it is. Symmetric, so the mobile
  // crop takes the same amount off each side and nothing important goes.
  'x-header-b.png': banner(
    `
    <div class="centre">
      <div class="logo">
        <span>${NAV_MARK}</span><b style="font-size:66px">FILL<i>MARK</i></b>
      </div>
      <div class="tag">
        <i></i><span>Solana counterparty forensics</span><i></i>
      </div>
      <div class="dom" style="margin-top:34px">fillmark.xyz</div>
    </div>`,
    `.centre{position:absolute;inset:0;display:flex;flex-direction:column;
       justify-content:center;align-items:center;padding-bottom:14px}
     .logo{justify-content:center}
     .logo svg{width:62px;height:62px}
     .tag{margin-top:30px;display:flex;align-items:center;gap:22px;
       font-family:var(--mono);font-size:16px;letter-spacing:.28em;
       text-transform:uppercase;color:var(--g3)}
     .tag i{width:56px;height:1px;background:var(--rd);display:block}`,
  ),

  // The thing the product actually measures, as a motif: entries before the
  // move in red, entries after it dim. No numbers — §7.4 — and no axis, so it
  // reads as a pattern rather than a claim about a measurement.
  'x-header-c.png': banner(
    `
    <div class="top">
      <div class="logo"><span>${NAV_MARK}</span><b>FILL<i>MARK</i></b></div>
      <span class="dom">fillmark.xyz</span>
    </div>
    <div class="kick" style="margin-top:38px">Who was early, and who paid for it</div>
    <div class="ticks">
      <svg viewBox="0 0 1030 190" width="1030" height="190" aria-hidden="true">
        <line x1="0" y1="150" x2="1030" y2="150" stroke="${LN}" stroke-width="1"/>
        <g fill="${RD}">${Array.from({ length: 22 }, (_, i) => {
          const x = i * 25;
          const h = 34 + ((i * 17) % 46);
          return `<rect x="${x}" y="${150 - h}" width="8" height="${h}" opacity="${(0.92 - i * 0.021).toFixed(3)}"/>`;
        }).join('')}</g>
        <line x1="580" y1="16" x2="580" y2="176" stroke="${RD}" stroke-dasharray="6 6" stroke-width="2"/>
        <rect x="572" y="10" width="17" height="7" fill="${RD}"/>
        <g fill="${WH}" opacity=".2">${Array.from({ length: 17 }, (_, i) => {
          const x = 610 + i * 25;
          const h = 20 + ((i * 11) % 24);
          return `<rect x="${x}" y="${150 - h}" width="8" height="${h}"/>`;
        }).join('')}</g>
      </svg>
    </div>`,
    `.top{display:flex;align-items:center;justify-content:space-between}
     /* Right of the avatar block and clear of the bottom edge. */
     .ticks{position:absolute;left:360px;top:248px;line-height:0}
     .kick{margin-left:2px}`,
  ),
};

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});

async function render(name, html, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const buffer = await page.screenshot({ type: 'png' });
  await writeFile(`${OUT}/${name}`, buffer);
  await page.close();
  console.log(`  ${name}  ${width}x${height}  ${(buffer.length / 1024).toFixed(0)} KB`);
  return buffer;
}

const rendered = new Map();
for (const [name, html] of Object.entries(AVATARS)) {
  rendered.set(name, await render(name, html, 1000, 1000));
}
for (const [name, html] of Object.entries(BANNERS)) await render(name, html, 1500, 500);

// A contact sheet showing each avatar as X will actually present it: circular,
// and at the 32px the timeline uses. A mark judged at full size is judged at a
// size nobody sees it.
// Inlined, because setContent has no base URL and a relative src would resolve
// to nothing — which renders as an empty contact sheet that looks like a
// design problem rather than a plumbing one.
const previews = Object.keys(AVATARS)
  .map((name) => {
    const src = `data:image/png;base64,${rendered.get(name).toString('base64')}`;
    return `
  <div class="cell">
    <div class="row">
      <img class="c" style="width:112px;height:112px" src="${src}">
      <img class="c" style="width:48px;height:48px" src="${src}">
      <img class="c" style="width:32px;height:32px" src="${src}">
      <span class="light"><img class="c" style="width:48px;height:48px" src="${src}"></span>
    </div>
    <div class="cap">${name.replace('x-avatar-', '').replace('.png', '')}</div>
  </div>`;
  })
  .join('');

await render(
  'x-avatar-preview.png',
  `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1000px;background:#0B0C0E;color:${WH};font-family:'Archivo',sans-serif;
  padding:44px;display:grid;gap:34px}
.cell{border:1px solid ${LN};padding:26px 28px}
.row{display:flex;align-items:center;gap:30px}
.c{border-radius:50%;display:block}
.light{background:${WH};padding:14px;display:block;border-radius:4px}
.cap{margin-top:18px;font-family:'JetBrains Mono',monospace;font-size:11px;
  letter-spacing:.2em;text-transform:uppercase;color:${G3}}
h2{font-size:17px;font-weight:600;letter-spacing:-.02em}
p{font-size:13px;font-weight:300;color:#A3A9B0;margin-top:6px}
</style></head><body>
<div><h2>X avatar candidates</h2>
<p>Circular, as X crops them. Sizes: 112px, 48px, 32px — the last is the timeline.</p></div>
${previews}
</body></html>`,
  1000,
  4 * 232 + 200,
);

await browser.close();
console.log(
  `\nWrote ${Object.keys(AVATARS).length} avatars and ${Object.keys(BANNERS).length} banners to docs/design/social/`,
);
