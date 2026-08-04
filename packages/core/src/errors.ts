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

/** Turns anything thrown into something loggable without losing the stack. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) return { ...error.toJSON(), stack: error.stack };
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'UnknownError', message: String(error) };
}
