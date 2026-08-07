#!/usr/bin/env node
/**
 * X profile header candidates, built around the mark.
 *
 *   node scripts/build-x-header.mjs
 *
 * Output: docs/design/social/x-banner-*.png, plus a preview with the profile
 * chrome drawn over it.
 *
 * The headers in `build-social.mjs` treat the mark as punctuation in front of a
 * wordmark — 44px of it against 1500px of canvas. These treat it as the graphic,
 * because a header is the one surface with room to.
 *
 * Two things decide whether a header works, and neither is visible in the flat
 * file:
 *
 *   1. X punches the avatar through the bottom-left. The circle is about 140px
 *      and sits half below the header's edge, so it eats roughly x 0..380,
 *      y 330..500. Anything there is gone.
 *   2. The header keeps its 3:1 ratio, so on a narrow viewport it scales down
 *      rather than cropping — but it scales *down*. A 15px caption that reads
 *      on a desktop profile is 7px on a phone.
 *
 * So the preview renders each candidate at the two widths a profile is actually
 * seen at, with the avatar and the reserved block drawn on top. A header judged
 * as a flat 1500px image is judged in the one place nobody meets it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const OUT = fileURLToPath(new URL('../docs/design/social', import.meta.url));

const BK = '#060607';
const WH = '#F5F6F7';
const G3 = '#7E858E';
const G4 = '#464C53';
const RD = '#E23B2E';
const LN = '#1B1E22';

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,300..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">`;

/** The mark, at whatever size the caller needs. Same three rects as the site. */
const mark = (size, grey = G3, red = RD) => `
  <svg viewBox="0 0 24 24" width="${size}" height="${size}" shape-rendering="crispEdges"
    style="display:block;flex:none">
    <rect x="6.5" y="5.5" width="3" height="14" fill="${grey}"/>
    <rect x="6.5" y="5.5" width="12" height="3" fill="${grey}"/>
    <rect x="6.5" y="11" width="8.5" height="3" fill="${red}"/>
  </svg>`;

const shell = (body, extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>
:root{--bk:${BK};--wh:${WH};--g3:${G3};--g4:${G4};--rd:${RD};--ln:${LN};
  --sans:'Archivo',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1500px;height:500px;background:var(--bk);color:var(--wh);
  font-family:var(--sans);overflow:hidden;position:relative}
.grid{position:absolute;inset:0;display:grid;grid-template-columns:repeat(6,1fr);padding:0 150px}
.grid i{border-left:1px solid rgba(245,246,247,.032)}
.grid i:last-child{border-right:1px solid rgba(245,246,247,.032)}
.w{position:relative;height:100%;padding:56px 150px;z-index:2}
.lock{display:flex;align-items:center;gap:20px}
.lock b{font-size:46px;font-weight:700;letter-spacing:-.035em;
  font-variation-settings:'wdth' 108;line-height:1}
.lock b i{font-style:normal;font-weight:300;color:var(--g3)}
.tag{font-family:var(--mono);letter-spacing:.26em;text-transform:uppercase;color:var(--g3)}
.dom{font-family:var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--g3)}
${extra}
</style></head><body>
<div class="grid" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
<div class="w">${body}</div></body></html>`;

/**
 * The header's usable band, and why it is not the header.
 *
 * X punches the avatar through the bottom-left — roughly x 0..380, y 330..500
 * — and every candidate here therefore ends its content by y=320 and treats the
 * bottom strip as somebody else's. The first draft of A and D both put the
 * domain down there, one of them at x=0, which is under the profile picture and
 * off the left edge at the same time.
 */
const TOP = `
  <div class="bar">
    <div class="lock">${mark(46)}<b>FILL<i>MARK</i></b></div>
    <span class="dom">fillmark.xyz</span>
  </div>`;

const BAR_CSS = `.bar{display:flex;align-items:center;justify-content:space-between}
  .dom{font-size:15px}`;

const BANNERS = {
  /*
   * A — the window, full width.
   *
   * The thing the product measures, as the field: a buy leg, the window either
   * side of it, and the sells that overlapped it. It is the only header that
   * answers "what does this do" before the bio does, and it reads at phone
   * scale because it is a rhythm of bars rather than a detail.
   *
   * Sits entirely above y=320. The bottom strip is the avatar's.
   */
  'x-banner-a.png': shell(
    `${TOP}
     <div class="motif">
       <svg viewBox="0 0 1200 190" width="1200" height="190" aria-hidden="true">
         <rect x="392" y="6" width="416" height="150" fill="${RD}" opacity=".06"/>
         <line x1="392" y1="6" x2="392" y2="156" stroke="${RD}" stroke-width="1" opacity=".45"/>
         <line x1="808" y1="6" x2="808" y2="156" stroke="${RD}" stroke-width="1" opacity=".45"/>
         <line x1="0" y1="104" x2="1200" y2="104" stroke="${LN}" stroke-width="1"/>
         <g fill="${G4}">
           <rect x="40" y="94" width="6" height="18"/><rect x="126" y="88" width="6" height="24"/>
           <rect x="214" y="97" width="6" height="15"/><rect x="300" y="90" width="6" height="22"/>
           <rect x="890" y="92" width="6" height="20"/><rect x="982" y="98" width="6" height="14"/>
           <rect x="1074" y="89" width="6" height="23"/><rect x="1160" y="95" width="6" height="17"/>
         </g>
         <g fill="${RD}">
           <rect x="436" y="58" width="8" height="46" opacity=".85"/>
           <rect x="506" y="40" width="8" height="64" opacity=".7"/>
           <rect x="576" y="66" width="8" height="38" opacity=".85"/>
           <rect x="660" y="30" width="8" height="74" opacity=".6"/>
           <rect x="726" y="62" width="8" height="42" opacity=".8"/>
           <rect x="774" y="76" width="8" height="28" opacity=".9"/>
         </g>
         <g fill="${WH}"><rect x="596" y="104" width="9" height="52"/>
           <circle cx="600.5" cy="104" r="9"/></g>
         <text x="600" y="184" fill="${WH}" font-family="JetBrains Mono, monospace"
           font-size="14" letter-spacing="2" text-anchor="middle" opacity=".8">YOUR BUY</text>
         <text x="1200" y="184" fill="${G3}" font-family="JetBrains Mono, monospace"
           font-size="14" letter-spacing="2" text-anchor="end" opacity=".7">WHO SOLD INTO IT</text>
       </svg>
     </div>`,
    `${BAR_CSS}
     .motif{margin-top:46px}`,
  ),

  /*
   * B — the answer, as a strip.
   *
   * The coverage row the console prints, laid across the header: attributed,
   * unattributed, and the loss they sum to. It puts the product's one genuinely
   * unusual behaviour — reporting what it could not explain, beside what it
   * could — on the first surface anybody sees.
   *
   * Illustrative, and it says so, for the same reason the thread's third frame
   * does: a mocked product surface is ordinary, and one presented as a
   * measurement of a real address is what this product exists to refuse.
   */
  'x-banner-b.png': shell(
    `${TOP}
     <div class="cells">
       ${[
         ['Realised', '−$10,446', ''],
         ['Attributed', '$8,140', ''],
         ['Unattributed', '$2,306', 'hot'],
         ['Window', '60 days', ''],
       ]
         .map(
           ([k, v, cls]) =>
             `<div class="cell"><span class="ck">${k}</span><b class="cv ${cls}">${v}</b></div>`,
         )
         .join('')}
     </div>
     <div class="note">Figures illustrative &middot; every trace ships with its limits</div>`,
    `${BAR_CSS}
     /* Tall enough to reach the strip the avatar owns. The first version ended
        at y=237 and left a third of the header empty under it, which on a
        profile page reads as an image that failed to load rather than as space. */
     .cells{margin-top:44px;display:grid;grid-template-columns:repeat(4,1fr);
       border-top:1px solid var(--ln);border-left:1px solid var(--ln)}
     .cell{border-right:1px solid var(--ln);border-bottom:1px solid var(--ln);
       padding:30px 24px 38px;display:flex;flex-direction:column;justify-content:center;
       min-height:150px}
     .ck{display:block;font-family:var(--mono);font-size:13px;letter-spacing:.18em;
       text-transform:uppercase;color:#5C636B}
     .cv{display:block;margin-top:12px;font-family:var(--mono);font-size:26px;font-weight:400}
     .cv.hot{color:var(--rd)}
     .note{margin-top:20px;font-family:var(--mono);font-size:12.5px;letter-spacing:.16em;
       text-transform:uppercase;color:var(--g4)}`,
  ),

  /*
   * C — centred lockup, at a size that earns the field.
   *
   * The existing centred header sets the mark at 62px against 1500px of canvas
   * and reads as a business card. Same idea at the size a header can carry, and
   * symmetric — so the scale-down on a narrow viewport takes the same amount off
   * each side. Raised off centre so the lockup clears the avatar.
   */
  'x-banner-c.png': shell(
    `<div class="mid">
       <div class="lock">${mark(88)}<b style="font-size:88px">FILL<i>MARK</i></b></div>
       <div class="rule"><i></i><span>Every loss has a counterparty</span><i></i></div>
       <span class="dom">fillmark.xyz</span>
     </div>`,
    `.mid{position:absolute;left:0;right:0;top:96px;display:flex;flex-direction:column;
       justify-content:center;align-items:center;gap:30px;z-index:2}
     .lock{gap:28px}
     .rule{display:flex;align-items:center;gap:24px;font-family:var(--mono);font-size:15px;
       letter-spacing:.28em;text-transform:uppercase;color:var(--g3)}
     .rule i{width:64px;height:1px;background:var(--rd);display:block}
     .dom{font-size:13px;color:var(--g4)}`,
  ),

  /*
   * D — the flow.
   *
   * Left, what you closed at a loss; right, the wallets that were reducing
   * supply into the same windows; between them the ribbons the console draws,
   * thick where the value left. The most literal statement of the product on
   * any of the four, and the one that needs no caption to be understood.
   */
  'x-banner-d.png': shell(
    `${TOP}
     <div class="flow">
       <svg viewBox="0 0 1200 214" width="1200" height="214" aria-hidden="true">
         <!-- Labels sit above the ribbons rather than beside them. Set inline at
              the ends they described, the left one ran off the canvas — a header
              is 1200 usable pixels and "CLOSED AT A LOSS" wants 150 of them
              before the graphic has started. -->
         <text x="0" y="12" fill="${G3}" font-family="JetBrains Mono, monospace"
           font-size="13" letter-spacing="2">CLOSED AT A LOSS</text>
         <text x="1200" y="12" fill="${G3}" font-family="JetBrains Mono, monospace"
           font-size="13" letter-spacing="2" text-anchor="end">ATTRIBUTED TO</text>
         <g fill="${RD}" transform="translate(0,32)">
           <path opacity=".55" d="M20,14 C420,14 560,6 1170,4 L1170,44 C560,46 420,58 20,58 Z"/>
           <path opacity=".38" d="M20,74 C420,74 560,110 1170,120 L1170,158 C560,148 420,112 20,112 Z"/>
           <path opacity=".24" d="M20,128 C420,128 560,158 1170,168 L1170,196 C560,186 420,166 20,166 Z"/>
         </g>
         <g fill="${WH}" transform="translate(0,32)">
           <rect x="8" y="14" width="10" height="44"/>
           <rect x="8" y="74" width="10" height="38"/>
           <rect x="8" y="128" width="10" height="38"/>
         </g>
         <g fill="${G3}" transform="translate(0,32)">
           <rect x="1172" y="4" width="10" height="40"/>
           <rect x="1172" y="120" width="10" height="38"/>
           <rect x="1172" y="168" width="10" height="28"/>
         </g>
       </svg>
     </div>`,
    `${BAR_CSS}
     .flow{margin-top:36px}`,
  ),
};

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir ?? ''}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});

const shot = new Map();
for (const [name, html] of Object.entries(BANNERS)) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 500 } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const buffer = await page.screenshot({ type: 'png' });
  await writeFile(`${OUT}/${name}`, buffer);
  shot.set(name, buffer);
  console.log(`  ${name}  1500x500  ${(buffer.length / 1024).toFixed(0)} KB`);
  await page.close();
}

/*
 * The preview, with the chrome X actually puts over a header.
 *
 * The avatar circle and the display name sit on top of the bottom-left corner,
 * and the whole thing scales down on a narrow viewport rather than cropping. A
 * flat 1500px file shows neither, which is how a header ships with its domain
 * under somebody's profile picture.
 */
const WIDTHS = [
  [600, 'desktop profile'],
  [380, 'phone'],
];

const frame = (name, width, label) => {
  const scale = width / 1500;
  const src = `data:image/png;base64,${shot.get(name).toString('base64')}`;
  return `
  <div class="one">
    <div class="hdr" style="width:${width}px;height:${Math.round(500 * scale)}px">
      <img src="${src}" style="width:${width}px;display:block">
      <!-- The reserved block, to scale: the avatar and the rows X draws under it. -->
      <div class="av" style="width:${Math.round(140 * scale)}px;height:${Math.round(140 * scale)}px;
        left:${Math.round(110 * scale)}px"></div>
    </div>
    <span>${label} · ${width}px wide</span>
  </div>`;
};

const preview = `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>*{box-sizing:border-box;margin:0;padding:0}
body{width:1180px;background:#0B0C0E;color:${WH};font-family:'Archivo',sans-serif;padding:52px}
h2{font-size:22px;font-weight:700}
h2 small{display:block;font-weight:400;font-size:13px;color:${G3};margin-top:8px}
.r{padding:34px 0;border-top:1px solid #1B1E22;margin-top:34px}
.r:first-of-type{border-top:0}
.lbl{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.14em;
  text-transform:uppercase;color:${G3};margin-bottom:20px}
.set{display:flex;align-items:flex-start;gap:40px}
.one{display:flex;flex-direction:column;gap:10px}
.hdr{position:relative;overflow:hidden;border:1px solid #1B1E22}
/* The avatar as X draws it: a circle in the page background, ringed, sitting
   half below the header's bottom edge. */
.av{position:absolute;bottom:0;transform:translateY(50%);border-radius:50%;
  background:#0B0C0E;border:2px solid #0B0C0E;box-shadow:0 0 0 1px #2A2E33 inset}
.one span{font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#5C636B}
</style></head><body>
<h2>X profile headers
  <small>1500&times;500, with the avatar drawn where X punches it through. The header
  scales down on a narrow viewport rather than cropping, so the phone column is the
  legibility test.</small></h2>
${Object.keys(BANNERS)
  .map(
    (name) => `<div class="r">
      <div class="lbl">${name.replace('x-banner-', '').replace('.png', '')}</div>
      <div class="set">${WIDTHS.map(([w, l]) => frame(name, w, l)).join('')}</div>
    </div>`,
  )
  .join('')}
</body></html>`;

const pv = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await pv.setContent(preview, { waitUntil: 'networkidle' });
await pv.evaluate(() => document.fonts.ready);
await pv.waitForTimeout(300);
await writeFile(
  `${OUT}/x-banner-preview.png`,
  await pv.screenshot({ type: 'png', fullPage: true }),
);
console.log('  x-banner-preview.png  with profile chrome');

await browser.close();
