# Decisions

Where this repository departs from the handoff spec, and why. Everything not
listed here follows §2–§6 as written.

Four of these need a call from ALFA; they are listed at the end.

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

## The trace API

### A trace reads the chain on request instead of querying an index

§4 assumes every surface reads aggregates that ingest has already built. That is
right for the public pages — thousands of them, server-rendered, cached — and it
is wrong for the one surface people arrive at with an address in the clipboard.
Indexing enough of Solana to answer an arbitrary wallet is a continuous cost
paid before anybody asks; answering one wallet is a few hundred RPC calls paid
only when they do.

So `apps/api` performs the scan itself. Everything below Stage 1 is the same
code the pipeline will use: the same parsers, the same oracle, the same FIFO
accounting, the same netting. Only the source of the swaps differs.

This is a genuine departure and it has a cost. A trace takes tens of seconds
rather than milliseconds, and it cannot answer questions that need the whole
chain — the extractor index and the lead-time radar still need ingest. It is a
way to make the console answerable now, not a replacement for §4.

### Every budget has a matching field in the response

A wallet with a million signatures cannot be read inside one HTTP request, and a
pool filling every block cannot be crawled back three months. Both are bounded
(`TRACE_MAX_*`), and every bound reports itself: `historyTruncated`,
`poolsIncomplete`, `legsSkipped`, `positionsAttributed` against
`losingPositions`.

The alternative — silently returning what fitted — is the §7.4 failure wearing a
different hat. A partial read presented as a whole one is a fabricated figure
even though every number in it was measured.

### Unexplained loss is reported, never redistributed

When a buy leg's window yields no eligible counterparty, its share of the loss
lands in `totals.unattributedUsd`. Spreading it over the counterparties that
were found would keep the headline figure equal to the realised loss, which
looks tidier and is a lie: it would inflate specific named wallets by an amount
nothing measured about them.

### Position accounting names two failures §2 does not

§2 Stage 2 names `unknown_basis` — tokens that arrived by transfer. Two more
produce the same consequence and are tracked separately so a trace can say which
happened:

- `unpriced` — a contributing leg had no SOL/USD minute in range.
- Sells with no lot behind them also cover a wallet that bought on a venue with
  no parser. Indistinguishable from a transfer here, and excluded either way.

All three are excluded from attribution, as §2 requires of the first.

### The exclusion list ships empty

§2 Stage 3 step 3 excludes CEX hot wallets, routers, aggregator vaults, and the
buyer's funding cluster. Clustering is §2 Stage 6 and has not been built, and
seeding a hardcoded list of addresses nobody in this repository has verified
would be a fabricated exclusion — the same problem as a fabricated figure, one
step upstream.

What does run: the buyer's own wallet, the net-vs-gross round-trip filter that
§8 calls the main defence, and anything the caller passes in. LP operations never
appear because the parsers emit swaps only. `excludedWallets` is the seam the
cluster work plugs into.

### Net-to-gross is measured in tokens, not dollars

§2 says "net position change", which is a quantity. Computing the ratio from USD
would make it move with the price inside the window, so a bot that bought and
sold the same number of tokens across a run-up would read as a distributor.

### `SolanaRpcClient` gained a generic `call`

The client was written to cover "exactly what backfill needs". Token symbols
come from a provider extension (Helius's DAS) that only some endpoints serve.
The alternative to opening the transport was a second HTTP path with its own
retries and its own share of the rate limit, pointed at the same key — which is
how a shared key gets exhausted. The typed methods remain the supported surface.

Symbols are display only. A symbol is metadata the deployer wrote; it is not
unique and it is not evidence, which is why every surface showing one shows the
mint beside it, and why the resolver degrades to mint addresses in silence.

### The console's demo data is now reachable only without an engine

§7.4 says the demo labels come off when real data is behind them. With
`FILLMARK_API_URL` set that is true of one tab and five drawn ones, so the
banner reports per tab instead of declaring the whole page fake — a blanket
"nothing here is real" over a live trace is as wrong as no label at all.

The two "try" addresses are removed when an engine is configured: they are
invented, and an invented address run through a real scan comes back empty,
which reads as a broken engine rather than as a fabricated example.

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

## Design

### The palette's two dimmest greys were raised

§3 fixes the grey ramp at `#A3A9B0 / #6B727A / #464C53`. Measured against the
`#060607` background:

| Step   | Was       | Ratio        | Now       | Ratio    |
| ------ | --------- | ------------ | --------- | -------- |
| `--g1` | `#A3A9B0` | 8.54 : 1     | unchanged | 8.54 : 1 |
| `--g2` | `#6B727A` | **4.16 : 1** | `#949BA4` | 7.22 : 1 |
| `--g3` | `#464C53` | **2.33 : 1** | `#7E858E` | 5.43 : 1 |
| `--g4` | —         | —            | `#464C53` | 2.33 : 1 |

WCAG AA wants 4.5:1 for text this size. The old `#464C53` sat at barely half
that and carried every eyebrow, caption, table head and unit label — the parts
that tell a reader what a number means. Across the four prototypes that was 58
failing text nodes.

The original darkest value survives as `--g4`, restricted to hairlines and
markers, which are not text and have no contrast requirement. All four pages
now measure zero failures.

**This changes the design source of truth, so it is ALFA's to accept or
reject.** It is one line in `:root` per file to revert.

### Accent buttons carry near-black text, not white

White on `--rd` measures 4.29:1 — under AA. The obvious fix, darkening the red,
breaks the other direction: the accent also has to work as _text_ on the
background for loss figures, where `#E23B2E` currently gives 4.72:1 and any
darker value fails.

One accent cannot do both with white. Near-black on red clears at 4.72:1 and
keeps §3's single-accent rule intact.

### The window belongs in the path, not a query string

The extractor index has three windows. As `?w=30` they are one URL to a
crawler, which splits the ranking signal for a page that §4 makes the whole
acquisition strategy. Production serves `/index/7d`, `/index/30d`,
`/index/90d`; the prototype pushes a real history entry and moves its canonical
tag to match, so the intent is visible rather than described.

The full route table, including why `/trace/` is `noindex` and what floor a
generated page has to clear, is in [`docs/url-scheme.md`](docs/url-scheme.md).

---

## Open — need a call before P1

1. **Pump.fun fee decoding.** Blocks the P1 reconciliation gate, as above. Needs
   a real `TradeEvent` to confirm the trailing field layout.
2. **Backfill depth at launch.** `BACKFILL_DEFAULT_DAYS` is 90, matching the §8
   assumption. It has not been costed against a real RPC provider's pricing.
3. **What to do with unpriced rows.** They are written and flagged today. If a
   material share of a token's history lands unpriced, P1 has to decide whether
   to exclude those positions from attribution the way §2 Stage 2 excludes
   `unknown_basis` positions, or to widen the staleness bound. The trace API
   already takes the strict reading and excludes them; that choice should be
   made once, for both paths.

4. **The raised palette.** See Design above. Zero contrast failures now, but it
   amends §3, which is ALFA's document.

5. **τ and the volume cap have not been calibrated.** §8 asks for tuning against
   hand-checked cases and budgets real time for it. The defaults shipped are the
   spec's suggested values — τ = 150 slots, ±10 minutes, 20% net-to-gross — and
   they are configurable, but nobody has yet held one trace up against a
   hand-read transaction log. Until that happens the attribution is structurally
   correct and numerically unvalidated. That is the P2 acceptance criterion, and
   it is not met.

Also unresolved from §9, and untouched here: pricing, and whether public pages
carry Fourtis.io cross-links. Neither affects P0.
