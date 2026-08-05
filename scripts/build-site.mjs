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

/**
 * Where the console sends its traces.
 *
 * The uploaded site is static files on a plain host; the scan runs in
 * `apps/api`, which is where the RPC key lives and where it stays. This is the
 * one value that connects the two, so it is a build input rather than something
 * edited into the HTML by hand and forgotten on the next build.
 *
 *   FILLMARK_API_URL=https://api.fillmark.xyz node scripts/build-site.mjs
 *
 * Left unset, the console ships with no engine and says so on every surface —
 * which is the correct behaviour, not a broken build.
 */
const API_URL = (process.env.FILLMARK_API_URL ?? '').trim().replace(/\/+$/, '');
if (API_URL !== '') {
  try {
    const parsed = new URL(API_URL);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      // A page served over https cannot call an http origin — the browser
      // blocks it as mixed content, and the console reports it as "the engine
      // did not answer". Failing here names the real problem.
      throw new Error('must be https (or localhost for local runs)');
    }
  } catch (error) {
    console.error(`FILLMARK_API_URL is not usable: ${error.message}`);
    process.exit(1);
  }
}

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
  await writeFile(target, withApiUrl(await readFile(source, 'utf8'), to));
  console.log(`  ${to}${to === 'app/index.html' && API_URL !== '' ? `  → ${API_URL}` : ''}`);
}

/**
 * Writes the API base URL into the console's meta tag.
 *
 * The tag is matched by name rather than by exact text, so reformatting the
 * page cannot silently stop this from applying and ship a console wired to
 * nothing.
 */
function withApiUrl(html, target) {
  if (target !== 'app/index.html' || API_URL === '') return html;

  const tag = /<meta\s+name="fillmark:api"\s+content="[^"]*"\s*\/?>/i;
  if (!tag.test(html)) {
    console.error('  app/index.html has no <meta name="fillmark:api"> to fill in');
    process.exit(1);
  }
  return html.replace(tag, `<meta name="fillmark:api" content="${API_URL}">`);
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
