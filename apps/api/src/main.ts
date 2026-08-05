#!/usr/bin/env node
import {
  ConfigError,
  SECONDS_PER_MINUTE,
  describeError,
  loadConfig,
  loadEnvFile,
  nowSeconds,
} from '@exitliquidity/core';
import { createHttpServer } from './http.js';
import { createServices, worstCaseTraceSeconds } from './services.js';

/** Same codes the ingest CLI uses, so a process manager can treat them alike. */
const EXIT_FAILURE = 1;
const EXIT_CONFIG = 78;

async function main(): Promise<number> {
  const envPath = loadEnvFile();
  // stderr, and before the logger exists: a missing variable and an unread file
  // are different problems, and telling them apart needs the path either way.
  process.stderr.write(
    envPath === null
      ? 'no .env file found; using the environment as-is\n'
      : `loaded env from ${envPath}\n`,
  );

  const config = loadConfig();
  const services = createServices(config);
  const { logger } = services;

  const server = createHttpServer({
    traces: services.traces,
    cache: services.cache,
    semaphore: services.semaphore,
    metrics: services.metrics,
    corsOrigins: services.corsOrigins,
    traceTimeoutMs: config.API_TRACE_TIMEOUT_MS,
    logger,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.API_PORT, config.API_HOST, resolve);
  });

  logger.info(
    {
      host: config.API_HOST,
      port: config.API_PORT,
      // `endpoint` is host and path only. Every provider puts the API key in
      // the query string, so the full URL never reaches a log line.
      rpc: services.rpcEndpoint,
      lookbackDays: config.TRACE_LOOKBACK_DAYS,
      cors: services.corsOrigins.length === 0 ? 'none' : services.corsOrigins.join(','),
    },
    'trace API listening',
  );

  if (services.corsOrigins.length === 0) {
    logger.warn(
      'API_CORS_ORIGINS is empty, so no browser on another origin can call this. Set it to the site origin, e.g. https://fillmark.xyz',
    );
  }

  const worstCase = worstCaseTraceSeconds(config);
  const timeoutSec = config.API_TRACE_TIMEOUT_MS / 1000;
  logger.info(
    { worstCaseSeconds: Math.round(worstCase), timeoutSeconds: timeoutSec },
    'trace budget',
  );
  if (worstCase > timeoutSec) {
    logger.warn(
      { worstCaseSeconds: Math.round(worstCase), timeoutSeconds: timeoutSec },
      'the trace budget outruns the request timeout, so a heavy wallet will be cut short by the clock and return a partial answer marked stoppedOnTimeBudget. That is the intended degradation, not a fault — but if it is happening on ordinary wallets, lower TRACE_MAX_SIGNATURES, raise SOLANA_RPC_MAX_RPS, or raise API_TRACE_TIMEOUT_MS',
    );
  }

  // A proxy or CDN in front of this has its own ceiling — Cloudflare's is 100
  // seconds — and it does not care what this one is set to. A trace that runs
  // past it is answered by the proxy with an error page the console cannot
  // parse, which reads as "the engine did not answer" rather than as a timeout.
  if (timeoutSec > 90) {
    logger.warn(
      { timeoutSeconds: timeoutSec },
      "API_TRACE_TIMEOUT_MS is above 90s; if anything proxies this service, set it below that proxy's own response timeout or slow traces will be answered by the proxy instead of by this API",
    );
  }

  /*
   * Prove the price feed answers, without making anyone wait for the proof.
   *
   * With no SOL/USD series there is no cost basis, so every trace comes back
   * `unpriced_history` — correct, and discovered two minutes into a crawl that
   * had nothing wrong with it. One hour of bars at startup turns that into a
   * line in the log before the first request arrives. Deliberately not part of
   * readiness: a trace with no prices still reports what it read, and refusing
   * to serve would be a worse answer than an honest partial one.
   */
  const nowSec = nowSeconds();
  void services.prices.ensure(nowSec - 60 * SECONDS_PER_MINUTE, nowSec).then(() => {
    const range = services.prices.seriesRange;
    if (range === null) {
      logger.warn(
        { benchmarks: config.PYTH_BENCHMARKS_URL },
        'the SOL/USD feed returned nothing at startup, so every trace will report unpriced_history until it answers. Check this host can reach PYTH_BENCHMARKS_URL',
      );
    } else {
      logger.info({ minutes: range.minutes }, 'SOL/USD feed answered');
    }
  });

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      server.close(() => {
        resolve();
      });
      // In-flight traces hold the socket open for as long as their RPC calls
      // take. A bounded grace period beats a container that will not stop.
      setTimeout(() => {
        resolve();
      }, 10_000).unref();
    };
    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  });

  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_CONFIG;
  } else {
    process.stderr.write(`${JSON.stringify(describeError(error), null, 2)}\n`);
    process.exitCode = EXIT_FAILURE;
  }
}
