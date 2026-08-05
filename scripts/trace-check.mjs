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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A GET that will wait as long as the trace takes.
 *
 * Not `fetch`: Node's gives up if response headers have not arrived within five
 * minutes, and a trace is allowed to run for as long as `API_TRACE_TIMEOUT_MS`
 * says — which an operator widens precisely when a wallet is deep enough to
 * need it. The client would then abort a request the server was still working
 * on and report it as "could not reach the API", which is the one thing this
 * script exists not to do: invent a fault in the half of the system that was
 * fine. The server's own timeout is the bound here, deliberately.
 */
function get(target) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) < 400, body });
      });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end();
  });
}

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
  response = await get(`${base}/v1/trace/${wallet}`);
} catch (error) {
  stderr.write(`could not reach ${base} — is the API running? (${String(error)})\n`);
  exit(1);
}

let body = null;
try {
  body = JSON.parse(response.body);
} catch {
  body = null;
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// A reply that is not JSON did not come from the trace API. Something in front
// of it answered instead, and saying "the trace failed" would send the reader
// looking in the wrong place entirely.
if (body === null && response.body !== '') {
  stderr.write(
    `HTTP ${response.status} after ${seconds}s, and the reply was not JSON — so it did not\n` +
      `come from the trace API. A proxy, CDN or host error page answered in its place:\n\n` +
      `${response.body.slice(0, 300)}\n`,
  );
  exit(1);
}

if (!response.ok || body === null) {
  stderr.write(`HTTP ${response.status} after ${seconds}s\n`);
  stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  /*
   * The body is deliberately vague about upstream failures: an RPC URL carries
   * its API key in the query string, and an error body is the classic place for
   * one to escape. The detail is in the service's own log instead, with the
   * provider's own words in it — so point at that rather than leaving the
   * reader with a sentence they cannot act on.
   */
  if (
    body?.error === 'upstream' ||
    body?.error === 'rpc_rate_limited' ||
    body?.error === 'rpc_rejected'
  ) {
    stderr.write(
      `\nThe status and the endpoint's own words are in the service log, not here:\n` +
        `  pm2 logs fillmark-api --lines 200 --nostream | grep -E "retrying RPC|trace failed"\n` +
        (body.error === 'rpc_rate_limited'
          ? `\nA 429 usually means SOLANA_RPC_MAX_RPS is above what the plan allows. A batch is\n` +
            `one HTTP request but N metered calls landing together, so a batch wider than the\n` +
            `per-second allowance is rejected however patiently the client spaced it.\n`
          : ''),
    );
  }
  exit(1);
}

const { coverage: c, totals: t } = body;
const usd = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
const row = (label, value) => stdout.write(`  ${label.padEnd(22)}${value}\n`);

/*
 * Whether the API answering is the build this script came from.
 *
 * A checkout and the process serving it are two different things, and `git
 * pull` moving one of them is not the same as a restart moving the other. A
 * stale service answers every question below with figures that predate the
 * fields being asked about, and the reading looks like a finding rather than
 * like an old binary. `coverage` is the contract, so its own shape is the
 * cheapest honest version marker there is.
 */
const EXPECTED_COVERAGE_FIELDS = ['swapsUnpriced', 'priceSeries', 'stoppedOnTimeBudget'];
const missingFields = EXPECTED_COVERAGE_FIELDS.filter((field) => !(field in (c ?? {})));
if (missingFields.length > 0) {
  stdout.write(
    `\n  ! The API answering ${base} predates this script.\n` +
      `    Its coverage block has no ${missingFields.join(', ')}, so it is running a build\n` +
      `    from before those were added. Everything below is that older build's reading.\n` +
      `    Rebuild and restart the service before trusting it:\n` +
      `      pnpm install && pnpm run build && pm2 restart fillmark-api --update-env\n`,
  );
}
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
  'swaps unpriced',
  `${c.swapsUnpriced ?? '—'}${c.poolSwapsUnpriced ? ` (${c.poolSwapsUnpriced} in pools)` : ''}`,
);
row(
  'price series',
  c.priceSeries
    ? `${c.priceSeries.minutes.toLocaleString('en-US')} minutes, ` +
        `${new Date(c.priceSeries.fromTs * 1000).toISOString().slice(0, 16)} → ` +
        new Date(c.priceSeries.toTs * 1000).toISOString().slice(0, 16)
    : 'none held',
);
row(
  'parse skips',
  Object.keys(c.parseSkips ?? {}).length === 0 ? 'none' : JSON.stringify(c.parseSkips),
);
row('transactions read', c.transactionsFetched.toLocaleString('en-US'));
row(
  'crawl stopped at',
  {
    end_of_history: 'end of history — nothing left unread',
    lookback_cutoff: `the ${c.lookbackDays}-day lookback — older history exists and was not read`,
    signature_budget: 'the signature budget — older history exists and was not read',
    time_budget: 'the clock — older history exists and was not read',
  }[c.crawlStoppedAt] ?? (c.historyTruncated ? 'a budget' : 'unknown (older API)'),
);
row(
  'stopped on clock',
  c.stoppedOnTimeBudget === true
    ? `yes — ${(c.transactionsUnread ?? 0).toLocaleString('en-US')} transactions unread`
    : 'no',
);
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
  /*
   * `no_losses` is the one verdict that can be arrived at rather than measured.
   * A position is only attributable with a complete basis, so anything excluded
   * as `unpriced` or `unknown_basis` was dropped before the loss test ran — and
   * when that is most of them, "none realising a loss" describes the exclusions,
   * not the wallet. A newer API returns `unpriced_history` for the extreme case;
   * this covers the partial one, and an older API that has no such status.
   */
  no_losses: () => {
    const dropped = Object.entries(c.excluded ?? {}).filter(([reason]) => reason !== 'not_a_loss');
    const lost = dropped.reduce((total, [, count]) => total + Number(count), 0);
    if (lost === 0 || t.positionsClosed === 0) {
      return `${t.positionsClosed} closed positions, none realising a loss we can stand behind.`;
    }
    return (
      `${t.positionsClosed} closed positions, but ${lost} were dropped before the loss test ran\n` +
      `(${dropped.map(([reason, count]) => `${reason} ${count}`).join(', ')}). "No losses" here\n` +
      `describes what was excluded, not what the wallet did.\n` +
      (Number(c.excluded?.unpriced ?? 0) > 0
        ? `  unpriced means the SOL/USD feed, not the wallet — check the API host can reach\n` +
          `  PYTH_BENCHMARKS_URL, then retry.`
        : `  unknown_basis means more was sold than was read as bought — see the census above.`)
    );
  },
  unreadable_history: () => {
    const head =
      `${sells} sells and ${buys} buys. A wallet cannot sell what it never bought, so the read\n` +
      `lost the entry legs. In order of likelihood, given what this trace measured:\n`;
    const causes = [];
    if (c.crawlStoppedAt === 'lookback_cutoff') {
      causes.push(
        `  1. The buys are older than the ${c.lookbackDays}-day window. The crawl stopped at the\n` +
          `     cutoff with history still behind it, and only ${c.transactionsFetched} transactions were\n` +
          `     read — raise TRACE_LOOKBACK_DAYS and try again before looking anywhere else.`,
      );
    } else if (c.crawlStoppedAt === 'signature_budget' || c.crawlStoppedAt === 'time_budget') {
      causes.push(
        `  1. The crawl ran out of ${c.crawlStoppedAt === 'time_budget' ? 'time' : 'budget'} before the ${c.lookbackDays}-day cutoff, so the\n` +
          `     older half of this wallet — most likely including the buys — was never read.`,
      );
    }
    if (c.foreignSwaps > 0) {
      causes.push(
        `  ${causes.length + 1}. ${c.foreignSwaps} swaps here were executed by another wallet. That is the bot\n` +
          `     signature — trace that address instead.`,
      );
    }
    causes.push(
      `  ${causes.length + 1}. The buys happened on a venue with no parser (${c.venues.join(', ')} only),\n` +
        `     or the tokens arrived by transfer rather than by purchase.`,
    );
    return head + causes.join('\n');
  },
  unpriced_history: () =>
    `${c.swapsUnpriced} swaps read, none of them priceable. Cost basis is a dollar figure, so\n` +
    `there is nothing to compute a loss from. This is the SOL/USD feed, not the wallet:\n` +
    `${
      c.priceSeries
        ? `the engine holds ${c.priceSeries.minutes.toLocaleString('en-US')} minutes and this ` +
          `wallet's trades fall outside them`
        : 'the engine holds no price history at all'
    }. Check PYTH_BENCHMARKS_URL is reachable from the API host and retry.`,
  no_attribution: () =>
    `Losses found, but every wallet selling into their windows was filtered out.`,
};

stdout.write(`\n${(VERDICTS[body.status] ?? (() => body.status))()}\n`);
for (const note of body.notes ?? []) stdout.write(`\n  - ${note}\n`);
stdout.write('\n');
