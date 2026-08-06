import {
  createIngestMetrics,
  describeError,
  createLogger,
  loadConfig,
  requireRpcUrl,
  type Config,
  type IngestMetrics,
  type Logger,
} from '@exitliquidity/core';
import {
  CheckpointRepository,
  MintRepository,
  SolUsdRepository,
  SwapRepository,
  clickHouseOptionsFromConfig,
  createClickHouseClient,
  type ClickHouseClient,
} from '@exitliquidity/clickhouse';
import { PythClient, SolUsdOracle, SolUsdSeries, type QuoteOracle } from '@exitliquidity/pricing';
import { SolanaRpcClient } from '@exitliquidity/solana';
import { MintDecimalsResolver } from './decimals.js';
import { SwapPipeline } from './pipeline.js';
import { PriceService } from './price-service.js';
import { SwapWriter } from './writer.js';

/**
 * Everything a command needs, wired from one config.
 *
 * Assembled here rather than inside each command so the stream and the
 * backfill provably share a pipeline, an oracle and a writer — the seam
 * between two differently-wired paths is where a count discrepancy would hide.
 */
export interface Services {
  readonly config: Config;
  readonly logger: Logger;
  readonly metrics: IngestMetrics;
  readonly clickhouse: ClickHouseClient;
  readonly swaps: SwapRepository;
  readonly checkpoints: CheckpointRepository;
  readonly mints: MintRepository;
  readonly solUsd: SolUsdRepository;
  readonly series: SolUsdSeries;
  readonly pyth: PythClient;
  readonly prices: PriceService;
  readonly oracle: QuoteOracle;
  readonly decimals: MintDecimalsResolver;
  readonly pipeline: SwapPipeline;
  readonly writer: SwapWriter;
  /** Present only when SOLANA_RPC_URL is set; backfill requires it. */
  readonly rpc: SolanaRpcClient | null;
  close(): Promise<void>;
}

export interface CreateServicesOptions {
  readonly config?: Config;
  readonly logger?: Logger;
}

export function createServices(options: CreateServicesOptions = {}): Services {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger ??
    createLogger({ level: config.LOG_LEVEL, pretty: config.LOG_PRETTY, name: 'ingest' });
  const metrics = createIngestMetrics();

  const clickhouse = createClickHouseClient(clickHouseOptionsFromConfig(config));
  const swaps = new SwapRepository(clickhouse);
  const checkpoints = new CheckpointRepository(clickhouse);
  const mints = new MintRepository(clickhouse);
  const solUsd = new SolUsdRepository(clickhouse);

  const rpc =
    config.SOLANA_RPC_URL === undefined
      ? null
      : new SolanaRpcClient({
          url: requireRpcUrl(config),
          maxRequestsPerSecond: config.SOLANA_RPC_MAX_RPS,
          batchSize: config.SOLANA_RPC_BATCH_SIZE,
          maxAttempts: config.SOLANA_RPC_MAX_ATTEMPTS,
          timeoutMs: config.SOLANA_RPC_TIMEOUT_MS,
          logger,
        });

  const series = new SolUsdSeries(config.PRICE_MAX_STALENESS_SEC);
  const pyth = new PythClient({
    benchmarksUrl: config.PYTH_BENCHMARKS_URL,
    hermesUrl: config.PYTH_HERMES_URL,
    feedId: config.PYTH_SOL_USD_FEED_ID,
    maxRequestsPerSecond: config.PYTH_MAX_RPS,
    logger,
  });
  const prices = new PriceService({ repository: solUsd, pyth, series, logger });
  const oracle = new SolUsdOracle(series);

  const decimals = new MintDecimalsResolver({
    repository: mints,
    ...(rpc === null ? {} : { rpc }),
    logger,
  });

  const pipeline = new SwapPipeline({
    decimals,
    oracle,
    metrics,
    logger,
    minSwapUsd: config.MIN_SWAP_USD,
  });

  const writer = new SwapWriter({
    repository: swaps,
    metrics,
    logger,
    maxRows: config.CLICKHOUSE_MAX_INSERT_ROWS,
    maxDelayMs: config.CLICKHOUSE_MAX_INSERT_DELAY_MS,
  });

  return {
    config,
    logger,
    metrics,
    clickhouse,
    swaps,
    checkpoints,
    mints,
    solUsd,
    series,
    pyth,
    prices,
    oracle,
    decimals,
    pipeline,
    writer,
    rpc,
    async close() {
      // Flush before closing the connection, or the last partial batch is lost.
      await writer.close().catch((error: unknown) => {
        logger.error({ err: describeError(error) }, 'failed to flush writer during shutdown');
      });
      await clickhouse.close();
    },
  };
}

/**
 * An abort signal wired to SIGINT and SIGTERM.
 *
 * A second signal exits immediately: if a graceful shutdown is itself stuck,
 * the operator needs a way out that does not involve SIGKILL.
 */
export function shutdownSignal(logger: Logger): AbortController {
  const controller = new AbortController();
  let signalled = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (signalled) {
        logger.warn({ signal }, 'second shutdown signal, exiting immediately');
        process.exit(130);
      }
      signalled = true;
      logger.info({ signal }, 'shutting down');
      controller.abort();
    });
  }

  return controller;
}
