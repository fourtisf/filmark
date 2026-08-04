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

  BACKFILL_CONCURRENCY: positiveInt.default(4),
  /** Default lookback when a backfill job names no explicit range. Spec §8. */
  BACKFILL_DEFAULT_DAYS: positiveInt.default(90),
  /** Signatures pulled per `getSignaturesForAddress` page. RPC caps this at 1000. */
  BACKFILL_SIGNATURE_PAGE_SIZE: z.coerce.number().int().min(1).max(1000).default(1000),
  /** Transactions fetched per batch inside a backfill job. */
  BACKFILL_TRANSACTION_BATCH: positiveInt.default(20),

  METRICS_PORT: port.default(9464),
  METRICS_ENABLED: booleanish.default(true),

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
