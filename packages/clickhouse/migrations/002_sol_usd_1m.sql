-- One-minute SOL/USD from Pyth (spec §2 Stage 1).
--
-- Kept as a table rather than an in-process cache so backfill and the live
-- stream price identically: a row re-ingested six months later gets the same
-- number it got the first time.
CREATE TABLE IF NOT EXISTS sol_usd_1m
(
    minute_ts  DateTime('UTC'),
    open       Float64,
    high       Float64,
    low        Float64,
    close      Float64,
    -- Which Pyth endpoint produced this minute, so a bad backfill is traceable.
    source     LowCardinality(String),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(minute_ts)
ORDER BY (minute_ts);
