#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AbortedError, AppError, ConfigError, describeError } from '@exitliquidity/core';
import {
  backfill,
  dumpTransaction,
  enqueue,
  migrate,
  prices,
  stream,
  verify,
  worker,
} from './commands.js';
import { loadEnvFile } from './env.js';
import { createServices } from './services.js';

const USAGE = `
exitliquidity — swap ingest (P0)

  migrate                       Create the database and apply pending migrations
  stream                        Run the Yellowstone gRPC consumer until interrupted
  backfill <address>            Crawl an account's history through the same pipeline
  enqueue <address>             Queue a backfill for the worker to pick up
  worker                        Run the BullMQ backfill worker
  prices                        Fill the SOL/USD 1-minute series from Pyth
  verify-count <mint>           Compare our swap count against Dexscreener (P0 gate)
  dump-tx <signature>           Decode one transaction and print what the parsers saw

Options
  --days <n>                    Lookback window for backfill and prices
  --from <iso|unix>             Explicit window start
  --to <iso|unix>               Explicit window end (prices only)
  --until <signature>           Stop a backfill when this signature is reached
  --max <n>                     Cap on transactions fetched by a backfill
  --no-prices                   Skip the SOL/USD fill a backfill would otherwise do
  --hours <1|6|24>              Comparison window for verify-count (default 24)
  --tolerance <fraction>        Acceptance tolerance for verify-count (default 0.02)
  --help                        Show this message

Configuration is read from the environment; see .env.example.
`.trim();

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      until: { type: 'string' },
      max: { type: 'string' },
      hours: { type: 'string' },
      tolerance: { type: 'string' },
      'no-prices': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, argument] = positionals;

  if (values.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }

  // Nothing else reads .env. Say which file was used, on stderr so it never
  // contaminates a command's output: a config error whose cause is an unread
  // file is indistinguishable from one whose cause is an unset variable.
  const envFile = loadEnvFile();
  if (envFile !== null) process.stderr.write(`env: ${envFile}\n`);

  const services = createServices();

  try {
    switch (command) {
      case 'migrate':
        await migrate(services);
        return 0;

      case 'stream':
        await stream(services);
        return 0;

      case 'backfill': {
        const result = await backfill(services, {
          address: requireArgument(argument, 'backfill <address>'),
          ...compact({
            fromSec: windowStart(values.from, values.days),
            untilSignature: values.until,
            maxTransactions: parseInteger(values.max, 'max'),
          }),
          withPrices: !values['no-prices'],
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      case 'enqueue': {
        const jobId = await enqueue(services, {
          address: requireArgument(argument, 'enqueue <address>'),
          ...compact({
            fromSec: windowStart(values.from, values.days),
            untilSignature: values.until,
            maxTransactions: parseInteger(values.max, 'max'),
          }),
        });
        process.stdout.write(`${jobId}\n`);
        return 0;
      }

      case 'worker':
        await worker(services);
        return 0;

      case 'prices':
        await prices(
          services,
          compact({
            fromSec: parseTimestamp(values.from),
            toSec: parseTimestamp(values.to),
            days: parseNumber(values.days, 'days'),
          }),
        );
        return 0;

      case 'verify-count': {
        const passed = await verify(
          services,
          {
            mint: requireArgument(argument, 'verify-count <mint>'),
            ...compact({
              windowHours: parseWindowHours(values.hours),
              tolerance: parseNumber(values.tolerance, 'tolerance'),
            }),
          },
          (line) => process.stdout.write(`${line}\n`),
        );
        // Non-zero on failure so CI can gate on the P0 acceptance criterion.
        return passed ? 0 : 1;
      }

      case 'dump-tx':
        await dumpTransaction(services, requireArgument(argument, 'dump-tx <signature>'), (line) =>
          process.stdout.write(`${line}\n`),
        );
        return 0;

      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
        return 1;
    }
  } finally {
    await services.close();
  }
}

function requireArgument(value: string | undefined, usage: string): string {
  if (value === undefined || value === '') throw new ConfigError(`missing argument: ${usage}`);
  return value;
}

/**
 * Drops undefined entries so an unset flag leaves the key absent rather than
 * present-and-undefined, which `exactOptionalPropertyTypes` rejects and which
 * would otherwise override a default downstream.
 */
function compact<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function parseNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`--${label} must be a number, got ${value}`);
  return parsed;
}

function parseInteger(value: string | undefined, label: string): number | undefined {
  const parsed = parseNumber(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`--${label} must be a positive integer, got ${value}`);
  }
  return parsed;
}

/** Accepts either unix seconds or anything `Date` understands. */
function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ConfigError(`could not parse timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

function parseWindowHours(value: string | undefined): 1 | 6 | 24 | undefined {
  if (value === undefined) return undefined;
  if (value === '1' || value === '6' || value === '24') return Number(value) as 1 | 6 | 24;
  throw new ConfigError('--hours must be 1, 6 or 24 — those are the windows Dexscreener publishes');
}

/** `--from` wins over `--days`; an explicit instant beats a relative window. */
function windowStart(from: string | undefined, days: string | undefined): number | undefined {
  const explicit = parseTimestamp(from);
  if (explicit !== undefined) return explicit;

  const lookback = parseNumber(days, 'days');
  if (lookback === undefined) return undefined;
  if (lookback <= 0) throw new ConfigError(`--days must be positive, got ${String(days)}`);
  return Math.floor(Date.now() / 1000) - Math.round(lookback * 24 * 3600);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const described = describeError(error);
    process.stderr.write(`${JSON.stringify(described, null, 2)}\n`);
    // Configuration problems get their own code so a supervisor can tell
    // "restart me" from "I will never start". An interrupted run gets 130, the
    // shell's convention for SIGINT, so a Ctrl+C is never read as a crash.
    process.exitCode =
      error instanceof AbortedError
        ? 130
        : error instanceof AppError && error.code === 'CONFIG'
          ? 78
          : 1;
  });
