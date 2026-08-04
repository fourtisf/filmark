-- Where each ingest path has got to, so a restart resumes instead of replaying.
--
-- Lives in ClickHouse rather than Postgres because P0 has no Postgres yet; the
-- spec reserves Postgres for user-facing state, which none of this is.
CREATE TABLE IF NOT EXISTS ingest_checkpoints
(
    name       LowCardinality(String),
    slot       UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (name);
