#!/usr/bin/env node
/**
 * Assembles the static site for upload.
 *
 *   node scripts/build-site.mjs
 *
 * Turns the flat prototypes into the directory layout that gives clean URLs on
 * any plain Apache or nginx host — no rewrite rules, no config. Upload the
 * contents of `dist/` into `public_html/` and every link in docs/url-scheme.md
 * resolves.
 *
 *   dist/index.html            ->  /
 *   dist/extractors/index.html ->  /extractors/
 *   dist/lead-time/index.html  ->  /lead-time/
 *   dist/app/index.html        ->  /app/
 */
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DESIGN = fileURLToPath(new URL('../docs/design', import.meta.url));
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const PAGES = [
  ['fillmark-landing.html', 'index.html'],
  ['fillmark-index.html', 'extractors/index.html'],
  ['fillmark-leadtime.html', 'lead-time/index.html'],
  ['fillmark-app.html', 'app/index.html'],
  ['404.html', '404.html'],
];

const ASSETS = ['robots.txt', 'sitemap.xml', 'favicon.svg'];

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

for (const [from, to] of PAGES) {
  const source = `${DESIGN}/${from}`;
  if (!existsSync(source)) {
    console.warn(`  skipped ${from} — not found`);
    continue;
  }
  const target = `${DIST}/${to}`;
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  await writeFile(target, await readFile(source, 'utf8'));
  console.log(`  ${to}`);
}

for (const asset of ASSETS) {
  if (!existsSync(`${DESIGN}/${asset}`)) {
    console.warn(`  skipped ${asset} — not found`);
    continue;
  }
  await cp(`${DESIGN}/${asset}`, `${DIST}/${asset}`);
  console.log(`  ${asset}`);
}

// OG cards are referenced from the site root by absolute URL.
if (existsSync(`${DESIGN}/og`)) {
  for (const card of await readdir(`${DESIGN}/og`)) {
    await cp(`${DESIGN}/og/${card}`, `${DIST}/${card}`);
    console.log(`  ${card}`);
  }
}

/**
 * Apache serves the 404 only when told to. One line, and it also stops the
 * server listing directories that have no index.
 */
await writeFile(
  `${DIST}/.htaccess`,
  `ErrorDocument 404 /404.html\nOptions -Indexes\n\n` +
    `# Long cache on immutable assets, none on the pages themselves.\n` +
    `<FilesMatch "\\.(png|svg|woff2)$">\n` +
    `  Header set Cache-Control "public, max-age=31536000, immutable"\n` +
    `</FilesMatch>\n`,
);
console.log('  .htaccess');

const walk = async (dir) => {
  let bytes = 0;
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      const sub = await walk(path);
      bytes += sub.bytes;
      count += sub.count;
    } else {
      bytes += (await stat(path)).size;
      count += 1;
    }
  }
  return { bytes, count };
};

const { bytes, count } = await walk(DIST);
console.log(`\n${count} files, ${(bytes / 1024).toFixed(0)} KB total, in dist/`);
console.log('Upload the contents of dist/ into public_html/ on the host.');
