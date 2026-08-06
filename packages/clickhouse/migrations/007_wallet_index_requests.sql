-- Wallets somebody asked about that the live crawl could not answer properly.
--
-- A trace has a web request to fit inside, and one `getTransaction` per
-- signature means an active wallet's year does not fit — the crawl comes back
-- cut short, and a wallet whose buys sit older than the window it reached looks
-- like it only ever sold. The honest answer to that is not a better crawl; it
-- is to pay for the history once, out of band, and answer from the index next
-- time. This table is how the API asks for that without knowing anything about
-- the worker that does it.
--
-- Deliberately not a queue with claims and states. There is nothing to lock:
-- the work is idempotent, `wallet_coverage` already records what has been paid
-- for, and the outstanding work is exactly the rows here that coverage does not
-- yet satisfy. A worker computes that with a join and can crash, restart, or
-- run twice without corrupting anything.
CREATE TABLE IF NOT EXISTS wallet_index_requests
(
    wallet       String,
    -- Days of history the requester wants covered.
    days         UInt16,
    -- Why it was asked for, so a queue that fills up is diagnosable rather than
    -- merely long. Free text from a fixed set; see the API's request reasons.
    reason       LowCardinality(String),
    requested_at DateTime DEFAULT now()
)
-- One row per wallet, newest request wins: fifty visitors pasting the same
-- wallet is one piece of work, and asking again for a wider window supersedes
-- the narrower ask rather than queueing beside it.
ENGINE = ReplacingMergeTree(requested_at)
ORDER BY (wallet);
