-- The normalised swap table from spec §5.
--
-- Deviations from the sketch, each deliberate:
--
--   ReplacingMergeTree, not MergeTree. Backfill and the live stream overlap by
--   design, and a restart replays the tail of the stream, so the same swap
--   arrives more than once. Deduplication has to happen somewhere; doing it on
--   the sort key is cheaper than doing it in the writer.
--
--   The sort key carries (signature, ix_index, inner_ix_index) after
--   (mint, slot). One transaction can contain several swaps — routers batch
--   them — so nothing shorter identifies a row. The (mint, slot) prefix the
--   spec asked for is preserved, so range scans by token are unaffected.
--
--   base_decimals/quote_decimals are stored alongside the raw amounts so a
--   reader never has to join to interpret a number.
--
--   quote_fee_amount is nullable and means unknown, never zero. Pump.fun's
--   bonding curve does not expose its fee in the fields P0 decodes.
CREATE TABLE IF NOT EXISTS swaps
(
    mint             String,
    slot             UInt64,
    block_time       DateTime('UTC'),
    signature        String,
    -- Index of the top-level instruction, and position within its inner list
    -- (-1 when the swap *is* the top-level instruction).
    ix_index         Int32,
    inner_ix_index   Int32,

    venue            LowCardinality(String),
    pool_id          String,
    wallet           String,
    side             Enum8('buy' = 1, 'sell' = 2),

    -- Raw on-chain units. Human-scale values are amount / 10^decimals.
    base_amount      UInt64,
    base_decimals    UInt8,
    -- The pool leg: quote tokens that moved into or out of the pool, fees
    -- excluded. The trader's own cash flow is quote_amount + quote_fee_amount
    -- on a buy and quote_amount - quote_fee_amount on a sell.
    quote_amount     UInt64,
    quote_fee_amount Nullable(UInt64),
    quote_mint       LowCardinality(String),
    quote_decimals   UInt8,

    -- USD value of quote_amount, priced off the quote leg and never off the
    -- pool (spec §2 Stage 1). NULL where no price was available in range.
    usd_value        Nullable(Float64),
    usd_price_source LowCardinality(String),

    -- 'stream' or 'backfill', so the two paths can be reconciled.
    ingest_source    LowCardinality(String),
    ingested_at      DateTime DEFAULT now(),

    -- Wallet trace and pre-trade check both start from a point lookup on a
    -- column that is not in the sort key.
    INDEX idx_wallet wallet TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_pool pool_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_signature signature TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(block_time)
ORDER BY (mint, slot, signature, ix_index, inner_ix_index)
SETTINGS index_granularity = 8192;
