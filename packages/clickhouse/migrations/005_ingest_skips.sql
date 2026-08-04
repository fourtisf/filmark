-- Venue instructions that matched a program but produced no row.
--
-- The P0 acceptance test is a count comparison, so anything silently dropped
-- shows up as a shortfall with no explanation. This table turns "we are 4%
-- below Dexscreener" into a list of signatures to go and read.
--
-- Two weeks is long enough to investigate and short enough that it never
-- competes with the swap table for disk.
CREATE TABLE IF NOT EXISTS ingest_skips
(
    observed_at    DateTime DEFAULT now(),
    slot           UInt64,
    signature      String,
    venue          LowCardinality(String),
    reason         LowCardinality(String),
    ix_index       Int32,
    inner_ix_index Int32,
    detail         String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(observed_at)
ORDER BY (observed_at, reason, signature)
TTL observed_at + INTERVAL 14 DAY;
