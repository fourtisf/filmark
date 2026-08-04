#!/usr/bin/env node
/**
 * Renders the OpenGraph cards the pages reference.
 *
 * Distribution for this product is people posting traces into Telegram and X,
 * so a blank link preview costs more reach than any copy on the page earns.
 * The meta tags were added before the images existed; this closes that.
 *
 *   node scripts/build-og-images.mjs
 *
 * Output: docs/design/og/*.png at 1200x630. In production these are served
 * from the site root, which is what the absolute URLs in the meta tags expect.
 *
 * Figures are marked illustrative, the same as the landing page's specimen
 * caption. Rule §7.4: nothing claims to be real until it is.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { MARKS, CURRENT } from './logo-marks.mjs';

const LOGO_KEY = CURRENT;
const LOGO =
  `<div class="logo"><svg class="mark" viewBox="0 0 24 24" shape-rendering="crispEdges">` +
  `${MARKS[LOGO_KEY].svg.replace(/\s+/g, ' ').trim()}</svg>FILL<i>MARK</i></div>`;

const OUT = fileURLToPath(new URL('../docs/design/og', import.meta.url));

const SHELL = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,300..800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{--bk:#060607;--s1:#0B0C0E;--ln:#1B1E22;--ln2:#2A2F35;
  --wh:#F5F6F7;--g1:#A3A9B0;--g2:#949BA4;--g3:#7E858E;--g4:#464C53;--rd:#E23B2E;
  --sans:'Archivo',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;height:630px;background:var(--bk);color:var(--wh);
  font-family:var(--sans);overflow:hidden;position:relative}
/* The same six-column hairline grid the pages sit on. */
.rule{position:absolute;inset:0;display:grid;grid-template-columns:repeat(6,1fr);
  padding:0 72px}
.rule i{border-left:1px solid rgba(245,246,247,.03)}
.rule i:last-child{border-right:1px solid rgba(245,246,247,.03)}
.w{position:relative;padding:60px 72px;height:100%;display:flex;flex-direction:column}
.logo{display:flex;align-items:center;gap:12px;font-weight:700;font-size:19px;
  letter-spacing:-.02em;font-variation-settings:'wdth' 108}
.logo i{font-style:normal;font-weight:300;color:var(--g3)}
.mark{width:22px;height:22px;flex:none;display:block}
h1{font-weight:700;font-variation-settings:'wdth' 104;letter-spacing:-.045em;
  line-height:.98;font-size:74px}
h1 u{text-decoration:none;color:var(--rd)}
h1 em{font-style:normal;font-weight:300;color:var(--g2)}
.kick{font-family:var(--mono);font-size:14px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--g3);display:flex;align-items:center;gap:14px}
.kick::before{content:"";width:32px;height:1px;background:var(--rd)}
.foot{margin-top:auto;padding-top:26px;border-top:1px solid var(--ln);display:flex;
  justify-content:space-between;font-family:var(--mono);font-size:13px;
  letter-spacing:.16em;text-transform:uppercase;color:var(--g3)}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
</style></head><body><div class="rule"><i></i><i></i><i></i><i></i><i></i><i></i></div>
<div class="w">${body}</div></body></html>`;

const CARDS = {
  'og.png': SHELL(`
    ${LOGO}
    <h1 style="margin-top:52px">Every loss has<br><em>a</em> <u>counterparty.</u></h1>
    <svg viewBox="0 0 1020 150" style="width:100%;margin-top:40px" aria-hidden="true">
      <g fill="#E23B2E">
        <path opacity=".52" d="M252,18 C500,18 520,10 758,10 L758,34 C520,34 500,48 252,48 Z"/>
        <path opacity=".3"  d="M252,48 C500,48 520,72 758,72 L758,102 C520,102 500,64 252,64 Z"/>
        <path opacity=".22" d="M252,96 C500,96 520,84 758,84 L758,102 C520,102 500,116 252,116 Z"/>
      </g>
      <g fill="#E23B2E"><rect x="246" y="18" width="6" height="46"/><rect x="246" y="96" width="6" height="20"/></g>
      <g fill="#F5F6F7"><rect x="758" y="10" width="6" height="42"/><rect x="758" y="72" width="6" height="34"/></g>
      <g text-anchor="end" font-family="JetBrains Mono,monospace">
        <text x="230" y="40" font-size="15" fill="#A3A9B0">$WIFHAT</text>
        <text x="230" y="58" font-size="12" fill="#7E858E">−$7,415</text>
        <text x="230" y="112" font-size="15" fill="#A3A9B0">$BONKX</text></g>
      <g font-family="JetBrains Mono,monospace">
        <text x="780" y="34" font-size="15" fill="#A3A9B0">9mQr…4kR8</text>
        <text x="780" y="52" font-size="12" fill="#7E858E">$6,204</text>
        <text x="780" y="98" font-size="15" fill="#A3A9B0">3Fpz…7wLm</text></g>
    </svg>
    <div class="foot"><span>fillmark.xyz</span><span>Illustrative figures</span></div>`),

  'og-index.png': SHELL(`
    ${LOGO}
    <div class="kick" style="margin-top:40px">Extractor index · 30 days</div>
    <h1 style="margin-top:22px;font-size:62px">The biggest<br><u>takers</u> on Solana.</h1>
    <div style="margin-top:38px;border-top:1px solid var(--ln2)">
      ${[
        ['01', '9mQr…4kR8', '$2.14M', 100],
        ['02', 'Qw8x…2pRv', '$1.87M', 87],
        ['03', '3Fpz…7wLm', '$1.52M', 71],
      ]
        .map(
          ([r, a, v, w]) => `
        <div style="display:grid;grid-template-columns:44px 220px 1fr 130px;gap:24px;
          align-items:center;padding:15px 0;border-bottom:1px solid var(--ln)">
          <span class="mono" style="font-size:14px;color:var(--g3)">${r}</span>
          <span class="mono" style="font-size:19px">${a}</span>
          <span style="height:5px;background:var(--ln)"><i style="display:block;height:100%;width:${w}%;background:var(--rd)"></i></span>
          <span class="mono" style="font-size:22px;font-weight:300;color:var(--rd);text-align:right">${v}</span>
        </div>`,
        )
        .join('')}
    </div>
    <div class="foot"><span>$41.8M attributed · top 100</span><span>Illustrative figures</span></div>`),

  'og-leadtime.png': SHELL(`
    ${LOGO}
    <div class="kick" style="margin-top:40px">Lead-time radar</div>
    <h1 style="margin-top:22px;font-size:62px">Ranked by <u>how early.</u><br><em>Not by how much.</em></h1>
    <svg viewBox="0 0 1020 130" style="width:100%;margin-top:34px" aria-hidden="true">
      <polyline points="600,92 650,84 690,70 730,42 780,22 850,12 950,8"
        fill="none" stroke="#7E858E" stroke-width="2"/>
      <polyline points="40,98 200,96 380,94 600,92" fill="none" stroke="#2A2F35" stroke-width="2"/>
      <line x1="600" y1="0" x2="600" y2="118" stroke="#E23B2E" stroke-dasharray="4 4"/>
      <rect x="594" y="0" width="12" height="5" fill="#E23B2E"/>
      <text x="614" y="20" font-family="JetBrains Mono,monospace" font-size="14" fill="#E23B2E">t = 0 · the move</text>
      <g fill="#E23B2E">${[70, 130, 205, 262, 318, 376, 430, 487, 540]
        .map(
          (x, i) =>
            `<rect x="${x}" y="104" width="6" height="22" opacity="${(0.85 - i * 0.05).toFixed(2)}"/>`,
        )
        .join('')}</g>
      <g fill="#F5F6F7" opacity=".26">${[660, 716, 760, 812, 868, 920]
        .map((x) => `<rect x="${x}" y="104" width="6" height="22"/>`)
        .join('')}</g>
    </svg>
    <div class="foot"><span>−41s median across 96 pumps</span><span>Illustrative figures</span></div>`),
};

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

for (const [name, html] of Object.entries(CARDS)) {
  await page.setContent(html, { waitUntil: 'networkidle' });
  // Web fonts decide the whole look; rendering before they land gives fallbacks.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const buffer = await page.screenshot({ type: 'png' });
  await writeFile(`${OUT}/${name}`, buffer);
  console.log(`  ${name}  ${(buffer.length / 1024).toFixed(0)} KB`);
}

await browser.close();
console.log(`\nWrote ${Object.keys(CARDS).length} cards to docs/design/og/`);
