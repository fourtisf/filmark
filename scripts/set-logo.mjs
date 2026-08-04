#!/usr/bin/env node
/**
 * Applies one of the candidate marks across every surface at once.
 *
 *   node scripts/set-logo.mjs d
 *
 * Touches the four pages, the 404, the favicon and the OG cards. The marks
 * live in logo-marks.mjs so there is exactly one definition of each,
 * and swapping is a one-word decision rather than a find-and-replace.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MARKS } from './logo-marks.mjs';

const DESIGN = fileURLToPath(new URL('../docs/design', import.meta.url));

const key = (process.argv[2] ?? '').toLowerCase();
if (!Object.hasOwn(MARKS, key)) {
  console.error(`Pick one of: ${Object.keys(MARKS).join(', ')}`);
  console.error(
    Object.entries(MARKS)
      .map(([k, m]) => `  ${k}  ${m.name} — ${m.idea}`)
      .join('\n'),
  );
  process.exit(1);
}

const inline = MARKS[key].svg.replace(/\s+/g, ' ').trim();

const LOGO =
  `<!--LOGO--><svg class="mark" viewBox="0 0 24 24" aria-hidden="true" ` +
  `shape-rendering="crispEdges">${inline}</svg><!--/LOGO-->`;

// The favicon needs the page background painted in; a transparent mark
// disappears against a light browser chrome.
const FAVICON =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">` +
  `<rect width="24" height="24" fill="#060607"/>${inline}</svg>\n`;

const pages = (await readdir(DESIGN)).filter((f) => f.endsWith('.html'));
let touched = 0;

for (const file of pages) {
  const path = `${DESIGN}/${file}`;
  const before = await readFile(path, 'utf8');
  const after = before.replace(/<!--LOGO-->[\s\S]*?<!--\/LOGO-->/g, LOGO);
  if (after !== before) {
    await writeFile(path, after);
    touched += 1;
    console.log(`  ${file}`);
  }
}

await writeFile(`${DESIGN}/favicon.svg`, FAVICON);
console.log('  favicon.svg');

console.log(`\nMark ${key.toUpperCase()} (${MARKS[key].name}) applied to ${touched} pages.`);
console.log('Run  node scripts/build-og-images.mjs  then  node scripts/build-site.mjs');
