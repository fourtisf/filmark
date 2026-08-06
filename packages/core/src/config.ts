import { z } from 'zod';
import { ConfigError } from './errors.js';

/**
 * Every tunable lives here so a deployment is describable by its environment
 * alone. Nothing in this file has a default that silently points at production.
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
/** Rates are not always whole: a limit of one request every two seconds is 0.5. */
const positiveNumber = z.coerce.number().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanish.default(false),

  CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
  CLICKHOUSE_DATABASE: z.string().min(1).default('exitliquidity'),
  CLICKHOUSE_USER: z.string().min(1).default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  /** Rows buffered before a flush is forced. ClickHouse prefers big batches. */
  CLICKHOUSE_MAX_INSERT_ROWS: positiveInt.default(5000),
  /** Upper bound on how long a row may sit unflushed. */
  CLICKHOUSE_MAX_INSERT_DELAY_MS: positiveInt.default(2000),
  CLICKHOUSE_REQUEST_TIMEOUT_MS: positiveInt.default(30_000),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  /** Yellowstone gRPC endpoint. Triton and Helius are both fine; see README. */
  YELLOWSTONE_ENDPOINT: z.string().url().optional(),
  YELLOWSTONE_X_TOKEN: z.string().optional(),
  YELLOWSTONE_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  /** Silence longer than this triggers a reconnect. */
  YELLOWSTONE_IDLE_TIMEOUT_MS: positiveInt.default(30_000),
  YELLOWSTONE_PING_INTERVAL_MS: positiveInt.default(10_000),
  YELLOWSTONE_RECONNECT_MIN_MS: positiveInt.default(500),
  YELLOWSTONE_RECONNECT_MAX_MS: positiveInt.default(30_000),

  SOLANA_RPC_URL: z.string().url().optional(),
  /** Client-side rate limit, so a shared key is not burned by a backfill. */
  SOLANA_RPC_MAX_RPS: positiveInt.default(10),
  SOLANA_RPC_MAX_ATTEMPTS: positiveInt.default(5),
  SOLANA_RPC_TIMEOUT_MS: positiveInt.default(20_000),
  /** Transactions per JSON-RPC batch request. 1 disables batching. */
  SOLANA_RPC_BATCH_SIZE: positiveInt.default(20),

  PYTH_HERMES_URL: z.string().url().default('https://hermes.pyth.network'),
  PYTH_BENCHMARKS_URL: z.string().url().default('https://benchmarks.pyth.network'),
  /**
   * Requests a second to Pyth Benchmarks.
   *
   * It is a free public endpoint with no key, so the limit is shared with
   * everyone else pointed at it, and a range of any size arrives as a series of
   * 5,000-bar windows. A backfill fired them as fast as it could and was
   * refused outright. Modest by default; raise it only if Benchmarks stops
   * complaining.
   */
  PYTH_MAX_RPS: positiveNumber.default(3),
  /** Pyth SOL/USD price feed id, hex, no 0x prefix. */
  PYTH_SOL_USD_FEED_ID: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .default('ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'),
  /**
   * How far a swap may sit from the nearest SOL/USD minute before we refuse to
   * price it. Beyond this the row keeps `usd_value = NULL`; spec §7.4.
   */
  PRICE_MAX_STALENESS_SEC: positiveInt.default(300),
  /**
   * Seconds between top-ups of the API's SOL/USD series. 0 turns it off.
   *
   * The series a trace needs is the same fortnight for everybody who lost money
   * in the same cycle, so fetching it per request re-downloads what the process
   * already holds — and does it inside a request, against an endpoint that
   * meters over a window and answers `Retry-After: 58`. Observed on the live
   * service: a trace paused sixty seconds inside Benchmarks after the chain had
   * already answered it.
   *
   * Filling the whole lookback once at startup and topping up the newest end on
   * this interval moves that cost to where nobody is waiting. The top-up is one
   * window — `#gaps` only asks for what is missing — so this is cheap at any
   * value well under the series' own staleness bound.
   */
  PRICE_REFRESH_SEC: nonNegativeInt.default(120),

  BACKFILL_CONCURRENCY: positiveInt.default(4),
  /** Default lookback when a backfill job names no explicit range. Spec §8. */
  BACKFILL_DEFAULT_DAYS: positiveInt.default(90),
  /** Signatures pulled per `getSignaturesForAddress` page. RPC caps this at 1000. */
  BACKFILL_SIGNATURE_PAGE_SIZE: z.coerce.number().int().min(1).max(1000).default(1000),
  /** Transactions fetched per batch inside a backfill job. */
  BACKFILL_TRANSACTION_BATCH: positiveInt.default(20),
  /**
   * Longest the SOL/USD fill may hold up a backfill before it crawls anyway.
   *
   * Benchmarks meters over a window and answers `Retry-After: 59`, and a year
   * is 106 of those windows — obeyed literally that is hours of a backfill
   * spent before a single transaction is read. The swaps are the part nobody
   * can reconstruct later; prices are stored separately, replace in place, and
   * every re-run resumes. So the crawl gets a bounded wait and then goes.
   */
  BACKFILL_PRICE_TIMEOUT_MS: positiveInt.default(300_000),

  METRICS_PORT: port.default(9464),
  METRICS_ENABLED: booleanish.default(true),

  // ── Trace API ───────────────────────────────────────────────────────────
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: port.default(8080),
  /**
   * Browser origins allowed to call the API, comma separated. `*` allows any.
   *
   * Empty by default: the API holds an RPC key, and a service that answers
   * every origin out of the box is one someone else's page can spend.
   */
  API_CORS_ORIGINS: z.string().default(''),
  /** How long a completed trace is served from memory before it is recomputed. */
  API_CACHE_TTL_SEC: positiveInt.default(300),
  /** Cached traces held before the least recently used is dropped. */
  API_CACHE_MAX_ENTRIES: positiveInt.default(200),
  /** Traces computed at once. Each one is a long series of RPC calls. */
  API_MAX_CONCURRENT_TRACES: positiveInt.default(2),
  /** Upper bound on a single trace, after which it fails rather than hangs. */
  API_TRACE_TIMEOUT_MS: positiveInt.default(180_000),
  /**
   * Serve a trace from the swap index when a backfill has covered the wallet.
   *
   * Off by default: an API pointed at a ClickHouse that is not there would fail
   * on a dependency the live path never needed. On, a wallet somebody has
   * backfilled is answered in a query instead of a few thousand RPC calls, and
   * `coverage.source` says which happened.
   */
  API_USE_INDEX: booleanish.default(false),
  /**
   * Days of history the API asks for when it queues a wallet for a deep read.
   *
   * Larger than `TRACE_LOOKBACK_DAYS` on purpose, and that is the whole point:
   * the lookback exists because a live crawl has a web request to fit inside,
   * and a backfill has nothing waiting on it. Asking for the same narrow window
   * the crawl already failed to answer with would queue work that changes
   * nothing.
   */
  INDEX_REQUEST_DAYS: positiveInt.default(365),
  /**
   * How often the ingest worker looks for wallets the API has asked about.
   *
   * The queue is a table, not a socket, so this is a poll. Frequent enough that
   * somebody who was told "come back in a few minutes" is not lied to, rare
   * enough to be invisible next to the crawl it triggers.
   */
  INDEX_REQUEST_POLL_MS: positiveInt.default(30_000),
  /**
   * How current an indexed wallet has to be before its request counts as done.
   *
   * A backfill from last week knows nothing about this week's trades, so a
   * covered wallet becomes outstanding again once it is this stale rather than
   * being finished forever.
   */
  INDEX_REQUEST_STALENESS_SEC: positiveInt.default(86_400),

  /**
   * How far back a trace reads a wallet's history. Spec §8 assumes 90 days.
   *
   * This is a ceiling, not a promise: an active wallet hits
   * `TRACE_MAX_SIGNATURES` long before it hits the date, and the response says
   * so via `coverage.historyTruncated`.
   */
  TRACE_LOOKBACK_DAYS: positiveInt.default(90),
  /**
   * Signatures read for the traced wallet before the crawl is cut short.
   *
   * Every one of these costs a `getTransaction`, so this is the dominant term
   * in what a trace spends. At the default 10 RPC calls per second, 1200 is
   * about two minutes of wall clock — see `API_TRACE_TIMEOUT_MS`, which has to
   * be larger than this budget can consume or every heavy wallet times out.
   */
  TRACE_MAX_SIGNATURES: positiveInt.default(1200),
  /** Losing positions attributed per trace, largest loss first. */
  TRACE_MAX_POSITIONS: positiveInt.default(12),
  /** Buy legs attributed per position, largest cost basis first. */
  TRACE_MAX_LEGS_PER_POSITION: positiveInt.default(6),
  /**
   * Signature pages crawled for window netting, across the whole trace. 1000
   * signatures each, and shared by every pool rather than granted per pool.
   */
  TRACE_MAX_POOL_SIGNATURE_PAGES: positiveInt.default(20),
  /** Pool transactions fetched for window netting, across the whole trace. */
  TRACE_MAX_POOL_TRANSACTIONS: positiveInt.default(600),

  /** Drops swaps below this USD size. 0 keeps everything, which is the default. */
  MIN_SWAP_USD: nonNegativeInt.default(0),
});

export type Config = z.infer<typeof configSchema>;

export type RawEnv = Record<string, string | undefined>;

/**
 * Parses and validates the environment.
 *
 * Empty strings are treated as absent so a blank line in a `.env` file does not
 * beat a default. Throws `ConfigError` with every problem at once rather than
 * failing on the first.
 */
export function loadConfig(env: RawEnv = process.env): Config {
  const cleaned: RawEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${issues.join('\n  ')}`, {
      context: { issues },
    });
  }
  return result.data;
}

/** Narrows the config once a command genuinely needs the gRPC stream. */
export function requireYellowstone(config: Config): { endpoint: string; xToken?: string } {
  if (config.YELLOWSTONE_ENDPOINT === undefined) {
    throw new ConfigError('YELLOWSTONE_ENDPOINT is required to run the stream consumer');
  }
  return {
    endpoint: config.YELLOWSTONE_ENDPOINT,
    ...(config.YELLOWSTONE_X_TOKEN === undefined ? {} : { xToken: config.YELLOWSTONE_X_TOKEN }),
  };
}

/** Narrows the config once a command genuinely needs JSON-RPC. */
export function requireRpcUrl(config: Config): string {
  if (config.SOLANA_RPC_URL === undefined) {
    throw new ConfigError('SOLANA_RPC_URL is required for backfill and mint lookups');
  }
  return config.SOLANA_RPC_URL;
}
