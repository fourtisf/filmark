# Verification checklist

Every program constant in this repository is either derived from a definition
or taken from published program interfaces. **None of it has been held up
against a real mainnet transaction**, because the session that wrote it had no
RPC access. This document lists exactly what to check and how, in the order
that a failure would matter.

`dump-tx` exists for this. It decodes one transaction and prints every field
the parsers read:

```bash
pnpm --filter @exitliquidity/ingest run cli dump-tx <SIGNATURE>
```

Hold its output against the same transaction on Solscan or the pump.fun UI. If
they agree, the constants below are right.

---

## 1. Discriminators — already self-verifying

`packages/parsers/src/discriminators.test.ts` recomputes every discriminator
from its Anchor preimage (`sha256("global:buy")[..8]` and friends) rather than
comparing a constant to a copy of itself. `packages/core/src/constants.test.ts`
does the same for the `emit_cpi!` tag, including its little-endian byte order,
and asserts that every program id and mint decodes to 32 bytes.

Nothing to do here unless a program changes its instruction names.

## 2. Pump.fun `TradeEvent` field order — **check first**

`packages/parsers/src/pumpfun.ts` reads this prefix and ignores everything
after it:

```
mint          Pubkey    32
sol_amount    u64        8
token_amount  u64        8
is_buy        bool       1
user          Pubkey    32
timestamp     i64        8
```

The struct has grown several times (real reserves, fee recipients, creator
fees), which is why only the prefix is read — a longer payload from a newer
program version parses fine.

**Check:** `dump-tx` on any pump.fun buy. The `mint`, `wallet` and `blockTime`
must match the explorer, and `quote` must equal the SOL that moved against the
bonding curve. If the fields are shifted, the mint will decode as nonsense and
this is obvious immediately.

**Also confirm:** that `sol_amount` is the _pool_ leg and excludes the protocol
fee. This repo assumes it is. If it turns out to include the fee, `quote_amount`
for pumpfun rows is inconsistent with pumpswap rows and §4 attribution would be
comparing unlike numbers across venues.

## 3. Pump.fun fee — currently recorded as unknown

`quote_fee_amount` is `NULL` for every pumpfun row. The bonding curve charges a
fee outside `sol_amount`, and the event fields carrying it were added after the
ones decoded here, so P0 does not read them.

**This is a P1 blocker, not a P0 one.** Position accounting needs the trader's
actual cash flow, which is `quote_amount + fee` on a buy. Decoding the fee
fields — after confirming their position against a real event — is the first
thing P1 should do.

## 4. PumpSwap event layout — **check second**

`packages/parsers/src/pumpswap.ts` assumes `BuyEvent` and `SellEvent` share a
layout of fourteen 8-byte fields followed by six pubkeys, and reads four of
them:

| Offset | Field                                            | Used as                   |
| ------ | ------------------------------------------------ | ------------------------- |
| 0      | `timestamp`                                      | block time fallback       |
| 8      | `base_amount_out` / `base_amount_in`             | `base_amount`             |
| 56     | `quote_amount_in` / `quote_amount_out`           | `quote_amount` (pool leg) |
| 112    | `user_quote_amount_in` / `user_quote_amount_out` | trader cash flow          |
| 120    | `pool`                                           | `pool_id`                 |
| 152    | `user`                                           | `wallet`                  |
| 184    | `user_base_token_account`                        | base mint resolution      |
| 216    | `user_quote_token_account`                       | quote mint resolution     |

`quote_fee_amount` is derived as the gap between the two quote figures rather
than by summing the individual fee fields, so it captures every fee the program
charges — including any added to the struct after this was written.

**Check:** `dump-tx` on a PumpSwap buy. `pool` and `wallet` must match the
explorer; `fee` should land near the venue's fee rate on `quote`. A wildly wrong
fee means an offset is out by one field.

## 5. Account positions — only two are relied on

- Pump.fun `buy`/`sell`: account **3** is the bonding curve. Nothing past it is
  read; the mint and the trader come from the event.
- PumpSwap `buy`/`sell`: accounts **3** and **4** are the base and quote mints,
  used **only as a fallback**. The primary path resolves both mints from the
  transaction's own token balances via the account pubkeys in the event, which
  survives account-layout changes that fixed indices do not.

**Check:** a transaction where the trader's token account is created in the same
transaction, so no pre-balance exists. That is the case that exercises the
fallback.

## 6. Pyth SOL/USD feed id

`ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d`, configurable
via `PYTH_SOL_USD_FEED_ID`.

**Check:**

```bash
pnpm --filter @exitliquidity/ingest run cli prices --days 1
```

Then query `sol_usd_1m` and compare a few minutes against any SOL chart. A wrong
feed id gives a plausible-looking series for the wrong asset, which is the worst
possible failure mode here — every `usd_value` would be silently wrong rather
than missing.

## 7. Dexscreener venue ids

`verify-count` matches pairs on `dexId` in `{pumpfun, pumpswap}`
(`apps/ingest/src/verify.ts`). If Dexscreener renames either, the report says
"no pump.fun or PumpSwap pair for this mint" rather than silently comparing
against zero.

**Check:** the "pairs matched" line in the report is non-zero for a token you
know trades on both.

## 8. ClickHouse schema against a real server

```bash
docker compose up -d clickhouse
CLICKHOUSE_TEST_URL=http://localhost:8123 pnpm test
```

This covers what no mock can: 64-bit amounts surviving the round trip,
duplicate rows collapsing before parts merge, and nulls staying null.

---

## The P0 gate

Once 2, 4 and 6 are confirmed:

```bash
pnpm --filter @exitliquidity/ingest run cli backfill <MINT> --days 1
pnpm --filter @exitliquidity/ingest run cli verify-count <MINT> --hours 24
```

Pick a token with meaningful volume that has already migrated to PumpSwap, so
both parsers are exercised in one run.

If it fails, work in this order:

1. **`exitliquidity_dropped_total`** on `/metrics` — swaps parsed but not
   written, with a reason label.
2. **`ingest_skips`** — venue instructions that produced no row. `event_missing`
   in bulk means an event discriminator is wrong. `pair_unresolved` in bulk
   means mint resolution is failing.
3. **`dump-tx`** on a signature from `ingest_skips`, then compare against the
   layouts above.

A shortfall with a clean `ingest_skips` table and no drops is a coverage
problem, not a parsing one: the token traded somewhere P0 does not parse, and
Dexscreener is counting those pairs too.
