# ExitLiquidity — Engineering Handoff v2

**For:** Michael (@MichaelCoinsult)
**From:** ALFA
**Design source of truth:** `exitliquidity-landing.html`
**Interaction reference:** `exitliquidity-app.html`
**Status:** design approved · backend unbuilt

> **Read this first.** The landing page is the design source of truth — palette, type, spacing, component patterns. The app prototype is correct for *interaction logic* (flow diagram, ledger hover linkage, gated surfaces) but its palette is from an earlier round. Where the two disagree, the landing wins.

---

## 1. What this is

A Solana forensics product answering one question no existing tool answers: **when you closed a position at a loss, which wallets were on the other side of it.**

Rug checkers warn you after the fact. PnL trackers measure the hole. ExitLiquidity names the counterparties, ranks them by dollars, and then keeps watching them.

Twelve surfaces, one engine.

### Look backward
| Surface | Tier | What it does |
|---|---|---|
| Wallet trace | Free | Paste a wallet → flow diagram + ranked counterparty ledger |
| Extractor file | Pro | Reverse lookup on a counterparty: victims, lead time, pools, cluster |
| Cluster map | Pro | Collapse many wallets run by one operator into a single entity |

### Look forward
| Surface | Tier | What it does |
|---|---|---|
| **Pre-trade check** | Pro | Paste a token → are any of *your* counterparties in this pool right now |
| Distribution alerts | Pro | Watches tokens you currently hold; fires when a top holder starts tranching out |
| Watchlist | Pro | Pin counterparties, Telegram push when they open a position |

### Public pages
| Surface | Tier | What it does |
|---|---|---|
| Token receipt | Free | One indexable page per token: who funded whom, net transfer |
| Extractor index | Free | Live ranking of the biggest takers on Solana, 7/30/90d |
| Lead-time radar | Free | Wallets ranked by how early they enter, not by profit |

### Take it with you
| Surface | Tier | What it does |
|---|---|---|
| Receipt card | Free | Export a trace as a single image |
| Telegram bot | Free | `/trace` and `/pool` from inside any chat |
| Export & API | Pro | CSV of annotated losses, plus raw endpoints |

**Pre-trade check is the commercial core.** Nine of these are post-mortem — people look once and leave. Pre-trade check is the only one opened daily before a buy, and it is the reason anyone pays monthly. If scope has to be cut, cut anything else first.

**Extractor index is the acquisition core.** Every other surface needs input before it shows anything. This one gives a first-time visitor something to read immediately, and it is a page Google can rank.

---

## 2. The engine

This is the whole product. Everything else is presentation. Build in this order and verify each stage before moving on.

### Stage 1 — Swap ingest

Subscribe via Yellowstone gRPC (Triton or Helius). Parse swap instructions from, in priority order:

1. Pump.fun bonding curve + PumpSwap
2. Raydium AMM v4, CPMM, CLMM
3. Meteora DLMM + Dynamic AMM
4. Orca Whirlpool

Normalise every swap to one row:

```
signature, slot, block_time, pool_id, mint, wallet,
side (buy|sell), base_amount, quote_amount, quote_mint, usd_value
```

`usd_value` comes from the quote leg (SOL or USDC) × quote price at that slot. Keep a 1-minute SOL/USD series from Pyth. **Never price off the pool itself** — it's manipulable, and on a thin memecoin pool it's manipulable by design.

### Stage 2 — Position accounting

Per `(wallet, mint)`, maintain FIFO lots.

- **Buy** → push lot `(qty, cost_usd)`
- **Sell** → consume lots FIFO; `realised_pnl += proceeds_usd − cost_basis_consumed`
- **Closed** when cumulative qty falls under a dust threshold (0.5% of peak qty)

Record `open_ts, close_ts, cost_basis_usd, proceeds_usd, realised_pnl, basis_quality`.

**The gotcha that will bite you:** tokens arriving by transfer rather than swap — airdrops, bundler distribution, wallet consolidation — have no cost basis. Do not treat them as zero-cost; that fabricates enormous fake profit. Flag the position `unknown_basis` and exclude it from attribution entirely. Expect this on 10–20% of wallets.

### Stage 3 — Window netting

For each **buy leg** `b` of a losing position, in pool `P`, at slot `s`, USD size `A`:

1. Expand a window outward from `s` in both directions until cumulative **sell** volume inside it reaches `A`. Cap at ±10 minutes.
   Use volume, not a fixed time window. A fixed window is wrong at both ends — too wide on a 6-second-block memecoin, too narrow on a slow pool.
2. Collect every sell in the window: `{wallet_j, usd_j, slot_j}`.
3. **Exclude** — this list is what separates a real product from noise:
   - the buyer's own wallet and anything in its funding cluster
   - LP add/remove operations
   - any wallet whose `|net position change|` inside the window is under 20% of its gross volume — that's an arb bot or MM round-tripping, not a distributor
   - known CEX hot wallets, routers, aggregator vaults
4. Weight by size and proximity: `w_j = usd_j × exp(−|slot_j − s| / τ)`, τ ≈ 150 slots
5. `share_j = w_j / Σw`

### Stage 4 — Loss allocation

Attribution scales to the actual loss, not the notional buy size:

```
loss_share_b      = (A / total_cost_basis) × |realised_loss|
attributed_loss_j = loss_share_b × share_j
```

Sum across every buy leg of every losing position. Store the window (`pool, slot range, timestamp`) on every attribution row — it has to be displayable. See §6.

### Stage 5 — Aggregates

Materialised views:

- `(victim, counterparty)` → **wallet trace, watchlist**
- `(mint)` → **token receipt**
- `(counterparty)` → **extractor file, extractor index**
- `(counterparty, entry_offset_from_first_pump)` → **lead-time radar**

Live queries, not rollups:
- **Pre-trade check** — current holders of pool `P` ∩ counterparty set of wallet `W`
- **Distribution alerts** — open positions of `W` ∩ top holders currently reducing

### Stage 6 — Clustering

Feeds everything above and should land before the Pro surfaces ship. Cluster on shared funding source + timing correlation + common pool sets. **BundleScan already has most of this logic — port it, don't rebuild it.**

---

## 3. Design system

Take these from `exitliquidity-landing.html` verbatim. Do not improvise a variant.

```css
--bk:#060607  --s1:#0B0C0E  --s2:#111316
--ln:#1B1E22  --ln2:#2A2F35
--wh:#F5F6F7  --g1:#A3A9B0  --g2:#6B727A  --g3:#464C53
--rd:#E23B2E
```

**Type.** Archivo (variable, wght 300–800, wdth 75–125) for everything structural. JetBrains Mono for all data, addresses, labels and eyebrows. Headlines run `wdth 104`, `wght 700`, letter-spacing −0.04em. Large figures run `wght 300`.

**Rules that hold everywhere:**
- One accent colour. Red is for loss figures, tier badges and small markers only. There is no second accent — if something needs to stand out and isn't a loss, it uses white or a grey step.
- No border radius anywhere. No gradients. No glow, no glass, no shadow.
- All borders are `1px solid var(--ln)`.
- Every number is monospace with `font-variant-numeric: tabular-nums`.
- The page sits on a fixed 6-column hairline grid at `rgba(245,246,247,.026)`. Keep it.
- Cards sit in a 1px-gap grid over a `--ln` background — the gap *is* the border.

---

## 4. Stack

| Layer | Choice | Why |
|---|---|---|
| Ingest | TypeScript + `@triton-one/yellowstone-grpc` | Streaming, not polling |
| Hot store | ClickHouse | The swap table reaches billions of rows; Postgres won't hold it |
| App store | Postgres | Users, subscriptions, watchlists, cached aggregates |
| Queue | BullMQ + Redis | Backfill and rollup jobs |
| Frontend + API | **Next.js App Router** | Non-negotiable, see below |
| Alerts | Telegram Bot API | Fired from the ingest worker |
| Billing | Stripe | |

**On Next.js:** token receipt, extractor index and lead-time radar must be server-rendered with ISR. That's thousands of indexable pages and it is the entire organic acquisition strategy. Building this as a client-side SPA repeats the exact crawlability problem we hit on Fourtis.io. Do not.

**Auth:** free tier has none — pasting an address is the whole model. Pro uses email magic link. **No wallet connect anywhere in the product, ever.** It's a read-only forensics tool; asking for a signature destroys the trust position that the product is selling.

---

## 5. Schema sketch

```sql
-- ClickHouse
swaps(signature, slot, block_time, pool_id, mint, wallet,
      side, base_amount, quote_amount, quote_mint, usd_value)
      ENGINE = MergeTree ORDER BY (mint, slot)

positions(wallet, mint, open_ts, close_ts, cost_basis_usd,
          proceeds_usd, realised_pnl, status, basis_quality)

attributions(victim, counterparty, mint, pool_id,
             window_start_slot, window_end_slot, window_ts,
             attributed_usd, buy_leg_sig)

-- Postgres
users(id, email, tier, stripe_customer_id, created_at)
watchlist(user_id, counterparty, alerts_on, created_at)
wallet_claims(user_id, wallet)
clusters(cluster_id, wallet, confidence, evidence)
agg_victim_counterparty | agg_token | agg_counterparty | agg_leadtime
```

---

## 6. Build phases

**P0 — Pipeline proof.** Pump.fun + PumpSwap only. Normalise to `swaps`.
*Done when:* a known token's swap count matches Dexscreener within 2%.

**P1 — Position accounting.** FIFO lots, realised PnL, `unknown_basis` flagging.
*Done when:* realised PnL for 10 sample wallets matches an existing PnL tracker within 5%. **If it doesn't, the bug is in Stage 2 and everything downstream is worthless — stop and fix it, do not proceed.**

**P2 — Attribution + wallet trace.** Stages 3–4, then the trace UI.
*Done when:* hand-reading one token's transaction log agrees with the top attributed counterparty.

**P3 — Public pages.** Token receipt, extractor index, lead-time radar, receipt card. Cheap once P2 exists, and this is where traffic comes from.
*Done when:* pages render server-side, sitemap submitted, Search Console indexing.

**P4 — Clustering.** Port from BundleScan. Retro-apply to existing attributions.
*Done when:* a known 9-wallet bundle collapses to one ledger row.

**P5 — Pro read surfaces.** Extractor file, cluster map, pre-trade check.
*Done when:* pre-trade check returns under 800ms on a warm pool.

**P6 — Alerts.** Watchlist, distribution alerts, Telegram bot.
*Done when:* alert latency under 10s from fill.

**P7 — Commercial.** Stripe, quota enforcement, CSV export, public API.

Additional venues (Raydium, Meteora, Orca) run as a parallel track once P1 is green.

---

## 7. Rules that don't get negotiated

1. **Never claim proof.** On an AMM you trade against a pool, not a person. We measure *overlap* and we say so. The moment copy says "this wallet took your money" as fact rather than attribution, one person on CT with a transaction log kills the product in an afternoon.
2. **Every attribution row ships with its window.** Pool, timestamp, slot range. Checkable, not asserted.
3. **Realised only.** Open positions are excluded from attribution — an unrealised loss hasn't paid anyone yet. (Distribution alerts read open positions but never attribute from them.)
4. **No fabricated stats.** No "12,000 wallets traced" until it's true. Both prototypes are labelled demo data throughout; strip those labels only when real data is behind them.
5. **No wallet connect.**

---

## 8. Known hard parts

- **Arb and MM filtering.** The net-vs-gross rule in Stage 3 catches most of it. Under-filter and every trace looks like the same three bots took everything from everyone.
- **Backfill cost.** Full historical coverage is expensive. Start at 90 days and extend; most memecoin positions close inside a week anyway.
- **Window tuning.** τ and the volume-expansion cap need calibration against hand-checked cases. Budget real time here — it's the difference between a sharp product and a plausible-looking one.
- **Lead-time radar needs a "pump" definition.** Pick one and write it down: first slot where 5-minute return exceeds some multiple of trailing volatility. It's arbitrary; what matters is that it's fixed and disclosed.

---

## 9. Open decisions for ALFA

- Pricing is a placeholder at $29/mo, free tier 3 traces/day.
- Backfill depth at launch (90 days assumed).
- Whether public pages carry Fourtis.io cross-links or stay a clean separate brand.

---

## 10. Claude Code kickoff prompt

Paste this into a fresh Claude Code session in the repo root, with all three files attached.

```
You are building ExitLiquidity, a Solana counterparty-forensics product.

Attached:
- exitliquidity-handoff.md      — the spec. Read it fully before writing code.
- exitliquidity-landing.html    — design source of truth (palette, type, components)
- exitliquidity-app.html        — interaction reference only; its palette is superseded

This is production work, not a prototype. It will be reviewed for code quality,
error handling and modularity.

Stack is fixed and stated in §4 of the spec: TypeScript, Next.js App Router,
ClickHouse for swaps, Postgres for app state, BullMQ + Redis, Yellowstone gRPC
for ingest. Do not substitute.

Start at P0 in §6 and stop at its acceptance criterion. Do not skip ahead to
later phases — P1 in particular is a hard gate, and if realised PnL doesn't
reconcile, everything downstream is worthless.

For this session, deliver:
1. Repo structure and package setup
2. The Yellowstone gRPC consumer
3. Swap instruction parsers for Pump.fun bonding curve and PumpSwap
4. Normalisation into the `swaps` schema in §5
5. ClickHouse migration and insert path
6. A verification script that counts swaps for a given mint so we can check
   against Dexscreener

Read §7 before writing any user-facing copy. Those five rules are absolute.

Ask me before making any architectural decision the spec doesn't cover.
```
