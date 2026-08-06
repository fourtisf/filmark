-- What the index knows about a wallet, so a reader can tell empty from unread.
--
-- `swaps` alone cannot answer "has this wallet been indexed?": a wallet with no
-- rows is either one that never traded on a parsed venue or one nobody has
-- backfilled yet, and serving the first answer for the second case is exactly
-- the fabricated finding §7.4 forbids. A backfill records the window it
-- actually covered here, and a reader that wants an older window than this row
-- describes knows to go to the chain instead of trusting a gap.
CREATE TABLE IF NOT EXISTS wallet_coverage
(
    wallet       String,
    -- The window the backfill was asked for and reached, unix seconds.
    from_ts      DateTime,
    to_ts        DateTime,
    -- Swaps written for this wallet in that window. Zero is a real answer here.
    swaps        UInt32,
    -- False when the crawl ran without a usable SOL/USD series, so the rows it
    -- wrote carry no dollar figure and a re-run would replace them.
    prices_ready UInt8,
    updated_at   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (wallet);
