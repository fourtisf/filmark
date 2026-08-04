# Fillmark

Solana counterparty forensics. Live at [fillmark.xyz](https://fillmark.xyz). The spec is [`docs/exitliquidity-handoff.md`](docs/exitliquidity-handoff.md); read it before this file.

**This repository is at P0: swap ingest.** Pump.fun bonding curve and PumpSwap
swaps are streamed, backfilled and normalised into the `swaps` table from §5.
Nothing downstream of that exists yet — no position accounting, no attribution,
and no application beyond the static design prototypes in `docs/design/`. P1 is
a hard gate and has not been started.

---

## What is here

| Package               | What it does                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/core`       | Types, on-chain constants, config, logging, metrics, raw-unit arithmetic                                   |
| `packages/solana`     | Provider-neutral transaction normalisation, instruction tree, Anchor CPI event extraction, JSON-RPC client |
| `packages/parsers`    | Pump.fun and PumpSwap swap parsers, plus byte-exact transaction fixtures                                   |
| `packages/clickhouse` | Migrations, client, and the swap/checkpoint/price/mint repositories                                        |
| `packages/pricing`    | Pyth SOL/USD minute series and the quote-leg oracle                                                        |
| `apps/ingest`         | Yellowstone consumer, BullMQ backfill worker, normalisation pipeline, CLI                                  |

Both ingest paths — the live stream and the RPC backfill — run through the same
`SwapPipeline` and the same `SwapWriter`. That is deliberate: the seam between
two differently-wired paths is exactly where a count discrepancy would hide.

## Design prototypes

Static, in `docs/design/`. Open them straight from the filesystem — they have no
build step and no backend. All four share one palette, one type system and one
accent colour, taken from the landing page, which §3 makes the source of truth.

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
node scripts/build-site.mjs           # assemble dist/
```

`dist/` is a plain static site — no build step, no server config. Its directory
layout is what produces clean URLs on any Apache or nginx host; upload the
contents into `public_html/` and every route above resolves.

The marks live in `scripts/logo-marks.mjs` and nowhere else, so changing the
identity is one word on the `set-logo` line.

The index and lead-time pages are the two surfaces §1 calls the acquisition
core — the only ones a first-time visitor can read without pasting anything —
and they are what P3 server-renders first.

Every figure in all four is demo data and labelled as such. Rule §7.4: those
labels come off only when real data is behind them.

## Getting started

```bash
pnpm install
cp .env.example .env        # then fill in YELLOWSTONE_ENDPOINT and SOLANA_RPC_URL
docker compose up -d        # ClickHouse on 8123, Redis on 6379
pnpm --filter @exitliquidity/ingest run cli migrate
```

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
pnpm test           # 196 unit tests, no infrastructure required
pnpm build          # tsc -b across the workspace
```

The unit suite needs nothing running. Schema behaviour that only a real server
can show — 64-bit precision, deduplication before merge, null handling — lives
in `packages/clickhouse/src/integration.test.ts` and is skipped unless a server
is pointed at:

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
