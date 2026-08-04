# Decisions

Where this repository departs from the handoff spec, and why. Everything not
listed here follows §2–§6 as written.

Three of these need a call from ALFA before P1; they are marked **open**.

---

## Schema

### `swaps` is a `ReplacingMergeTree`, not a `MergeTree`

§5 sketches `ENGINE = MergeTree`. Backfill and the live stream overlap by
design, and a stream restart replays the tail from its checkpoint, so the same
swap arrives more than once. Deduplication has to happen somewhere; on the sort
key is cheaper than in the writer, and it means the two ingest paths can be run
against the same token without coordination.

Consequence: `count()` overstates until parts merge. Every count in this repo
uses `uniqExact((signature, ix_index, inner_ix_index))` instead, so the P0
acceptance test does not depend on background merge timing.

### The sort key is longer than `(mint, slot)`

`ORDER BY (mint, slot, signature, ix_index, inner_ix_index)`.

One transaction can contain several swaps — routers batch them — so nothing
shorter identifies a row, and a `ReplacingMergeTree` would collapse genuinely
distinct swaps into one. The `(mint, slot)` prefix §5 asked for is preserved, so
range scans by token are unaffected.

### Columns added beyond the §5 sketch

| Column                            | Why                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ix_index`, `inner_ix_index`      | Row identity, per above                                                                                 |
| `venue`                           | `pumpfun` and `pumpswap` are one token's history split across two programs; attribution has to see both |
| `base_decimals`, `quote_decimals` | Stored beside the raw amounts so a reader never joins to interpret a number                             |
| `quote_fee_amount`                | See below                                                                                               |
| `usd_price_source`                | A bad price is traceable to the thing that produced it                                                  |
| `ingest_source`                   | Lets stream and backfill be reconciled against each other                                               |
| `ingested_at`                     | The `ReplacingMergeTree` version column                                                                 |

### `quote_amount` is always the pool leg

Quote tokens into or out of the pool, fees excluded, on every venue. §3
window-netting nets pool volume, so the column has to mean the same thing
everywhere.

The trader's own cash flow — which is what §2 Stage 2 cost basis needs — is
`quote_amount + quote_fee_amount` on a buy and `quote_amount - quote_fee_amount`
on a sell.

`quote_fee_amount` is nullable and **null means unknown, never zero**. For
PumpSwap it is derived as the gap between the pool leg and the trader's leg,
which captures every fee the program charges. For the pump.fun bonding curve it
is null: the fee sits outside `sol_amount` and the event fields carrying it were
added after the ones P0 decodes.

**This is a P1 blocker.** Position accounting cannot reconcile against a PnL
tracker within 5% while a ~1% fee is unknown on every bonding curve trade.
Decoding it is the first task of P1. See `docs/verification.md` §3.

### Postgres is not set up yet

§4 assigns Postgres to users, subscriptions, watchlists and cached aggregates.
P0 has none of those. Ingest checkpoints, the SOL/USD series and the mint
decimals cache all live in ClickHouse instead — they are operational state, not
user-facing state, and standing up a second database to hold three small tables
would be premature.

Postgres arrives with P7.

---

## Ingest

### Events are read, not instruction arguments

Both parsers decode the Anchor event a swap emits rather than the arguments it
was called with. The arguments are the trader's _request_ — a buy names the
tokens wanted and the maximum SOL it will spend, neither of which is what
happened. The event carries what settled.

This also means a swap that reverted inside an otherwise-successful transaction
produces no row, which is correct.

### Events are matched to their own invocation, not by ordering

The instruction tree is rebuilt from stack heights, and a parser looks for its
event among a node's direct children. Matching by position in the flat inner
list pairs the wrong ones together the moment a router batches several swaps
into one transaction, which is routine on pump.fun.

Validators before v1.14.6 omit stack height. There, inner instructions are
attributed to their top-level parent — flatter than reality, but never wrong
about which top-level instruction they belong to.

### Block time comes from the event, with block-meta as a cross-check

Yellowstone transaction updates carry no block time; only block-meta updates do,
and at `confirmed` commitment those usually arrive after the slot's
transactions. Both P0 venues stamp their events from the same on-chain clock the
block time comes from, so the event's timestamp is used and is not an
approximation.

`blocksMeta` is still subscribed, because a future venue whose events carry no
timestamp would depend on it entirely.

### The subscription filters on `accountInclude`, not the top-level program

A large share of pump.fun volume arrives through aggregators, where the venue
program is an inner instruction. Filtering on the top-level program would miss
all of it — and would fail the P0 count by a wide, confusing margin.

### A swap with unresolvable decimals is dropped

Decimals are taken from the transaction, then a cache, then ClickHouse, then
RPC. If all four fail, the row is dropped and counted rather than assumed to be
a six-decimal token. A wrong exponent is a thousand-fold error in every
downstream dollar figure, and unlike a missing row it is not obviously wrong
when you look at it.

### Backfill crawls by mint

`getSignaturesForAddress(mint)` returns transactions naming that mint, which
both P0 programs do. One command therefore covers a token's whole history
across the bonding curve and the AMM — which is exactly the shape the P0
acceptance test needs.

---

## Pricing

### Pyth Benchmarks for history, Hermes for live

Benchmarks returns bars in bulk; a 90-day backfill from Hermes would be about
130,000 single-minute requests. Hermes returns the current price, which
Benchmarks lags by a minute or so, leaving freshly streamed swaps unpriced.

The series is stored in ClickHouse rather than fetched on demand so pricing is
reproducible: a swap re-ingested months later gets the same USD figure it got
the first time, which is what makes a P1 reconciliation mean anything.

### A swap outside the price series is written unpriced

`usd_value` is null, `usd_price_source` is `none`, and a counter fires. It is
still a real swap and still counts towards the P0 comparison; only the dollar
column is unknown. §7.4 forbids the alternative.

### Nearest minute in either direction, within a bound

Pyth drops bars. On a quiet minute the _next_ bar is a better estimate of the
price at that instant than one several minutes stale. Beyond
`PRICE_MAX_STALENESS_SEC` (default 300) nothing is returned at all.

---

## Open — need a call before P1

1. **Pump.fun fee decoding.** Blocks the P1 reconciliation gate, as above. Needs
   a real `TradeEvent` to confirm the trailing field layout.
2. **Backfill depth at launch.** `BACKFILL_DEFAULT_DAYS` is 90, matching the §8
   assumption. It has not been costed against a real RPC provider's pricing.
3. **What to do with unpriced rows.** They are written and flagged today. If a
   material share of a token's history lands unpriced, P1 has to decide whether
   to exclude those positions from attribution the way §2 Stage 2 excludes
   `unknown_basis` positions, or to widen the staleness bound.

Also unresolved from §9, and untouched here: pricing, and whether public pages
carry Fourtis.io cross-links. Neither affects P0.
