import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';

export type { Logger };

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  readonly name?: string;
  /** Human-readable output for local runs; JSON everywhere else. */
  readonly pretty?: boolean;
}

/**
 * BigInt is everywhere in this codebase (slots, raw token amounts) and
 * `JSON.stringify` throws on it, so serialise it before pino sees it.
 */
const baseOptions: LoggerOptions = {
  // No pid or hostname: these run in containers where both are noise, and the
  // orchestrator already labels the stream.
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map(replaceBigInts) as Parameters<typeof method>);
    },
  },
};

function replaceBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(replaceBigInts);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = replaceBigInts(inner);
  }
  return out;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { level = 'info', name, pretty = false } = options;
  return pino({
    ...baseOptions,
    level,
    ...(name === undefined ? {} : { name }),
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });
}

/** A logger that discards everything. Handy in tests and pure helpers. */
export const silentLogger: Logger = pino({ level: 'silent' });
