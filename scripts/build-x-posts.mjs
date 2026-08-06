#!/usr/bin/env node
/**
 * Renders the five in-timeline banners for the X introduction thread.
 *
 *   node scripts/build-x-posts.mjs
 *
 * Output: docs/design/social/x-post-1..5.png, plus a contact sheet.
 *
 * Different asset, different constraints from the profile header in
 * `build-social.mjs`, which is why this is a second file rather than six more
 * entries in that one.
 *
 * An in-timeline image is 16:9 and is read at roughly 500px wide on a phone —
 * a third of the width it is rendered at. Everything here is sized so it
 * survives that: nothing under 22px at render scale, one idea per frame, and
 * the headline carrying the frame rather than a caption under a picture. The
 * profile header has an avatar punched through its bottom-left corner and no
 * such reserved block exists here, so these are laid out on the full field.
 *
 * On figures, which took a wrong turn before it took the right one. Rule §7.4
 * governs what the product may state about a wallet, and a launch banner states
 * nothing about anybody's wallet — so a mocked product surface here is ordinary
 * advertising, the same thing the landing page already labels "figures on this
 * page are illustrative". Reading §7.4 as "no numbers anywhere" produced a
 * coverage frame made entirely of em dashes, which asked a reader who had never
 * seen a full answer to admire a restraint they had no reference for.
 *
 * So: one frame carries figures, they are labelled illustrative on the frame,
 * and they are internally consistent — attributed plus unattributed equals the
 * realised loss, because somebody will add them up. What stays banned is the
 * thing §7.4 is actually about: a number presented as a measurement of a real
 * address. No frame here names one, and the console still refuses to invent one.
 *
 * The other four motifs remain shapes and labels. The window diagram in
 * particular has no axis, because an axis implies units and there are none.
 *
 * The copy for each post lives in `docs/design/social/x-thread.md`, written
 * against these frames.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const OUT = fileURLToPath(new URL('../docs/design/social', import.meta.url));

/* Taken from the landing page, which §3 makes the source of truth, and kept
   byte-identical to `build-social.mjs` so the two asset sets are one identity
   rather than two that resemble each other. */
const BK = '#060607';
const WH = '#F5F6F7';
const G3 = '#7E858E';
const RD = '#E23B2E';
const LN = '#1B1E22';

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,300..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">`;

/** The mark at nav scale, for the lockup in the corner of every frame. */
const NAV_MARK = `<svg viewBox="0 0 24 24" shape-rendering="crispEdges">
  <rect x="6.5" y="5.5" width="3" height="14" fill="${G3}"/>
  <rect x="6.5" y="5.5" width="12" height="3" fill="${G3}"/>
  <rect x="6.5" y="11" width="8.5" height="3" fill="${RD}"/></svg>`;

/** The six-column hairline grid the site sits on, at post width. */
const GRID = `
<div class="grid" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>`;

/**
 * One frame. `n` prints in the corner so a reader who meets post four first
 * knows there are five, which is the only number on any of these and is a
 * property of the thread rather than a claim about a wallet.
 */
const post = (n, body, extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>
:root{--bk:${BK};--wh:${WH};--g3:${G3};--rd:${RD};--ln:${LN};
  --sans:'Archivo',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1600px;height:900px;background:var(--bk);color:var(--wh);
  font-family:var(--sans);overflow:hidden;position:relative}
.grid{position:absolute;inset:0;display:grid;grid-template-columns:repeat(6,1fr);padding:0 110px}
.grid i{border-left:1px solid rgba(245,246,247,.032)}
.grid i:last-child{border-right:1px solid rgba(245,246,247,.032)}
.w{position:relative;height:100%;padding:76px 110px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between;flex:none}
.logo{display:flex;align-items:center;gap:16px}
.logo svg{width:38px;height:38px;flex:none;display:block}
.logo b{font-size:38px;font-weight:700;letter-spacing:-.035em;
  font-variation-settings:'wdth' 108}
.logo b i{font-style:normal;font-weight:300;color:var(--g3)}
.seq{font-family:var(--mono);font-size:22px;letter-spacing:.22em;color:#464C53}
.seq u{text-decoration:none;color:var(--g3)}
.kick{font-family:var(--mono);font-size:24px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--g3);display:flex;align-items:center;gap:18px}
.kick::before{content:"";width:40px;height:1px;background:var(--rd);flex:none}
h1{font-weight:700;font-variation-settings:'wdth' 104;letter-spacing:-.04em;line-height:.98}
h1 em{font-style:normal;font-weight:300;color:#949BA4}
h1 u{text-decoration:none;color:var(--rd)}
.sub{margin-top:30px;font-size:29px;line-height:1.45;color:#B4BAC1;font-weight:300;max-width:940px}
.dom{font-family:var(--mono);font-size:23px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--g3)}
.foot{margin-top:auto;flex:none;display:flex;align-items:flex-end;justify-content:space-between}
${extra}
</style></head><body>${GRID}<div class="w">
  <div class="top">
    <div class="logo"><span>${NAV_MARK}</span><b>FILL<i>MARK</i></b></div>
    <span class="seq">${String(n).padStart(2, '0')}<u>&thinsp;/&thinsp;05</u></span>
  </div>
  ${body}
</div></body></html>`;

/**
 * The motif for post 2: a losing entry, and the wallets that were selling into
 * the window around it.
 *
 * Deliberately not a chart. A chart has an axis, an axis implies units, and
 * units on a launch banner are a measurement nobody took. This is the shape of
 * the mechanic — one buy, a window either side of it, several counterparties
 * overlapping it — with no quantity anywhere in it.
 */
const WINDOW_MOTIF = `
<svg viewBox="0 0 1380 250" width="1380" height="250" aria-hidden="true">
  <rect x="430" y="14" width="520" height="196" fill="${RD}" opacity=".05"/>
  <line x1="430" y1="14" x2="430" y2="210" stroke="${RD}" stroke-width="1" opacity=".45"/>
  <line x1="950" y1="14" x2="950" y2="210" stroke="${RD}" stroke-width="1" opacity=".45"/>
  <line x1="0" y1="132" x2="1380" y2="132" stroke="${LN}" stroke-width="1"/>
  <g fill="${G3}" opacity=".5">
    <rect x="46" y="122" width="7" height="20"/><rect x="142" y="116" width="7" height="26"/>
    <rect x="234" y="125" width="7" height="17"/><rect x="326" y="112" width="7" height="30"/>
    <rect x="1050" y="120" width="7" height="22"/><rect x="1160" y="126" width="7" height="16"/>
    <rect x="1272" y="115" width="7" height="27"/>
  </g>
  <g fill="${RD}">
    <rect x="482" y="76" width="9" height="56" opacity=".85"/>
    <rect x="562" y="58" width="9" height="74" opacity=".7"/>
    <rect x="650" y="86" width="9" height="46" opacity=".85"/>
    <rect x="744" y="46" width="9" height="86" opacity=".6"/>
    <rect x="830" y="80" width="9" height="52" opacity=".8"/>
    <rect x="894" y="98" width="9" height="34" opacity=".9"/>
  </g>
  <g fill="${WH}">
    <rect x="684" y="132" width="11" height="72"/>
    <circle cx="689.5" cy="132" r="10"/>
  </g>
  <text x="689" y="238" fill="${WH}" font-family="JetBrains Mono, monospace"
    font-size="18" letter-spacing="2.4" text-anchor="middle" opacity=".78">YOUR BUY</text>
  <text x="1380" y="238" fill="${G3}" font-family="JetBrains Mono, monospace"
    font-size="18" letter-spacing="2.4" text-anchor="end" opacity=".7">THE WINDOW EITHER SIDE OF IT</text>
</svg>`;

/**
 * The motif for post 3: a populated coverage block, and the arithmetic in it.
 *
 * This started as the console's empty state, dashes intact, on the theory that
 * a product which refuses to state what it did not measure should open by
 * showing that refusal. It was the wrong frame. A reader who has never seen a
 * full answer cannot tell an honest empty state from a dead product, and a
 * banner of dashes asks them to admire a restraint they have no reference for.
 *
 * Filled, the same claim lands harder, because the numbers carry it: attributed
 * and unattributed sum to the realised loss exactly — 8,140 + 2,306 = 10,446 —
 * so the frame demonstrates that the part no window explained is reported
 * beside the headline rather than folded into it. Somebody will add those up.
 * They should come out right.
 *
 * Illustrative, and labelled as such on the frame. That is the same line the
 * landing page already holds ("figures on this page are illustrative"): a
 * mocked product surface in an ad is ordinary, and a mocked product surface
 * presented as a measurement of somebody's wallet is the thing this product
 * exists to refuse. The label is what keeps those apart.
 */
const COVERAGE_ROWS = [
  ['Source', 'live chain crawl'],
  ['Window', '60 day lookback'],
  ['Venues read', 'pumpfun, pumpswap'],
  ['Positions attributed', '9 of 12'],
  ['Realised PnL', '−$10,446'],
  ['Attributed', '$8,140'],
  ['Unattributed', '$2,306'],
  ['Swaps unpriced', '4 of 213'],
];

const POSTS = {
  /*
   * The thesis, in the words the console already uses on its own empty state.
   * §7.1: it describes a mechanic — on an AMM somebody was on the other side —
   * and claims nothing about proof, recovery or identity.
   */
  'x-post-1.png': post(
    1,
    `
    <div class="kick" style="margin-top:96px">Solana · realised positions</div>
    <h1 style="margin-top:44px;font-size:112px">Your losses didn't<br>evaporate.<br><em>They</em> <u>moved.</u></h1>
    <div class="foot">
      <span class="dom">fillmark.xyz</span>
      <span class="dom" style="color:#464C53">counterparty forensics</span>
    </div>`,
  ),

  // What one trace actually does, as a shape rather than a screenshot.
  'x-post-2.png': post(
    2,
    `
    <div class="kick" style="margin-top:54px">What a trace does</div>
    <h1 style="margin-top:30px;font-size:66px">Every position closed<br>
      in the red, <em>netted against</em><br>
      <u>who was selling into it.</u></h1>
    <div class="motif">${WINDOW_MOTIF}</div>
    <div class="foot"><span class="dom">fillmark.xyz/app</span></div>`,
    `.motif{margin-top:34px}
     .foot{padding-top:14px}`,
  ),

  /*
   * The differentiator, and the one that is hardest to fake: the product says
   * what it could not read. Everything else in this category shows you a
   * number and lets you assume it is complete.
   */
  'x-post-3.png': post(
    3,
    `
    <div class="kick" style="margin-top:46px">Every answer ships with its limits</div>
    <h1 style="margin-top:28px;font-size:72px">It tells you what it <u>could not read.</u></h1>
    <p class="sub" style="font-size:27px;max-width:1240px;margin-top:24px">$2,306 of that loss had
      no window that explained it. It is reported beside the headline, not inside it &mdash; and
      the two still add up to what the wallet actually realised.</p>
    <div class="cov">
      ${COVERAGE_ROWS.map(
        ([k, v]) =>
          `<div class="cell"><span class="ck">${k}</span><b class="cv${k === 'Unattributed' ? ' hot' : ''}">${v}</b></div>`,
      ).join('')}
    </div>
    <div class="foot">
      <span class="dom">fillmark.xyz</span>
      <span class="dom" style="color:#464C53">figures illustrative</span>
    </div>`,
    /* The table is the argument on this frame, so it gets the field rather than
       a column beside a paragraph. Two columns left the headline stopping
       mid-frame with a third of the canvas empty under it — which at timeline
       scale reads as an image that failed to load rather than as restraint.
       `flex:1` with `1fr` rows grows it to the footer at any row count. */
    `.cov{margin-top:38px;flex:1;min-height:0;display:grid;
       grid-template-columns:repeat(4,1fr);grid-auto-rows:1fr;
       border-top:1px solid ${LN};border-left:1px solid ${LN}}
     .cell{border-right:1px solid ${LN};border-bottom:1px solid ${LN};padding:20px 24px;
       display:flex;flex-direction:column;justify-content:center}
     .ck{display:block;font-family:var(--mono);font-size:15px;letter-spacing:.18em;
       text-transform:uppercase;color:#5C636B}
     .cv{display:block;margin-top:14px;font-family:var(--mono);font-size:25px;
       font-weight:400;color:var(--wh)}
     /* The one cell the frame is actually about. Everything else on this grid
        is context for it: the accent is what stops a reader skimming past the
        number that proves the claim in the headline. */
     .cv.hot{color:var(--rd)}
     .foot{padding-top:32px}`,
  ),

  /*
   * The caveat, said first rather than buried. Overlap is not payment, and a
   * product that lets a reader believe otherwise has sold them a certainty it
   * does not have — which is the §7.1 failure, in public.
   */
  'x-post-4.png': post(
    4,
    `
    <div class="kick" style="margin-top:96px">Read this before the list</div>
    <h1 style="margin-top:40px;font-size:88px">Attribution measures<br>
      <u>overlap</u><em>, not</em> <u>payment.</u></h1>
    <p class="sub">On an AMM you trade against a pool. These are the wallets that were
      reducing supply into the same windows &mdash; weighted by size and proximity,
      and named as exactly that.</p>
    <div class="foot"><span class="dom">fillmark.xyz</span></div>`,
  ),

  // The ask. One input, one button, no signature and no wallet connection.
  'x-post-5.png': post(
    5,
    `
    <div class="kick" style="margin-top:76px">Open, no wallet connection</div>
    <h1 style="margin-top:36px;font-size:82px">Paste an address.<br><em>That is the</em> <u>whole flow.</u></h1>
    <div class="box">
      <span class="ph">wallet address</span>
      <span class="btn">Trace wallet</span>
    </div>
    <div class="out">
      <i></i><span>closed positions &middot; the windows around them &middot; who was on the other
      side &middot; and what could not be read</span>
    </div>
    <div class="foot">
      <span class="dom" style="color:var(--wh)">fillmark.xyz/app</span>
      <span class="dom" style="color:#464C53">read-only · nothing to sign</span>
    </div>`,
    `.box{margin-top:50px;max-width:1020px;display:flex;align-items:stretch;
       background:#0D0F11;border:1px solid ${LN}}
     .ph{flex:1;padding:36px 40px;font-family:var(--mono);font-size:29px;color:#5C636B;
       letter-spacing:.04em}
     .btn{flex:none;display:flex;align-items:center;padding:0 52px;background:var(--wh);
       color:#0B0C0E;font-size:29px;font-weight:600;letter-spacing:-.01em}
     .out{margin-top:40px;display:flex;align-items:flex-start;gap:18px;max-width:1020px;
       font-family:var(--mono);font-size:21px;line-height:1.7;letter-spacing:.1em;
       text-transform:uppercase;color:#5C636B}
     .out i{flex:none;width:40px;height:1px;background:${RD};margin-top:17px;display:block}`,
  ),
};

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir ?? ''}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});

const rendered = new Map();

async function render(name, html, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const buffer = await page.screenshot({ type: 'png' });
  await writeFile(`${OUT}/${name}`, buffer);
  rendered.set(name, buffer);
  console.log(`  ${name}  ${width}x${height}  ${(buffer.length / 1024).toFixed(0)} KB`);
  await page.close();
}

for (const [name, html] of Object.entries(POSTS)) await render(name, html, 1600, 900);

/*
 * A contact sheet at the width a phone actually renders these.
 *
 * A banner judged at 1600px is judged at a size almost nobody sees it: in the
 * timeline it is around 500px wide, which is where a 24px label stops being a
 * label and becomes texture. Reviewing at full size is how a frame ships
 * unreadable.
 */
const sheet = `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}<style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1180px;background:#0B0C0E;color:${WH};font-family:'Archivo',sans-serif;padding:56px}
h2{font-size:24px;font-weight:700;letter-spacing:-.02em}
p{margin-top:10px;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.16em;
  text-transform:uppercase;color:${G3}}
.row{display:flex;gap:34px;align-items:flex-start;margin-top:40px;
  padding-top:34px;border-top:1px solid #1B1E22}
.row:first-of-type{border-top:0}
img{display:block;border:1px solid #1B1E22}
.big{width:600px}.small{width:380px}
.cap{margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:11px;
  letter-spacing:.14em;text-transform:uppercase;color:#5C636B}
</style></head><body>
<h2>X introduction thread &mdash; in-timeline frames</h2>
<p>1600&times;900 &middot; left: 600px &middot; right: 380px, about what a phone renders</p>
${Object.keys(POSTS)
  .map(
    (name) => `
<div class="row">
  <div><img class="big" src="data:image/png;base64,${rendered.get(name).toString('base64')}">
    <div class="cap">${name} &middot; desktop</div></div>
  <div><img class="small" src="data:image/png;base64,${rendered.get(name).toString('base64')}">
    <div class="cap">phone</div></div>
</div>`,
  )
  .join('')}
</body></html>`;

const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
await page.setContent(sheet, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await writeFile(
  `${OUT}/x-post-preview.png`,
  await page.screenshot({ type: 'png', fullPage: true }),
);
console.log('  x-post-preview.png  contact sheet');

await browser.close();
