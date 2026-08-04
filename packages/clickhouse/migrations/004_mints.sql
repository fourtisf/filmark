-- Mint decimals, cached.
--
-- Most transactions declare the decimals of every mint they touch, so this is
-- only consulted for the minority that do not — usually a buy that creates the
-- trader's token account in the same transaction. Caching them keeps a
-- backfill from spending its RPC budget re-asking for the same value.
CREATE TABLE IF NOT EXISTS mints
(
    mint       String,
    decimals   UInt8,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (mint);
