/**
 * The candidate marks, and nothing else.
 *
 * Data only, deliberately: build-logo-options.mjs renders them, set-logo.mjs
 * applies one, and build-og-images.mjs draws the current one. None of those
 * should launch a browser just because another imported it.
 *
 * Every mark is a 24x24 viewBox built from rectangles — §3 allows no radius,
 * no gradient and one accent, and rectangles stay crisp at favicon size.
 */
/** The mark currently in use. Rewritten by scripts/set-logo.mjs. */
export const CURRENT = 'e';

const RD = '#E23B2E';
const G = '#7E858E';

export const MARKS = {
  a: {
    name: 'Notch',
    idea: 'A fill leaves a mark on the tape. One rule, one notch dropped through it.',
    svg: `<rect x="1" y="10.5" width="22" height="2" fill="${G}"/>
          <rect x="8" y="10.5" width="3.5" height="11" fill="${RD}"/>`,
  },
  b: {
    name: 'Two sides',
    idea: 'Your buy and their sell, same window, different size. The specimen on the landing page, compressed.',
    svg: `<rect x="4" y="3" width="4.5" height="18" fill="${G}"/>
          <rect x="15.5" y="8" width="4.5" height="13" fill="${RD}"/>`,
  },
  c: {
    name: 'Window',
    idea: 'Every attributed row ships with its window. The two rules are the bounds; the block is what landed inside.',
    svg: `<rect x="2" y="3" width="2" height="18" fill="${G}"/>
          <rect x="20" y="3" width="2" height="18" fill="${G}"/>
          <rect x="9.5" y="8.5" width="5" height="7" fill="${RD}"/>`,
  },
  d: {
    name: 'Crosshair',
    idea: 'A point on the tape, marked. Reads as forensics rather than finance.',
    svg: `<rect x="11" y="1" width="2" height="22" fill="${G}"/>
          <rect x="1" y="11" width="22" height="2" fill="${G}"/>
          <rect x="8.5" y="8.5" width="7" height="7" fill="${RD}"/>`,
  },
  e: {
    name: 'Ledger',
    idea: 'Three rows, one of them yours. The most literal reading of the product.',
    svg: `<rect x="2" y="5" width="20" height="2" fill="${G}"/>
          <rect x="2" y="11" width="11" height="2" fill="${RD}"/>
          <rect x="2" y="17" width="20" height="2" fill="${G}"/>`,
  },
  f: {
    name: 'Cross',
    idea: 'The moment your buy crossed their sell. One stroke through the line.',
    svg: `<rect x="1" y="11" width="22" height="2" fill="${G}"/>
          <rect x="10.5" y="2" width="3" height="20" fill="${RD}" transform="rotate(38 12 12)"/>`,
  },
};
