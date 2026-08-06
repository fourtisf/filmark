# Fillmark

Solana counterparty forensics. Live at [fillmark.xyz](https://fillmark.xyz). The spec is [`docs/exitliquidity-handoff.md`](docs/exitliquidity-handoff.md); read it before this file.

**Two things run here.** The indexing pipeline is at P0: Pump.fun bonding curve
and PumpSwap swaps are streamed, backfilled and normalised into the `swaps`
table from §5. Alongside it, `apps/api` answers one wallet at a time by reading
the chain live — position accounting, window netting and attribution over a
scan it performs on request, with no index in front of it. That is what the
console at `/app/` calls when you paste an address.

The two share every stage below Stage 1. The pipeline is still what P1 onwards
is built on; the live path is what makes the product answerable today.

---

## What is here

| Package                | What it does                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/core`        | Types, on-chain constants, config, logging, metrics, raw-unit arithmetic                                   |
| `packages/solana`      | Provider-neutral transaction normalisation, instruction tree, Anchor CPI event extraction, JSON-RPC client |
| `packages/parsers`     | Pump.fun and PumpSwap swap parsers, plus byte-exact transaction fixtures                                   |
| `packages/clickhouse`  | Migrations, client, and the swap/checkpoint/price/mint repositories                                        |
| `packages/pricing`     | Pyth SOL/USD minute series and the quote-leg oracle                                                        |
| `packages/positions`   | FIFO lots, realised PnL and basis quality — §2 Stage 2                                                     |
| `packages/attribution` | Window netting and loss allocation — §2 Stages 3 and 4                                                     |
| `apps/ingest`          | Yellowstone consumer, BullMQ backfill worker, normalisation pipeline, CLI                                  |
| `apps/api`             | The trace API the console calls: live wallet scan, positions, attribution                                  |

Both ingest paths — the live stream and the RPC backfill — run through the same
`SwapPipeline` and the same `SwapWriter`. That is deliberate: the seam between
two differently-wired paths is exactly where a count discrepancy would hide.

## The trace API

`apps/api` is what makes the console answer. It holds the RPC credential, and it
is the only thing that does — the site is static files, so a key placed there
would be handed to every visitor.

```bash
cp .env.example .env         # set SOLANA_RPC_URL and API_CORS_ORIGINS
pnpm --filter @exitliquidity/api run dev     # or `run start` against dist/
curl localhost:8080/v1/trace/<WALLET> | jq .totals
```

| Route                   | What it is                                        |
| ----------------------- | ------------------------------------------------- |
| `GET /v1/trace/:wallet` | The trace, as JSON. Everything below happens here |
| `GET /healthz`          | Liveness                                          |
| `GET /readyz`           | Readiness                                         |
| `GET /metrics`          | Prometheus, including RPC calls spent             |

One request runs the whole spec in order:

1. **Scan** — `getSignaturesForAddress` back over `TRACE_LOOKBACK_DAYS`, then
   the transactions, through the same venue parsers the stream uses.
2. **Price** — Pyth SOL/USD minutes, cached across traces. Never off the pool.
3. **Positions** (§2 Stage 2) — FIFO lots per `(wallet, mint)`, realised PnL,
   and `unknown_basis` where more was sold than was ever bought.
4. **Windows** (Stage 3) — for each losing buy leg, the pool's own history is
   crawled around it and expanded by volume until it matches the buy.
5. **Allocation** (Stage 4) — the realised loss, split by window share.

**Every limit is in the response.** `coverage` carries the lookback, the venues
read, what was truncated and which pools could not be crawled far enough;
`totals.unattributedUsd` carries loss that no window explained. None of it is
folded into the headline figure, and the console prints all of it under the
number. That is §7.2 and §7.4, not decoration — see `TRACE_*` in `.env.example`
for the budgets that produce it.

**When a result looks wrong, ask the API and let it explain itself:**

```bash
node scripts/trace-check.mjs <WALLET>          # --url for a remote API
```

It prints the census, the skips and a sentence saying which of the six
outcomes happened and what to do about it. `curl | grep` is the wrong tool
here — a refused address returns a body with none of the fields being grepped
for, so the pipeline prints nothing and a rejection is indistinguishable from a
wallet with no history.

**Read `coverage.swapCensus` first.** It counts the
wallet's own swaps by venue and direction. Sells with no buys is not a wallet
that only ever sold — it is a read that lost the entry legs, and the trace
returns `unreadable_history` rather than a total. The usual cause is a trading
bot: both venues name the trader inside their own event, never the fee payer, so
entries placed through Axiom, Photon, BullX or Trojan land under the bot's
address. `coverage.foreignSwaps` counts exactly those, and a large value there
names the address worth tracing instead. See DECISIONS.md.

**Then `coverage.swapsUnpriced`.** Cost basis is a dollar figure, so a swap with
no price makes its position `unpriced`, and attribution drops every one of those.
A trace whose swaps were all unpriceable therefore _arrives_ at "nothing closed
in the red" — a statement about the wallet manufactured by an outage at Pyth. It
returns `unpriced_history` instead, and `coverage.priceSeries` says what minutes
the service actually holds. Nothing about the wallet has to change for this to
clear; retrying once the feed answers does it.

**And `coverage.stoppedOnTimeBudget`.** A trace is bounded twice: in RPC calls by
the `TRACE_*` ceilings, and in wall clock by `API_TRACE_TIMEOUT_MS`. The clock is
the one that moves when a provider throttles. When it is what ended the crawl the
trace still answers — with `transactionsUnread` saying what it did not reach —
rather than being cut off with nothing. If the flag is set on ordinary wallets,
the endpoint is slower than the budget assumes and raising the ceilings makes it
worse.

> **If anything proxies this API, keep `API_TRACE_TIMEOUT_MS` under the proxy's
> own response timeout** (Cloudflare's is 100s and not configurable below
> Enterprise). Past it the proxy answers with an HTML error page in place of the
> trace, which is not JSON and did not come from here; the console names that
> case separately rather than blaming the engine.

### More than one RPC endpoint

`SOLANA_RPC_URL` takes a comma-separated list, and usually should. A rate limit
belongs to a key, so two endpoints are two allowances that add up rather than
compete, and a key that exhausts its monthly credit mid-crawl takes its own
traffic down instead of the whole service. The client sends each call to
whichever endpoint can take it soonest, slows one that answers `429`, sets aside
one that answers `401`, and returns to both when they recover — all of it named
in the log, none of it in the response body, because the URL carries the key.

Every endpoint has to serve `getSignaturesForAddress` as deep as
`TRACE_LOOKBACK_DAYS`. A pruning endpoint does not error; it quietly shortens the
window, which `coverage.crawlStoppedAt` will report as `end_of_history`.

### Restarting it

A trace holds its socket open for as long as its RPC calls take, which is
minutes, so the service waits up to ten seconds on `SIGTERM` for the ones in
flight before it lets go. A process manager has to be told to allow that. PM2
kills 1.6 seconds after the signal by default, well inside a trace, so a deploy
during one takes it down and the browser that asked for it is told the engine
did not answer — a phantom fault, produced by the deploy rather than found by
it. Give it room:

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'fillmark-api',
      script: 'apps/api/dist/main.js',
      kill_timeout: 12000,
    },
  ],
};
```

The same applies while diagnosing: a restart cancels whatever is running, so let
a trace finish before deploying over it.

### Cost

A trace is hundreds of RPC calls and is billed as such. `SOLANA_RPC_MAX_RPS`
bounds the rate, `API_MAX_CONCURRENT_TRACES` bounds how many run at once, and
`API_CACHE_TTL_SEC` means a shared link is crawled once rather than once per
visitor. The `fillmark_api_rpc_*` counters are what the bill actually looks
like.

## Design prototypes

Static, in `docs/design/`. Open them straight from the filesystem — they have no
build step and no backend of their own. All four share one palette, one type
system and one accent colour, taken from the landing page, which §3 makes the
source of truth.

| File                        | Route          | What it is                                                |
| --------------------------- | -------------- | --------------------------------------------------------- |
| `fillmark-landing.html`     | `/`            | Marketing page. Design source of truth (§3)               |
| `fillmark-index.html`       | `/extractors/` | Extractor index — biggest takers, 7/30/90d                |
| `fillmark-leadtime.html`    | `/lead-time/`  | Lead-time radar, with the pump definition §8 asks for     |
| `fillmark-app.html`         | `/app/`        | Console: trace, pre-trade, file, watchlist, receipt, card |
| `404.html`                  | `/404.html`    | Not-found page                                            |
| `robots.txt`, `sitemap.xml` | —              | Crawl rules and the fixed routes                          |
| `logo/`, `og/`              | —              | Mark candidates and link-preview cards                    |

The two ranking pages take `?state=loading`, `?state=empty` and `?state=error`
so those states can be reviewed at all — otherwise the only one anybody ever
sees is the happy path.

Every text colour in all four pages clears WCAG AA (4.5:1); the audit that
proves it is described in `DECISIONS.md` under Design. The route table that P3
renders against is [`docs/url-scheme.md`](docs/url-scheme.md).

### Building the site

```bash
node scripts/build-logo-options.mjs   # render the mark candidates
node scripts/set-logo.mjs d           # apply one everywhere, including the favicon
node scripts/build-og-images.mjs      # regenerate the three link-preview cards

FILLMARK_API_URL=https://api.fillmark.xyz node scripts/build-site.mjs
```

`dist/` is a plain static site — no build step, no server config. Its directory
layout is what produces clean URLs on any Apache or nginx host; upload the
contents into `public_html/` and every route above resolves.

`FILLMARK_API_URL` is the one value connecting the static site to the engine. It
is written into `<meta name="fillmark:api">` in `/app/`, and the deployed API
must list the site's origin in `API_CORS_ORIGINS` or the browser will refuse the
call. Build without it and the console ships with no engine — which it says on
every surface rather than falling back to the demo figures.

Two things follow from that, and both are deliberate:

- The console never holds a key. It calls one URL; the credential stays server-side.
- With an engine configured, only the **Trace** tab carries real data. The other
  five are still drawn, and the page's banner now says which is which per tab
  rather than declaring the whole console fake. §7.4 takes the labels off only
  where something real is behind them.

The marks live in `scripts/logo-marks.mjs` and nowhere else, so changing the
identity is one word on the `set-logo` line.

The index and lead-time pages are the two surfaces §1 calls the acquisition
core — the only ones a first-time visitor can read without pasting anything —
and they are what P3 server-renders first.

Every figure in all four is demo data and labelled as such, with one exception:
the console's Trace tab, once `FILLMARK_API_URL` is set. Rule §7.4 — those
labels come off exactly where real data is behind them, and nowhere else.

## Getting started

```bash
pnpm install                # runs pnpm build afterwards, via prepare
cp .env.example .env        # then fill in YELLOWSTONE_ENDPOINT and SOLANA_RPC_URL
docker compose up -d        # ClickHouse on 8123, Redis on 6379
pnpm --filter @exitliquidity/ingest run cli migrate
```

The build is not optional and not a packaging step. Each workspace package is
resolved through its `exports` field, which points at `dist/`, so the CLI cannot
import `@exitliquidity/core` until that directory exists. `prepare` runs the
build for you after `pnpm install`; if you ever see

```
ERR_MODULE_NOT_FOUND … @exitliquidity/core/dist/index.js
```

it means the build was skipped — run `pnpm build` and try again.

The CLI loads that `.env` itself, searching upward from the working directory,
because `pnpm --filter` runs it from `apps/ingest` while the file lives at the
repository root. The path it used is printed to stderr on every run, so a
missing variable can always be told apart from an unread file. Anything already
exported wins over the file, and `ENV_FILE=/path/to/file` overrides the search
entirely — which is what a systemd unit wants.

Then either:

```bash
# Live: subscribe to both venue programs and write swaps as they land
pnpm --filter @exitliquidity/ingest run cli stream

# Historical: crawl one token's history through the same pipeline
pnpm --filter @exitliquidity/ingest run cli backfill <MINT> --days 7
```

### Checking P0

The acceptance criterion in §6 is that a known token's swap count matches
Dexscreener within 2%.

```bash
pnpm --filter @exitliquidity/ingest run cli backfill <MINT> --days 1
pnpm --filter @exitliquidity/ingest run cli verify-count <MINT> --hours 24
```

`verify-count` exits non-zero when the comparison fails, so it can gate CI. It
prints both counts, the per-venue split, and any parse skips in the window — a
shortfall comes with a list of places to look rather than just a number.

Two things it is honest about, because a comparison that quietly measures
different things is worse than none:

- Dexscreener counts **transactions**; we count **swap instructions**. A router
  filling one order across three pump.fun calls is one transaction and three
  swaps. The comparison uses our distinct-signature count and prints the
  instruction count beside it.
- Dexscreener's `h24` is a rolling window ending at its own last update, not
  ours. A small difference near the boundary is expected, and is why the
  tolerance is 2% rather than zero.

### When a backfill misbehaves

Run the CLI directly rather than through `pnpm --filter`. pnpm spawns a shell that
does not `exec` away, so on Ctrl+C it reports `Command failed with signal "SIGINT"`
and the process's real exit code never surfaces — including a clean `0`.

```bash
node --import tsx apps/ingest/src/cli.ts backfill <MINT> --days 1 --max 5; echo "exit=$?"
```

`--max` caps transactions fetched, so `--max 5` is five `getTransaction` calls and
finishes in seconds even at one request per second. A backfill prints
`backfill fetch progress` every 25 transactions; silence for minutes means the
process is not doing what you asked.

Exit codes: `0` success, `1` failure, `78` bad configuration, `130` interrupted.

Every error carries its cause chain, so an upstream failure reads as
`RPC getTransaction failed: fetch failed: read ECONNRESET` rather than the wrapper
alone, and an HTTP error carries the provider's response body and `Retry-After`
beside the status. If a run is ever hard to diagnose from its output, that is a
bug in the logging and worth fixing before the thing it was hiding.

**Before trusting any of this against mainnet, work through
[`docs/verification.md`](docs/verification.md).** Every program constant in this
repo is derived or documented rather than observed, and that document says
exactly which ones need a real transaction held up against them.

## CLI

```
migrate                Create the database and apply pending migrations
stream                 Run the Yellowstone gRPC consumer until interrupted
backfill <address>     Crawl an account's history through the same pipeline
enqueue <address>      Queue a backfill for the worker to pick up
worker                 Run the BullMQ backfill worker
prices                 Fill the SOL/USD 1-minute series from Pyth
verify-count <mint>    Compare our swap count against Dexscreener
dump-tx <signature>    Decode one transaction and print what the parsers saw
```

`dump-tx` is the tool for the verification document: point it at a known
transaction and every decoded field is printed next to what the explorer says.

Backfilling by **mint** covers every venue that token traded on, because both P0
programs name the mint in their account list. That is what makes one command
enough to check a token that has migrated from the bonding curve to the AMM.

## Development

```bash
pnpm check          # format, lint, typecheck, test
pnpm test           # 301 unit tests, no infrastructure required
pnpm build          # tsc -b across the workspace
```

The unit suite needs nothing running. Schema behaviour that only a real server
can show — 64-bit precision, deduplication before merge, null handling — lives
in `packages/clickhouse/src/integration.test.ts` and is skipped unless a server
is pointed at. **Those ten are the only place the migrations are ever executed**,
so a green `pnpm check` says nothing about whether the DDL is valid:

```bash
docker compose up -d clickhouse
CLICKHOUSE_TEST_URL=http://localhost:8123 pnpm test
```

Parser tests build transactions byte-for-byte with the same encoders the
programs use, so a decoder that drifts from a layout fails in the test suite
rather than against a live token.

## Operations

`stream` and `worker` serve `/metrics`, `/healthz` and `/readyz` on
`METRICS_PORT` (9464). Liveness and readiness are separate: a consumer
reconnecting to a dropped geyser stream is alive and should not be restarted,
but it is not ingesting and should not be counted as ready.

The metric that matters most is `exitliquidity_dropped_total`. Every path that
discards a swap increments it with a reason label, and a non-zero value is a
number that has to be explainable before the P0 count means anything.
`exitliquidity_parse_failures_total` and the `ingest_skips` table cover the same
ground for instructions that matched a venue but produced no row.

## Conventions worth knowing before reading the code

- **Amounts are `bigint` end to end.** They become `number` only when a USD
  figure is produced. `UInt64` columns are sent to ClickHouse as strings,
  because JSON numbers are doubles and a 6-decimal token amount routinely
  exceeds what one holds exactly.
- **`quote_amount` is the pool leg on every venue** — quote tokens in or out of
  the pool, fees excluded. `quote_fee_amount` carries the fee separately and is
  `NULL` for _unknown_, never for zero.
- **`usd_value` is `NULL` when nothing could price it.** Spec §7.4: no
  fabricated numbers. An unpriced swap is still written, because it is still a
  swap and still counts.
- **Prices never come from a pool.** Spec §2 Stage 1. Two sources only: a dollar
  stablecoin at its peg, and SOL from the Pyth minute series.
- **Failed transactions are dropped.** They moved no tokens.

Decisions that depart from the spec sketch, and why, are in
[`DECISIONS.md`](DECISIONS.md).
