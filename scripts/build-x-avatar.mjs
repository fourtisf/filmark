#!/usr/bin/env node
/**
 * Premium mark candidates for the X profile picture.
 *
 *   node scripts/build-x-avatar.mjs
 *
 * Output: docs/design/social/x-mark-*.png, plus a contact sheet.
 *
 * The mark in `build-social.mjs` is a serviceable block F. It is also a letter
 * and nothing else: swap the colour and it belongs to any company starting with
 * the same initial. What follows tries to earn the field it occupies — every
 * candidate below is still an F, and each one is an F that says something this
 * product does.
 *
 * Three constraints decide it, and the third kills most ideas:
 *
 * 1. X crops to a circle. The mark is laid out on a 1000px square whose
 *    inscribed circle is the whole canvas; nothing may cross r=440 from centre
 *    or the crop takes it.
 * 2. The timeline renders it at 32px. That is 3.2px per 100 units, so a stroke
 *    under ~110 units disappears and a fourth shape becomes mud. Two or three
 *    shapes, one of them accented, is the budget.
 * 3. It has to read as F *first*. A concept that has to be explained before the
 *    letter is visible is a rebus, not a mark.
 *
 * Every candidate is rendered at the four sizes X actually uses and on both a
 * dark and a light timeline, because a mark judged at 400px on the background
 * it was drawn against is a mark judged in the one place nobody meets it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const OUT = fileURLToPath(new URL('../docs/design/social', import.meta.url));

const BK = '#060607';
const WH = '#F5F6F7';
const RD = '#E23B2E';
const INK = '#16181C';

/**
 * The skeleton every candidate is built on, so they differ by idea rather than
 * by proportion and the comparison is about the idea.
 *
 * Stroke 132 renders 4.2px at 32px, which survives a timeline; 120 was the old
 * value and sat right on the edge. The stem starts left of centre because the
 * arms extend right, and the whole glyph is nudged back by a third of the
 * resulting imbalance — a full correction overshoots, since the eye weights the
 * heavy stem more than the thin arms it carries.
 */
const S = 132; // stroke
const X0 = 306; // stem left
const Y0 = 236; // cap line
const H = 528; // cap height
const ARM = 420; // top arm length from stem left
const GAP = 118; // counter between top arm and middle arm
const MID = Y0 + S + GAP; // middle arm top edge

/** Stem and top arm, shared by every candidate. */
const spine = (ink) => `
  <rect x="${X0}" y="${Y0}" width="${S}" height="${H}" fill="${ink}"/>
  <rect x="${X0}" y="${Y0}" width="${ARM}" height="${S}" fill="${ink}"/>`;

/**
 * A — the overshoot.
 *
 * An F's lower arm is always shorter than its upper one. This one is longer,
 * and it is the only thing about the glyph that is unusual — which is why it is
 * the thing that gets remembered. It is also the product: the row that closed
 * in the red went further than the row above it, and it went right.
 *
 * The first version detached the arm and floated it clear of the stem, which
 * carried the idea better and failed the letter: at 32px it read as a gamma
 * beside a dot. Attached and overrunning keeps both — the silhouette is still
 * unmistakably F, and the inversion survives every size because it is a length,
 * not a gap.
 */
const OVERSHOOT = 104;
const A = (ink) => `${spine(ink)}
  <rect x="${X0}" y="${MID}" width="${ARM + OVERSHOOT}" height="${S}" fill="${RD}"/>`;

/**
 * B — the weighted arm.
 *
 * Attached, but heavier than the arm above it and shorter, so the mark is
 * bottom-loaded where a letter F is normally top-loaded. Reads as an F at every
 * size and as "the lower row carries more" on inspection. The safest of the
 * five, and the one that survives embroidery and a favicon.
 */
const B_STROKE = Math.round(S * 1.32);
const B = (ink) => `${spine(ink)}
  <rect x="${X0}" y="${MID}" width="${Math.round(ARM * 0.66)}" height="${B_STROKE}" fill="${RD}"/>`;

/**
 * C — the ribbon.
 *
 * The arms taper the way the console's own flow diagram does, thick where the
 * value leaves and thin where it lands. It is the most distinctive of the five
 * and the most fragile: a taper is a gradient of area, and at 32px the thin end
 * is under a pixel. Kept because at 112px — the profile page, where somebody
 * decides whether to follow — it is the only one that looks drawn rather than
 * assembled.
 */
const C = (ink) => {
  // A real trapezoid, not a shorter rectangle. The first attempt tried to reuse
  // `spine` and drop its top arm by splitting the string it returns, which left
  // two constant-height bars and no taper at all — the sheet showed a plain F
  // and the idea was never actually on it.
  const tipTop = Math.round(S * 0.5);
  const tipMid = Math.round(S * 0.56);
  const midLen = Math.round(ARM * 0.78);
  return `
  <rect x="${X0}" y="${Y0}" width="${S}" height="${H}" fill="${ink}"/>
  <path d="M${X0} ${Y0} L${X0 + ARM} ${Y0} L${X0 + ARM} ${Y0 + tipTop} L${X0} ${Y0 + S} Z"
    fill="${ink}"/>
  <path d="M${X0} ${MID} L${X0 + midLen} ${MID} L${X0 + midLen} ${MID + tipMid} L${X0} ${MID + S} Z"
    fill="${RD}"/>`;
};

/**
 * D — the cut terminal.
 *
 * Both arms end on a 45° chamfer cut the same way, which gives the glyph a
 * direction it does not otherwise have: everything points right, towards the
 * side the value went. The cheapest device here and the most conventional —
 * this is what a bank would ship — which is exactly why it is worth having on
 * the sheet.
 */
const CHAMFER = 62;
const D = (ink) => `
  <rect x="${X0}" y="${Y0}" width="${S}" height="${H}" fill="${ink}"/>
  <path d="M${X0} ${Y0} H${X0 + ARM} L${X0 + ARM - CHAMFER} ${Y0 + S} H${X0} Z" fill="${ink}"/>
  <path d="M${X0} ${MID} H${X0 + Math.round(ARM * 0.72)}
    L${X0 + Math.round(ARM * 0.72) - CHAMFER} ${MID + S} H${X0} Z" fill="${RD}"/>`;

/**
 * E — the notch.
 *
 * A solid slab with the F cut out of it, and the accent carried by a notch in
 * the counter rather than by an arm. The only candidate where the letter is
 * negative space, which is what makes it the one that reads as a *logo* rather
 * than as a letter — and the one most likely to fill in and go muddy at 32px,
 * which the sheet will show honestly.
 */
const E = (ink, field) => {
  const pad = 96;
  const x = X0 - pad;
  const y = Y0 - pad;
  const w = ARM + pad + 30;
  const h = H + pad * 2;
  // The counters take the field colour, not a hardcoded near-black. On the
  // light sheet that constant painted two dark bricks inside a dark slab and
  // the candidate was judged on a bug rather than on the idea.
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${ink}"/>
  <rect x="${X0 + S}" y="${Y0 + S}" width="${ARM - S}" height="${GAP}" fill="${field}"/>
  <rect x="${X0 + S}" y="${MID + S}" width="${ARM - S}" height="${h - (MID + S - y) - pad}"
    fill="${field}"/>
  <rect x="${X0 + S}" y="${MID}" width="${Math.round((ARM - S) * 0.46)}" height="${S}" fill="${RD}"/>`;
};

const MARKS = { a: A, b: B, c: C, d: D, e: E };
const NAMES = {
  a: 'A · displaced arm',
  b: 'B · weighted arm',
  c: 'C · ribbon',
  d: 'D · cut terminal',
  e: 'E · notch',
};

const page = (body, background) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{width:1000px;height:1000px;overflow:hidden;background:${background}}
svg{display:block}</style></head><body>
<svg width="1000" height="1000" viewBox="0 0 1000 1000">${body}</svg></body></html>`;

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir ?? ''}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});

const shot = new Map();

async function render(name, html) {
  const p = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await p.setContent(html, { waitUntil: 'load' });
  const buffer = await p.screenshot({ type: 'png' });
  await writeFile(`${OUT}/${name}`, buffer);
  shot.set(name, buffer);
  console.log(`  ${name}  1000x1000  ${(buffer.length / 1024).toFixed(0)} KB`);
  await p.close();
}

for (const [key, draw] of Object.entries(MARKS)) {
  await render(`x-mark-${key}-dark.png`, page(draw(WH, BK), BK));
  await render(`x-mark-${key}-light.png`, page(draw(INK, WH), WH));
}

/*
 * The sheet, at the sizes X actually renders.
 *
 * 400 is the profile page, 112 the hover card, 48 a reply, 32 the timeline.
 * Only the last two decide anything: a mark that works at 400 and dies at 32 is
 * a mark nobody sees working. Both timelines, because the same glyph that owns
 * a dark feed can vanish into a light one.
 */
const SIZES = [400, 112, 48, 32];
const row = (key, tone) => {
  const src = `data:image/png;base64,${shot.get(`x-mark-${key}-${tone}.png`).toString('base64')}`;
  return `<div class="r">
    <div class="lbl">${NAMES[key]}</div>
    <div class="set">${SIZES.map(
      (s) => `<div class="one"><img style="width:${s}px;height:${s}px" src="${src}">
        <span>${s}</span></div>`,
    ).join('')}</div>
  </div>`;
};

const sheet = (tone, bg, fg) => `
<section style="background:${bg};color:${fg}">
  <h3>${tone === 'dark' ? 'Dark timeline' : 'Light timeline'}</h3>
  ${Object.keys(MARKS)
    .map((k) => row(k, tone))
    .join('')}
</section>`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{width:1100px;font-family:Archivo,sans-serif}
section{padding:44px 48px 52px}
h3{font-size:15px;font-weight:700;letter-spacing:.02em;margin-bottom:6px}
.r{display:flex;align-items:center;gap:34px;padding:26px 0;border-top:1px solid rgba(127,127,127,.22)}
.lbl{width:190px;flex:none;font-family:'JetBrains Mono',monospace;font-size:12px;
  letter-spacing:.12em;text-transform:uppercase;opacity:.62}
.set{display:flex;align-items:center;gap:34px}
.one{display:flex;flex-direction:column;align-items:center;gap:9px}
/* Circular, because that is the only shape X ever shows this in. Judging a
   square render is judging a crop nobody receives. */
img{border-radius:50%;display:block}
.one span{font-family:'JetBrains Mono',monospace;font-size:10px;opacity:.45}
</style></head><body>
${sheet('dark', BK, WH)}
${sheet('light', WH, INK)}
</body></html>`;

const p = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await p.setContent(html, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
await writeFile(`${OUT}/x-mark-preview.png`, await p.screenshot({ type: 'png', fullPage: true }));
console.log('  x-mark-preview.png  contact sheet');

/*
 * The test that actually decides it: rendered at 32px, then magnified.
 *
 * The sheet above shows a 1000px master shrunk by the browser, which resamples
 * it into something smoother than a timeline ever produces. Rasterising at the
 * real size first and blowing the *pixels* up is the only way to see what
 * survives — a 4px stroke that lands across two pixel rows comes back grey, and
 * a taper whose tip is under a pixel comes back as nothing. Neither is visible
 * at any other magnification, and both are the whole question here.
 */
const tiny = new Map();
for (const [key, draw] of Object.entries(MARKS)) {
  for (const size of [32, 48]) {
    for (const [tone, ink, field] of [
      ['dark', WH, BK],
      ['light', INK, WH],
    ]) {
      const page32 = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{width:${size}px;height:${size}px;overflow:hidden;background:${field}}
        svg{display:block;width:${size}px;height:${size}px}</style></head><body>
        <svg viewBox="0 0 1000 1000">${draw(ink, field)}</svg></body></html>`;
      const pg = await browser.newPage({ viewport: { width: size, height: size } });
      await pg.setContent(page32, { waitUntil: 'load' });
      tiny.set(`${key}-${tone}-${size}`, await pg.screenshot({ type: 'png' }));
      await pg.close();
    }
  }
}

const zoomRow = (key, tone) =>
  `<div class="r"><div class="lbl">${NAMES[key]}</div><div class="set">${[32, 48]
    .map(
      (s) =>
        `<div class="one"><img class="px" style="width:${s * 7}px;height:${s * 7}px"
          src="data:image/png;base64,${tiny.get(`${key}-${tone}-${s}`).toString('base64')}">
          <span>${s}px, magnified 7&times;</span></div>`,
    )
    .join('')}</div></div>`;

const zoom = `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{width:1180px;font-family:Archivo,sans-serif;background:${BK};color:${WH}}
section{padding:44px 48px 52px}
h3{font-size:15px;font-weight:700;margin-bottom:2px}
h3 small{display:block;font-weight:400;font-size:12.5px;opacity:.6;margin-top:7px}
.r{display:flex;align-items:center;gap:34px;padding:30px 0;
  border-top:1px solid rgba(245,246,247,.14)}
.lbl{width:190px;flex:none;font-family:'JetBrains Mono',monospace;font-size:12px;
  letter-spacing:.12em;text-transform:uppercase;opacity:.62}
.set{display:flex;align-items:center;gap:46px}
.one{display:flex;flex-direction:column;align-items:center;gap:11px}
/* Nearest-neighbour, so the pixels the timeline gets are the pixels shown. Any
   smoothing here would paint over the exact defect this sheet exists to find. */
.px{image-rendering:pixelated;border-radius:50%;display:block}
.one span{font-family:'JetBrains Mono',monospace;font-size:10px;opacity:.45}
</style></head><body>
<section>
  <h3>Rasterised at the real size, then magnified
    <small>Dark timeline. Not a shrunk master — this is the pixel grid X hands a reader.</small></h3>
  ${Object.keys(MARKS)
    .map((k) => zoomRow(k, 'dark'))
    .join('')}
</section></body></html>`;

const pz = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await pz.setContent(zoom, { waitUntil: 'networkidle' });
await pz.evaluate(() => document.fonts.ready);
await pz.waitForTimeout(300);
await writeFile(`${OUT}/x-mark-pixels.png`, await pz.screenshot({ type: 'png', fullPage: true }));
console.log('  x-mark-pixels.png    32/48px truth sheet');

await browser.close();
