#!/usr/bin/env node
import { ConfigError, describeError, loadConfig, loadEnvFile } from '@exitliquidity/core';
import { createHttpServer } from './http.js';
import { createServices } from './services.js';

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
