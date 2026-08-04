import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { StorageError, type Config } from '@exitliquidity/core';

export type { ClickHouseClient };

export interface ClickHouseOptions {
  readonly url: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  readonly requestTimeoutMs?: number;
  readonly maxInsertRows?: number;
  readonly maxInsertDelayMs?: number;
}

export function clickHouseOptionsFromConfig(config: Config): ClickHouseOptions {
  return {
    url: config.CLICKHOUSE_URL,
    database: config.CLICKHOUSE_DATABASE,
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
    requestTimeoutMs: config.CLICKHOUSE_REQUEST_TIMEOUT_MS,
    maxInsertRows: config.CLICKHOUSE_MAX_INSERT_ROWS,
    maxInsertDelayMs: config.CLICKHOUSE_MAX_INSERT_DELAY_MS,
  };
}

/**
 * Builds a client pointed at the swap store.
 *
 * `async_insert` is deliberately off. Batching is the writer's job and it
 * already does it; layering server-side buffering on top would make an
 * acknowledged insert stop meaning the row is durable, which is exactly the
 * property the checkpoint logic relies on.
 */
export function createClickHouseClient(options: ClickHouseOptions): ClickHouseClient {
  return createClient({
    url: options.url,
    database: options.database,
    username: options.username,
    password: options.password,
    request_timeout: options.requestTimeoutMs ?? 30_000,
    compression: { response: true, request: false },
    clickhouse_settings: {
      async_insert: 0,
      date_time_input_format: 'best_effort',
      // Large UInt64 values are exact as strings and lossy as JSON numbers.
      output_format_json_quote_64bit_integers: 1,
    },
  });
}

/**
 * Creates the target database if it is missing.
 *
 * Run against the server's default database, since the target may not exist
 * yet — which is the entire point.
 */
export async function ensureDatabase(options: ClickHouseOptions): Promise<void> {
  const bootstrap = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    request_timeout: options.requestTimeoutMs ?? 30_000,
  });

  try {
    await bootstrap.command({
      query: `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(options.database)}`,
    });
  } catch (error) {
    throw new StorageError(`could not create database ${options.database}`, {
      cause: error,
      context: { database: options.database },
    });
  } finally {
    await bootstrap.close();
  }
}

/**
 * Quotes an identifier for interpolation.
 *
 * Only ever used for names that come from configuration, never from a request,
 * but a database name with a backtick in it should still fail loudly rather
 * than produce a malformed statement.
 */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new StorageError(`unsafe ClickHouse identifier: ${name}`, { context: { name } });
  }
  return `\`${name}\``;
}
