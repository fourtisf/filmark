/**
 * Error taxonomy.
 *
 * The distinction that matters operationally is `retryable`: the stream and
 * backfill loops back off and retry on those, and drop-with-a-counter on the
 * rest. A malformed instruction must never stall ingest.
 */

export interface AppErrorOptions {
  readonly cause?: unknown;
  readonly context?: Readonly<Record<string, unknown>>;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.context = options.context ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/** Bad or missing configuration. Never retryable — the process should exit. */
export class ConfigError extends AppError {
  readonly code = 'CONFIG';
  readonly retryable = false;
}

/**
 * A transaction, instruction or event we could not decode. Retrying will not
 * help; the row is dropped and counted so the gap is visible.
 */
export class DecodeError extends AppError {
  readonly code = 'DECODE';
  readonly retryable = false;
}

/** The upstream data is decodable but internally inconsistent. */
export class DataIntegrityError extends AppError {
  readonly code = 'DATA_INTEGRITY';
  readonly retryable = false;
}

/** A network or remote-service failure that is worth another attempt. */
export class UpstreamError extends AppError {
  readonly code = 'UPSTREAM';
  readonly retryable = true;
}

/** Storage failed. Assumed transient; the writer retries then surfaces it. */
export class StorageError extends AppError {
  readonly code = 'STORAGE';
  readonly retryable = true;
}

/** Raised when a shutdown signal interrupts in-flight work. */
export class AbortedError extends AppError {
  readonly code = 'ABORTED';
  readonly retryable = false;
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AppError && error.retryable;
}

/**
 * Turns anything thrown into something loggable without losing the stack.
 *
 * The cause chain is walked, because the wrapping this codebase does is exactly
 * where the useful part lives: an `UpstreamError('RPC getTransaction failed')`
 * says nothing on its own, and the `TypeError: fetch failed` -> `ECONNRESET`
 * underneath it is the whole diagnosis. `AppError.toJSON()` omits `cause` and
 * pino cannot reach it either, so an unwalked chain is an unloggable one.
 *
 * `seen` guards a cycle: a wrapper holds a reference to what it wrapped, and a
 * self-referencing chain would otherwise recurse until the stack goes — inside
 * a catch handler, which is the worst place to fail.
 */
export function describeError(
  error: unknown,
  seen: Set<unknown> = new Set<unknown>(),
): Record<string, unknown> {
  if (error === null || error === undefined) {
    return { name: 'UnknownError', message: String(error) };
  }
  if (seen.has(error)) return { name: 'CircularCause', message: '[circular]' };
  seen.add(error);

  const cause = (error as { cause?: unknown }).cause;
  const chained =
    cause === undefined || cause === null ? {} : { cause: describeError(cause, seen) };

  if (error instanceof AppError) return { ...error.toJSON(), stack: error.stack, ...chained };
  if (error instanceof Error) {
    // Node attaches these to system errors and they are the first thing worth
    // reading — ECONNRESET, ENOTFOUND, ETIMEDOUT all arrive this way.
    const extra: Record<string, unknown> = {};
    for (const key of ['code', 'errno', 'syscall'] as const) {
      const value = (error as unknown as Record<string, unknown>)[key];
      if (value !== undefined) extra[key] = value;
    }
    return { name: error.name, message: error.message, stack: error.stack, ...extra, ...chained };
  }
  return { name: 'UnknownError', message: stringifyThrown(error) };
}

/**
 * Renders a thrown non-Error.
 *
 * `String({ code: 'X' })` is "[object Object]", which loses the only thing the
 * value carried. JSON at least keeps the fields.
 */
function stringifyThrown(value: NonNullable<unknown>): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name}]`;
    default:
      try {
        // Circular or BigInt-bearing objects make this throw, and a describer
        // that throws inside a catch handler loses the original error entirely.
        return JSON.stringify(value) ?? Object.prototype.toString.call(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
  }
}
