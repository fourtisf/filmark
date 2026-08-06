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
  const controller = shutdownSignal(services.logger);
  return runBackfill(services, createBackfillRunner(services), options, controller.signal);
}

/**
 * One whole backfill: fill the prices, crawl, flush, record the coverage.
 *
 * Extracted from the command because the queue worker used to call
 * `runner.run` on its own, which does the crawl and none of the rest. Rows
 * landed in ClickHouse and no `wallet_coverage` row was ever written, so the
 * index refused to answer for every wallet the queue had indexed — a backfill
 * that worked perfectly and changed nothing anybody could see. Two callers, one
 * definition of what a backfill is.
 *
 * Takes a signal rather than installing its own handlers: a worker owns process
 * lifetime for many jobs, and one `shutdownSignal` per job leaks a listener
 * apiece until Node starts warning about it.
 */
export async function runBackfill(
  services: Services,
  runner: BackfillRunner,
  options: BackfillOptions,
  signal: AbortSignal,
): Promise<BackfillResult & { pricesReady: boolean }> {
  const fromSec =
    options.fromSec ?? nowSeconds() - daysToSeconds(services.config.BACKFILL_DEFAULT_DAYS);

  /*
   * True only when this run actually filled the series across the window.
   *
   * It used to start at `true` whenever `--no-prices` was passed, on the
   * reasoning that an operator who skips the fill must have filled it already.
   * That is an assumption stored as a measurement (§7.1) — and it is stored in
   * the same row a reader consults to decide whether the index can be trusted.
   * Skipping the fill is not evidence about prices in either direction, so the
   * claim is not made. What a swap was actually worth is measured off the rows
   * themselves and reported as `swapsUnpriced`; that is the number to read.
   */
  let pricesReady = false;
  if (options.withPrices !== false) {
    const budget = AbortSignal.timeout(services.config.BACKFILL_PRICE_TIMEOUT_MS);
    try {
      // Priced rows require the series to already cover the window; doing it
      // after the crawl would leave every row written unpriced.
      //
      // Bounded, because Benchmarks meters over a window and answers
      // `Retry-After: 59` on each one it refuses. A year is 106 windows, so a
      // client that obeys literally spends hours before a single transaction
      // is read — which looks exactly like a hung backfill.
      await services.prices.ensureRange(fromSec, nowSeconds(), AbortSignal.any([signal, budget]));
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
       * replaces these rows rather than duplicating them. Whatever minutes Pyth
       * did hand over are already stored, so each run converges.
       */
      services.logger.warn(
        { err: describeError(error), ranOutOfTime: budget.aborted },
        'the SOL/USD series was not filled across the whole window; crawling anyway. Swaps landing in minutes the series does reach are still priced, the rest are written unpriced. Re-run this backfill later and those rows are replaced with priced ones',
      );
    }
  }

  const result = await runner.run({ ...options, fromSec }, signal);
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
    // The same thing the CLI does, coverage row and all — otherwise a wallet
    // this worker indexes is one the trace API still refuses to serve.
    run: (request) => runBackfill(services, runner, request, controller.signal),
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
    {
      concurrency: services.config.BACKFILL_CONCURRENCY,
      indexRequestPollMs: services.config.INDEX_REQUEST_POLL_MS,
    },
    'backfill worker started',
  );

  await Promise.all([
    new Promise<void>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    }),
    drainIndexRequests(services, runner, controller.signal),
  ]);

  // Let in-flight jobs finish before the connection goes away, or they are
  // retried from the start on the next boot.
  await backfillWorker.close();
  await connection.quit();
  server?.close();
}

/**
 * Reads the wallets the trace API could not answer, and pays for them properly.
 *
 * This is the half that removes the ritual. Indexing used to mean an operator
 * running a command per wallet on a server, which does not scale past the
 * wallets that operator personally knows about — and every other visitor got
 * the dead end instead. The API now writes down the wallets it failed on, and
 * this drains that list on a timer.
 *
 * Sequential on purpose. A backfill is thousands of `getTransaction` calls, and
 * the RPC allowance is shared with the trace API serving live visitors; running
 * several of these at once would take the site down to fill a queue faster than
 * anybody is reading it. One at a time, forever, is the correct rate.
 */
async function drainIndexRequests(
  services: Services,
  runner: BackfillRunner,
  signal: AbortSignal,
): Promise<void> {
  const { config, logger } = services;

  while (!signal.aborted) {
    try {
      const pending = await services.indexRequests.pending({
        limit: 1,
        stalenessSec: config.INDEX_REQUEST_STALENESS_SEC,
      });

      const next = pending[0];
      if (next !== undefined) {
        logger.info(
          { wallet: next.wallet, days: next.days, reason: next.reason },
          'indexing a wallet the trace API could not read inside a request',
        );
        const result = await runBackfill(
          services,
          runner,
          { address: next.wallet, fromSec: nowSeconds() - daysToSeconds(next.days) },
          signal,
        );
        logger.info(
          { wallet: next.wallet, swaps: result.swapsWritten, pricesReady: result.pricesReady },
          'wallet indexed; the next trace of it is answered from the index',
        );
        // Straight back round rather than sleeping: the coverage row this just
        // wrote is what takes it off the pending list, so the next query
        // returns the wallet behind it.
        continue;
      }
    } catch (error) {
      /*
       * A failing wallet must not stop the drain.
       *
       * Nothing is marked done and nothing is marked failed — the pending list
       * is a join against coverage, so a wallet that throws is simply still
       * outstanding and comes round again. The sleep below is what keeps a
       * permanently broken one from spinning.
       */
      logger.warn({ err: describeError(error) }, 'index request failed; it stays outstanding');
    }

    await sleep(config.INDEX_REQUEST_POLL_MS, signal);
  }
}

/** Resolves after `ms`, or as soon as the signal aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
