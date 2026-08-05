import { createLogger, requireRpcUrl, type Config, type Logger } from '@exitliquidity/core';
import { PythClient } from '@exitliquidity/pricing';
import { SolanaRpcClient } from '@exitliquidity/solana';
import { ResultCache, Semaphore } from './cache.js';
import { createApiMetrics, type ApiMetrics } from './metrics.js';
import { TokenMetadataResolver } from './metadata.js';
import { SolUsdCache } from './prices.js';
import type { TraceReport } from './report.js';
import { ChainScanner } from './scan.js';
import { TraceService } from './trace.js';

export interface ApiServices {
  readonly logger: Logger;
  readonly traces: TraceService;
  readonly cache: ResultCache<TraceReport>;
  readonly semaphore: Semaphore;
  readonly metrics: ApiMetrics;
  readonly rpcEndpoint: string;
  readonly corsOrigins: readonly string[];
}

/**
 * Builds everything the API needs from the environment.
 *
 * `requireRpcUrl` throws a `ConfigError` when `SOLANA_RPC_URL` is unset, and
 * that is deliberate: a trace API with no RPC endpoint has nothing to trace
 * with, and failing at startup is far cheaper to diagnose than a service that
 * boots healthy and returns an error on every request.
 */
export function createServices(config: Config): ApiServices {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    name: 'api',
    pretty: config.LOG_PRETTY,
  });

  const rpc = new SolanaRpcClient({
    url: requireRpcUrl(config),
    maxRequestsPerSecond: config.SOLANA_RPC_MAX_RPS,
    maxAttempts: config.SOLANA_RPC_MAX_ATTEMPTS,
    timeoutMs: config.SOLANA_RPC_TIMEOUT_MS,
    batchSize: config.SOLANA_RPC_BATCH_SIZE,
    logger,
  });

  const prices = new SolUsdCache({
    client: new PythClient({
      benchmarksUrl: config.PYTH_BENCHMARKS_URL,
      hermesUrl: config.PYTH_HERMES_URL,
      feedId: config.PYTH_SOL_USD_FEED_ID,
      logger,
    }),
    maxStalenessSec: config.PRICE_MAX_STALENESS_SEC,
    logger,
  });

  const scanner = new ChainScanner({
    rpc,
    oracle: () => prices.oracle,
    warm: (fromTs, toTs, signal) => prices.ensure(fromTs, toTs, signal),
    budget: {
      lookbackDays: config.TRACE_LOOKBACK_DAYS,
      maxSignatures: config.TRACE_MAX_SIGNATURES,
      maxPoolSignaturePages: config.TRACE_MAX_POOL_SIGNATURE_PAGES,
      maxPoolTransactions: config.TRACE_MAX_POOL_TRANSACTIONS,
      signaturePageSize: config.BACKFILL_SIGNATURE_PAGE_SIZE,
    },
    logger,
  });

  const traces = new TraceService({
    scanner,
    metadata: new TokenMetadataResolver({ rpc, logger }),
    limits: {
      lookbackDays: config.TRACE_LOOKBACK_DAYS,
      maxPositions: config.TRACE_MAX_POSITIONS,
      maxLegsPerPosition: config.TRACE_MAX_LEGS_PER_POSITION,
    },
    // Read per trace, not captured: the series grows as traces warm it.
    priceSeries: () => prices.seriesRange,
    logger,
  });

  return {
    logger,
    traces,
    cache: new ResultCache<TraceReport>({
      ttlSec: config.API_CACHE_TTL_SEC,
      maxEntries: config.API_CACHE_MAX_ENTRIES,
    }),
    semaphore: new Semaphore({ limit: config.API_MAX_CONCURRENT_TRACES }),
    metrics: createApiMetrics(),
    rpcEndpoint: rpc.endpoint,
    corsOrigins: parseOrigins(config.API_CORS_ORIGINS),
  };
}

/**
 * Worst-case seconds of RPC one trace can spend, given the configured budgets.
 *
 * Every signature the wallet crawl keeps costs one `getTransaction`, and that
 * term dominates everything else. Comparing this against the request timeout is
 * the difference between a service that returns a smaller answer and one that
 * always times out on exactly the wallets people care about — and the failure
 * is invisible until a heavy wallet is tried, which is far too late to notice.
 */
export function worstCaseTraceSeconds(config: Config): number {
  const walletPages = Math.ceil(config.TRACE_MAX_SIGNATURES / config.BACKFILL_SIGNATURE_PAGE_SIZE);
  const calls =
    walletPages +
    config.TRACE_MAX_SIGNATURES +
    config.TRACE_MAX_POOL_SIGNATURE_PAGES +
    config.TRACE_MAX_POOL_TRANSACTIONS;
  return calls / config.SOLANA_RPC_MAX_RPS;
}

/** Splits the comma-separated allowlist, trimming and dropping blanks. */
export function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter((entry) => entry !== '');
}
