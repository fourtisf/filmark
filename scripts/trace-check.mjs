#!/usr/bin/env node
/**
 * Reads one wallet through a running trace API and explains the answer.
 *
 *   node scripts/trace-check.mjs <WALLET> [--url http://localhost:8080]
 *
 * `curl | grep` was the first thing to hand for this and it is a bad tool for
 * it: a refused address returns a body with none of the fields being grepped
 * for, so the pipeline prints nothing at all and an operator cannot tell a
 * rejection from a wallet with no history. Everything here is designed so that
 * silence is impossible — every outcome prints a sentence saying which outcome
 * it was and what to do about it.
 */
import { argv, exit, stderr, stdout } from 'node:process';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const args = argv.slice(2);
const urlFlag = args.indexOf('--url');
const base = (urlFlag === -1 ? 'http://localhost:8080' : (args[urlFlag + 1] ?? '')).replace(
  /\/+$/,
  '',
);
const wallet = args.find((a) => !a.startsWith('--') && a !== base);

if (wallet === undefined) {
  stderr.write('usage: node scripts/trace-check.mjs <WALLET> [--url http://localhost:8080]\n');
  exit(2);
}

// The placeholder problem, caught by name. A prompt that reads like an
// instruction is exactly what gets pasted verbatim.
if (!BASE58.test(wallet)) {
  stderr.write(
    `"${wallet}" is not a Solana address — 32 to 44 base58 characters, no 0, O, I or l.\n` +
      `If that was a placeholder, replace it with the address you actually want to trace.\n`,
  );
  exit(2);
}

const started = Date.now();
let response;
try {
  response = await fetch(`${base}/v1/trace/${wallet}`, { headers: { accept: 'application/json' } });
} catch (error) {
  stderr.write(`could not reach ${base} — is the API running? (${String(error)})\n`);
  exit(1);
}

const body = await response.json().catch(() => null);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (!response.ok || body === null) {
  stderr.write(`HTTP ${response.status} after ${seconds}s\n`);
  stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  exit(1);
}

const { coverage: c, totals: t } = body;
const usd = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
const row = (label, value) => stdout.write(`  ${label.padEnd(22)}${value}\n`);
// The response is unvalidated JSON, so every count is coerced rather than trusted.
const census = Object.entries(c.swapCensus ?? {});
const sideTotal = (suffix) => {
  let total = 0;
  for (const [key, count] of census) if (key.endsWith(suffix)) total += Number(count);
  return total;
};
const buys = sideTotal(':buy');
const sells = sideTotal(':sell');

stdout.write(`\n${wallet}\n  ${response.status} in ${seconds}s\n\n`);
row('status', body.status);
row('swaps read', census.length === 0 ? 'none' : census.map(([k, v]) => `${k} ${v}`).join('  '));
row("others' swaps", c.foreignSwaps);
row(
  'parse skips',
  Object.keys(c.parseSkips ?? {}).length === 0 ? 'none' : JSON.stringify(c.parseSkips),
);
row('transactions read', c.transactionsFetched.toLocaleString('en-US'));
row('history truncated', c.historyTruncated);
row('positions closed', t.positionsClosed);
row('excluded', Object.keys(c.excluded ?? {}).length === 0 ? 'none' : JSON.stringify(c.excluded));
row('realised PnL', usd(t.realisedPnlUsd));
row('attributed', usd(t.attributedUsd));
row('unattributed', usd(t.unattributedUsd));

/** What the operator should do next, which is the only reason to run this. */
const VERDICTS = {
  ok: () => `${t.counterparties} counterparties found. Nothing to fix.`,
  no_swaps: () =>
    c.foreignSwaps > 0
      ? `No swaps by this wallet, but ${c.foreignSwaps} by other wallets in its own transactions.\n` +
        `That is the signature of a bot: the venue names the bot's account as the trader, not the signer.`
      : `Nothing on ${c.venues.join(' or ')} in ${c.lookbackDays} days. Trades on any other venue are\n` +
        `invisible to this build — a gap in coverage, not a finding about the wallet.`,
  no_losses: () =>
    `${t.positionsClosed} closed positions, none realising a loss we can stand behind.`,
  unreadable_history: () =>
    `${sells} sells and ${buys} buys. A wallet cannot sell what it never bought, so the read lost\n` +
    `the entry legs. ${c.foreignSwaps} swaps here were executed by another wallet — if that is large,\n` +
    `trace that address instead. Otherwise the buys happened on a venue with no parser.`,
  no_attribution: () =>
    `Losses found, but every wallet selling into their windows was filtered out.`,
};

stdout.write(`\n${(VERDICTS[body.status] ?? (() => body.status))()}\n`);
for (const note of body.notes ?? []) stdout.write(`\n  - ${note}\n`);
stdout.write('\n');
