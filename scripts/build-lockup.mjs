#!/usr/bin/env node
/**
 * The site's own lockup, exported as files.
 *
 *   node scripts/build-lockup.mjs
 *
 * Output: docs/design/logo/lockup-*.png and lockup-mark.svg
 *
 * This is not a new identity. It is the lockup already in the navigation of
 * every page — the same mark geometry `set-logo.mjs` writes, the same Archivo
 * at the same width axis, the same 0.74 gap-to-type ratio — rendered large
 * enough to use somewhere other than a 17px nav slot.
 *
 * Proportions are derived from the stylesheet rather than re-eyeballed, because
 * a lockup that is nearly the site's is worse than one that is obviously not:
 * it goes out on a deck beside a screenshot and the mismatch is the only thing
 * anybody sees. From `.logo` in `fillmark-landing.html`: mark 17px against
 * 13.5px type, gap 10px, weight 700 falling to 300 for MARK, letter-spacing
 * -.02em, width axis 108.
 *
 * Transparent is the one most people need and the one nobody ships. It goes
 * first in the list.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const OUT = fileURLToPath(new URL('../docs/design/logo', import.meta.url));

const BK = '#060607';
const WH = '#F5F6F7';
const G3 = '#7E858E';
const RD = '#E23B2E';
const INK = '#16181C';

/**
 * The mark, exactly as the favicon and every nav carry it.
 *
 * Copied rather than imported because `logo-marks.mjs` holds candidates on a
 * 24-unit grid and `set-logo.mjs` is what selects one; duplicating the selected
 * geometry here would drift the moment somebody runs `set-logo`. So this reads
 * the same three rects the built pages carry, and `verify` below fails the run
 * if the site has moved on without it.
 */
const MARK_RECTS = (grey) => `
  <rect x="6.5" y="5.5" width="3" height="14" fill="${grey}"/>
  <rect x="6.5" y="5.5" width="12" height="3" fill="${grey}"/>
  <rect x="6.5" y="11" width="8.5" height="3" fill="${RD}"/>`;

const markSvg = (grey) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
  `shape-rendering="crispEdges">${MARK_RECTS(grey)}</svg>`;

/**
 * Scale at which the real nav element is captured.
 *
 * The lockup is not rebuilt here, it is *photographed*. The first version of
 * this script derived the proportions from `.logo` by hand — mark 17px against
 * 13.5px type, gap 10px — and produced a lockup whose aspect ratio was 3.78
 * against the live nav's 4.88. Every number was copied correctly and the result
 * was still visibly looser, because a flex row's geometry is not the sum of the
 * values in its rule: the gap lands between the anonymous text item and the
 * `<i>` as well, the mark's glyph fills half its 24-unit box, and line-height
 * decides the height. Reimplementing a lockup means reimplementing all of that
 * and being wrong in a way that only shows up beside the real thing.
 *
 * So the page renders itself and the element is screenshotted at 20× device
 * pixels. Archivo is a variable font and the mark is three rectangles, so both
 * are resolution-independent; 20 puts the 105px nav lockup at 2100px, which is
 * past any deck or print use.
 */
const SCALE = 20;

/** Padding around the captured element, in CSS px at nav scale. */
const PAD = 14;

const LANDING = fileURLToPath(new URL('../docs/design/fillmark-landing.html', import.meta.url));

const markOnly = (background, grey) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${background}}
svg{display:block;width:1000px;height:1000px}</style></head><body>
<svg viewBox="0 0 24 24" shape-rendering="crispEdges">${MARK_RECTS(grey)}</svg>
</body></html>`;

/*
 * The lockup on the site, as bytes, so the export cannot quietly drift from it.
 *
 * A brand file that is nearly right is the expensive kind of wrong — it ships
 * on a deck next to a screenshot of the product and the mismatch is the only
 * thing anybody notices. This fails the run instead.
 */
const landing = fileURLToPath(new URL('../docs/design/fillmark-landing.html', import.meta.url));
const source = await (await import('node:fs/promises')).readFile(landing, 'utf8');
for (const rect of MARK_RECTS(G3).trim().split('\n')) {
  const needle = rect.trim();
  if (!source.includes(needle)) {
    throw new Error(
      `the lockup here no longer matches the site: ${needle}\n` +
        `run scripts/set-logo.mjs, then update MARK_RECTS in this file to match`,
    );
  }
}
console.log('  mark geometry matches the live nav');

const chromiumDir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'));
const executablePath = `/opt/pw-browsers/${chromiumDir ?? ''}/chrome-linux/chrome`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(existsSync(executablePath) ? { executablePath } : {}),
  args: ['--no-sandbox'],
});

/**
 * Captures the live `.logo` element, recoloured for the surface it is going on.
 *
 * `field` is the canvas behind it — null leaves it transparent. `wordmark`,
 * `tail` and `grey` recolour FILL, MARK and the mark's two grey rects; the red
 * arm never changes, on any surface.
 */
async function capture(name, { field, wordmark, tail, grey }) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 400 },
    deviceScaleFactor: SCALE,
  });
  await page.goto(`file://${LANDING}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  await page.addStyleTag({
    content: `
      /* The nav is sticky, sits over the hero, and carries its own near-black
         background plus a bottom rule. An element screenshot clips a hair wider
         than the box, so all three have to be neutralised or the capture comes
         back with a dark strip down one edge — which is what the light export
         shipped with before this line existed. */
      .nav{position:static !important;background:${field ?? 'transparent'} !important;
        border:0 !important;box-shadow:none !important}
      html,body{background:${field ?? 'transparent'} !important}
      .logo{padding:${PAD}px !important;background:${field ?? 'transparent'} !important;
        color:${wordmark} !important}
      .logo i{color:${tail} !important}
      /* Two of the mark's three rects are the grey; the red arm is the one that
         never moves, so it is matched by fill and left alone. */
      .logo .mark rect:not([fill="${RD}"]){fill:${grey} !important}`,
  });
  await page.waitForTimeout(200);

  const target = await page.$('.logo');
  const box = await target.boundingBox();
  const buffer = await target.screenshot({
    type: 'png',
    ...(field === null ? { omitBackground: true } : {}),
  });
  await writeFile(`${OUT}/${name}`, buffer);
  console.log(
    `  ${name.padEnd(30)} ${Math.round(box.width * SCALE)}x${Math.round(box.height * SCALE)}  ` +
      `${(buffer.length / 1024).toFixed(0)} KB`,
  );
  await page.close();
  return box;
}

// Transparent first: it is what a deck, a README and a sponsor slide all want,
// and it is the one an export usually forgets to produce.
const ref = await capture('lockup-transparent.png', {
  field: null,
  wordmark: WH,
  tail: G3,
  grey: G3,
});
await capture('lockup-transparent-ink.png', {
  field: null,
  wordmark: INK,
  tail: '#7E858E',
  grey: '#5C636B',
});
await capture('lockup-dark.png', { field: BK, wordmark: WH, tail: G3, grey: G3 });
await capture('lockup-light.png', { field: WH, wordmark: INK, tail: '#7E858E', grey: '#5C636B' });

/*
 * The mark on its own is a different problem and is safe to build here: it is
 * three rectangles on a 24-unit grid with no font and no flex row in it, so
 * there is nothing to get wrong by reimplementing.
 */
async function markPng(name, background, grey) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await page.setContent(markOnly(background, grey), { waitUntil: 'load' });
  const buffer = await page.screenshot({
    type: 'png',
    ...(background === 'transparent' ? { omitBackground: true } : {}),
  });
  await writeFile(`${OUT}/${name}`, buffer);
  console.log(`  ${name.padEnd(30)} 1000x1000  ${(buffer.length / 1024).toFixed(0)} KB`);
  await page.close();
}

await markPng('lockup-mark-transparent.png', 'transparent', G3);
await markPng('lockup-mark-dark.png', BK, G3);
await markPng('lockup-mark-light.png', WH, '#5C636B');

/*
 * The check the first version of this script needed and did not have.
 *
 * The whole point of capturing the live element is that the export cannot drift
 * from the site. Asserting it holds turns that from an intention into a
 * property: if the nav's aspect ratio and the export's ever diverge by more than
 * rounding, the run fails instead of shipping a lockup that is nearly right.
 */
const navPage = await browser.newPage({ viewport: { width: 1280, height: 400 } });
await navPage.goto(`file://${LANDING}`, { waitUntil: 'networkidle' });
await navPage.evaluate(() => document.fonts.ready);
const navBox = await (await navPage.$('.logo')).boundingBox();
await navPage.close();

const navRatio = navBox.width / navBox.height;
const exportRatio = (ref.width - PAD * 2) / (ref.height - PAD * 2);
if (Math.abs(navRatio - exportRatio) > 0.02) {
  throw new Error(
    `the export no longer matches the nav: ${exportRatio.toFixed(3)} against ${navRatio.toFixed(3)}`,
  );
}
console.log(`  lockup matches the live nav    ratio ${navRatio.toFixed(3)}`);

// The mark is three rectangles, so it has a real vector form. Ship it: a PNG
// wordmark is a raster of a licensed font, but the mark scales to a billboard.
await writeFile(`${OUT}/lockup-mark.svg`, `${markSvg(G3)}\n`);
console.log('  lockup-mark.svg                24x24 viewBox, scales anywhere');

await browser.close();
