import {
  ConfigError,
  daysToSeconds,
  describeError,
  nowSeconds,
  requireYellowstone,
  type Logger,
} from '@exitliquidity/core';
import {
  ensureDatabase,
  clickHouseOptionsFromConfig,
  runMigrations,
} from '@exitliquidity/clickhouse';
import { PARSED_PROGRAM_IDS } from '@exitliquidity/parsers';
import { TxContext, fromRpcTransaction } from '@exitliquidity/solana';
import { parseTransaction } from '@exitliquidity/parsers';
import { BackfillRunner, type BackfillRequest, type BackfillResult } from './backfill/runner.js';
import {
  createBackfillQueue,
  createBackfillWorker,
  createRedis,
  enqueueBackfill,
} from './backfill/queue.js';
import { startMetricsServer } from './metrics-server.js';
import { shutdownSignal, type Services } from './services.js';
import { StreamConsumer } from './stream/consumer.js';
import { formatVerifyReport, verifySwapCount } from './verify.js';

/** How often the live price refresh polls Hermes. */
const LIVE_PRICE_INTERVAL_MS = 20_000;

/** Hours of SOL/USD loaded into memory before the stream starts. */
const STREAM_PRICE_WARM_HOURS = 6;

export async function migrate(services: Services): Promise<void> {
  await ensureDatabase(clickHouseOptionsFromConfig(services.config));
  const applied = await runMigrations(services.clickhouse, { logger: services.logger });

  for (const migration of applied) {
    services.logger.info({ migration: migration.name, status: migration.status }, 'migration');
  }
  const fresh = applied.filter((m) => m.status === 'applied').length;
  services.logger.info({ applied: fresh, total: applied.length }, 'migrations complete');
}

export interface StreamOptions {
  readonly skipPriceWarmup?: boolean;
}

export async function stream(services: Services, options: StreamOptions = {}): Promise<void> {
  const { config, logger, metrics } = services;
  const { endpoint, xToken } = requireYellowstone(config);

  const controller = shutdownSignal(logger);

  // Built before the metrics server, because the readiness probe closes over it
  // and the socket starts accepting during the price warm-up below. Reading it
  // from its temporal dead zone throws a ReferenceError inside a request
  // listener, which nothing catches — one probe would have ended the boot.
  // The constructor only stores options, so there is nothing to gain by
  // deferring it and a process to lose.
  const consumer = new StreamConsumer({
    endpoint,
    ...(xToken === undefined ? {} : { xToken }),
    commitment: config.YELLOWSTONE_COMMITMENT,
    pipeline: services.pipeline,
    writer: services.writer,
    metrics,
    checkpoints: services.checkpoints,
    logger,
    programIds: PARSED_PROGRAM_IDS,
    idleTimeoutMs: config.YELLOWSTONE_IDLE_TIMEOUT_MS,
    pingIntervalMs: config.YELLOWSTONE_PING_INTERVAL_MS,
    reconnectMinMs: config.YELLOWSTONE_RECONNECT_MIN_MS,
    reconnectMaxMs: config.YELLOWSTONE_RECONNECT_MAX_MS,
  });

  const server = config.METRICS_ENABLED
    ? startMetricsServer({
        port: config.METRICS_PORT,
        metrics,
        logger,
        isReady: () => consumer.lastSlot > 0n,
      })
    : null;

  if (options.skipPriceWarmup !== true) {
    // Without a warm series every swap in the first minutes is written
    // unpriced, and those rows would need re-backfilling to fix.
    const loaded = await services.prices.warm(STREAM_PRICE_WARM_HOURS).catch((error: unknown) => {
      logger.warn({ err: describeError(error) }, 'could not warm the SOL/USD series');
      return 0;
    });
    logger.info({ minutes: loaded }, 'SOL/USD series warmed');
  }

  logger.info({ endpoint, programs: PARSED_PROGRAM_IDS }, 'starting stream consumer');

  await Promise.all([
    consumer.run(controller.signal),
    services.prices.runLiveRefresh(LIVE_PRICE_INTERVAL_MS, controller.signal),
  ]);

  server?.close();
  logger.info({ lastSlot: consumer.lastSlot.toString() }, 'stream consumer stopped');
}

export interface BackfillOptions extends BackfillRequest {
  /** Fill the SOL/USD series over the same window before crawling. */
  readonly withPrices?: boolean;
}

export async function backfill(
  services: Services,
  options: BackfillOptions,
): Promise<BackfillResult & { pricesReady: boolean }> {
  const runner = createBackfillRunner(services);
  const controller = shutdownSignal(services.logger);

  const fromSec =
    options.fromSec ?? nowSeconds() - daysToSeconds(services.config.BACKFILL_DEFAULT_DAYS);

  let pricesReady = options.withPrices === false;
  if (options.withPrices !== false) {
    try {
      // Priced rows require the series to already cover the window; doing it
      // after the crawl would leave every row written unpriced.
      await services.prices.ensureRange(fromSec, nowSeconds(), controller.signal);
      pricesReady = true;
    } catch (error) {
      /*
       * A price feed that refuses must not cost the crawl.
       *
       * It did: `ensureRange` threw before a single transaction was read, so a
       * year-long backfill against a rate-limited Benchmarks wrote nothing at
       * all. Unpriced rows are the lesser loss by a wide margin — an unpriced
       * swap is still a real swap — and both tables are `ReplacingMergeTree`
       * keyed on the swap's own identity, so re-running once the feed recovers
       * replaces these rows rather than duplicating them. The window Pyth did
       * manage is already stored, so each run converges.
       */
      services.logger.warn(
        { err: describeError(error) },
        'the SOL/USD series could not be filled; crawling anyway and writing what is found unpriced. Re-run this backfill once the feed recovers and the rows will be replaced with priced ones',
      );
    }
  }

  const result = await runner.run({ ...options, fromSec }, controller.signal);
  await services.writer.flush();

  /*
   * Record what this run covered, so a reader can tell empty from unread.
   *
   * Written after the flush, and only when the crawl reached the cutoff it was
   * asked for: a run cut short covers less than its window claims, and a
   * coverage row is a promise that the index can answer for this wallet over
   * this range. A wallet with zero swaps still gets a row — that is a real
   * answer, and the whole point is to stop it looking like an unread one.
   */
  if (result.reachedCutoff) {
    await services.walletCoverage.record({
      wallet: options.address,
      fromTs: fromSec,
      toTs: nowSeconds(),
      swaps: result.swapsWritten,
      pricesReady,
    });
  }

  return { ...result, pricesReady };
}

export async function enqueue(services: Services, request: BackfillRequest): Promise<string> {
  const connection = createRedis(services.config.REDIS_URL);
  const queue = createBackfillQueue(connection);
  try {
    const job = await enqueueBackfill(queue, request);
    services.logger.info({ jobId: job.id, address: request.address }, 'backfill enqueued');
    return job.id ?? '(unknown)';
  } finally {
    await queue.close();
    await connection.quit();
  }
}

export async function worker(services: Services): Promise<void> {
  const runner = createBackfillRunner(services);
  const controller = shutdownSignal(services.logger);
  const connection = createRedis(services.config.REDIS_URL);

  const backfillWorker = createBackfillWorker({
    connection,
    runner,
    concurrency: services.config.BACKFILL_CONCURRENCY,
    logger: services.logger,
  });

  const server = services.config.METRICS_ENABLED
    ? startMetricsServer({
        port: services.config.METRICS_PORT,
        metrics: services.metrics,
        logger: services.logger,
      })
    : null;

  services.logger.info(
    { concurrency: services.config.BACKFILL_CONCURRENCY },
    'backfill worker started',
  );

  await new Promise<void>((resolve) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });

  // Let in-flight jobs finish before the connection goes away, or they are
  // retried from the start on the next boot.
  await backfillWorker.close();
  await connection.quit();
  server?.close();
}

export interface PricesOptions {
  readonly fromSec?: number;
  readonly toSec?: number;
  readonly days?: number;
}

export async function prices(services: Services, options: PricesOptions): Promise<void> {
  const toSec = options.toSec ?? nowSeconds();
  const fromSec = options.fromSec ?? toSec - daysToSeconds(options.days ?? 7);
  const controller = shutdownSignal(services.logger);

  const result = await services.prices.ensureRange(fromSec, toSec, controller.signal);
  services.logger.info(result, 'SOL/USD backfill complete');
}

export interface VerifyOptions {
  readonly mint: string;
  readonly windowHours?: 1 | 6 | 24;
  readonly tolerance?: number;
}

/** Returns true when the count is within tolerance; the CLI turns that into an exit code. */
export async function verify(
  services: Services,
  options: VerifyOptions,
  write: (line: string) => void,
): Promise<boolean> {
  const report = await verifySwapCount({
    mint: options.mint,
    repository: services.swaps,
    ...(options.windowHours === undefined ? {} : { windowHours: options.windowHours }),
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
  });

  write(formatVerifyReport(report));
  return report.withinTolerance;
}

/**
 * Decodes one transaction and prints what the parsers made of it.
 *
 * The verification path for every hardcoded discriminator and event layout in
 * this repo: point it at a known pump.fun or PumpSwap transaction and the
 * decoded amounts either match the explorer or they do not.
 */
export async function dumpTransaction(
  services: Services,
  signature: string,
  write: (line: string) => void,
): Promise<void> {
  if (services.rpc === null) {
    throw new ConfigError('SOLANA_RPC_URL is required to dump a transaction');
  }

  const response = await services.rpc.getTransaction(signature);
  if (response === null) {
    write(`transaction not found: ${signature}`);
    return;
  }

  const raw = fromRpcTransaction(response);
  const ctx = TxContext.from(raw);
  const { swaps, skipped } = parseTransaction(ctx);

  write(`signature   ${raw.signature}`);
  write(`slot        ${raw.slot}`);
  write(`blockTime   ${raw.blockTime ?? '(none)'}`);
  write(`failed      ${raw.failed}`);
  write(`accounts    ${ctx.accountKeys.length}`);
  write(`instructions ${ctx.nodes.length} (incl. inner)`);
  write('');

  for (const node of ctx.nodes) {
    if (!PARSED_PROGRAM_IDS.includes(node.programId)) continue;
    write(
      `  ix ${node.ixIndex}.${node.innerIxIndex} depth=${node.stackHeight} program=${node.programId} bytes=${node.data.length}`,
    );
  }
  write('');

  write(`parsed swaps: ${swaps.length}`);
  for (const swap of swaps) {
    write(
      [
        `  ${swap.venue} ${swap.side}`,
        `mint=${swap.mint}`,
        `wallet=${swap.wallet}`,
        `pool=${swap.poolId}`,
        `base=${swap.baseAmount} (dec ${swap.baseDecimals ?? '?'})`,
        `quote=${swap.quoteAmount} (dec ${swap.quoteDecimals ?? '?'}) ${swap.quoteMint}`,
        `fee=${swap.quoteFeeAmount ?? 'unknown'}`,
        `blockTime=${swap.blockTime ?? '(none)'}`,
      ].join(' '),
    );
  }

  if (skipped.length > 0) {
    write('');
    write(`skipped: ${skipped.length}`);
    for (const skip of skipped) {
      write(
        `  ${skip.venue} ${skip.reason} ix=${skip.ixIndex}.${skip.innerIxIndex} ${skip.detail ?? ''}`,
      );
    }
  }
}

function createBackfillRunner(services: Services): BackfillRunner {
  if (services.rpc === null) {
    throw new ConfigError('SOLANA_RPC_URL is required for backfill');
  }
  return new BackfillRunner({
    rpc: services.rpc,
    pipeline: services.pipeline,
    writer: services.writer,
    metrics: services.metrics,
    logger: services.logger,
    defaultDays: services.config.BACKFILL_DEFAULT_DAYS,
    pageSize: services.config.BACKFILL_SIGNATURE_PAGE_SIZE,
    transactionBatch: services.config.BACKFILL_TRANSACTION_BATCH,
  });
}

export type { Logger };
