import {
  RateLimiter,
  UpstreamError,
  describeError,
  retry,
  type Logger,
  silentLogger,
} from '@exitliquidity/core';
import type { RpcTransactionResponse } from './adapters/rpc.js';

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface SolanaRpcOptions {
  readonly url: string;
  readonly maxRequestsPerSecond?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly commitment?: Commitment;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
}

export interface SignatureInfo {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown;
}

export interface GetSignaturesOptions {
  readonly limit?: number;
  /** Page backwards from this signature (exclusive). */
  readonly before?: string;
  /** Stop once this signature is reached (exclusive). */
  readonly until?: string;
  readonly signal?: AbortSignal;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

/**
 * A small JSON-RPC client covering exactly what backfill needs.
 *
 * Rate limited client-side because a backfill will otherwise exhaust a shared
 * key in seconds, and retried with backoff on the transport and 429/5xx errors
 * that every provider produces under load.
 */
export class SolanaRpcClient {
  readonly #url: string;
  readonly #limiter: RateLimiter;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #commitment: Commitment;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: SolanaRpcOptions) {
    this.#url = options.url;
    this.#limiter = new RateLimiter(options.maxRequestsPerSecond ?? 10);
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#commitment = options.commitment ?? 'confirmed';
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async getSlot(signal?: AbortSignal): Promise<number> {
    return this.#call<number>('getSlot', [{ commitment: this.#commitment }], signal);
  }

  async getBlockTime(slot: number, signal?: AbortSignal): Promise<number | null> {
    return this.#call<number | null>('getBlockTime', [slot], signal);
  }

  /**
   * One page of signatures that touched `address`, newest first.
   *
   * RPC caps `limit` at 1000 and always pages backwards, so a backfill walks
   * from now towards the cutoff rather than the other way around.
   */
  async getSignaturesForAddress(
    address: string,
    options: GetSignaturesOptions = {},
  ): Promise<SignatureInfo[]> {
    const params: Record<string, unknown> = {
      limit: Math.min(options.limit ?? 1000, 1000),
      commitment: this.#commitment,
    };
    if (options.before !== undefined) params['before'] = options.before;
    if (options.until !== undefined) params['until'] = options.until;

    const result = await this.#call<
      { signature: string; slot: number; blockTime?: number | null; err: unknown }[] | null
    >('getSignaturesForAddress', [address, params], options.signal);

    return (result ?? []).map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime ?? null,
      err: entry.err,
    }));
  }

  /** Returns null when the transaction has been pruned or is not yet available. */
  async getTransaction(
    signature: string,
    signal?: AbortSignal,
  ): Promise<RpcTransactionResponse | null> {
    return this.#call<RpcTransactionResponse | null>(
      'getTransaction',
      [
        signature,
        {
          encoding: 'json',
          commitment: this.#commitment === 'processed' ? 'confirmed' : this.#commitment,
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    );
  }

  /**
   * Decimals for each mint, in the order requested. Null where the account is
   * missing or is not a mint.
   */
  async getMintDecimals(
    mints: readonly string[],
    signal?: AbortSignal,
  ): Promise<(number | null)[]> {
    if (mints.length === 0) return [];

    const result = await this.#call<{
      value: ({ data?: { parsed?: { info?: { decimals?: number } } } } | null)[];
    }>(
      'getMultipleAccounts',
      [mints, { encoding: 'jsonParsed', commitment: this.#commitment }],
      signal,
    );

    return result.value.map((account) => {
      const decimals = account?.data?.parsed?.info?.decimals;
      return typeof decimals === 'number' ? decimals : null;
    });
  }

  async #call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    return retry(
      async (attempt) => {
        await this.#limiter.acquire(signal);
        const id = this.#nextId++;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, this.#timeoutMs);
        const onAbort = (): void => {
          controller.abort();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
          const response = await this.#fetch(this.#url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            signal: controller.signal,
          });

          if (!response.ok) {
            // 429 and 5xx are the shapes rate limits and provider hiccups take.
            // The body is where the provider says which limit was hit and for
            // how long; a bare status number sends the operator guessing.
            const text = await response.text().catch(() => '<unreadable>');
            throw new UpstreamError(`RPC ${method} returned HTTP ${response.status}`, {
              context: {
                method,
                status: response.status,
                attempt,
                retryAfter: response.headers.get('retry-after'),
                body: text.slice(0, 500),
              },
            });
          }

          const body = (await response.json()) as JsonRpcResponse<T>;
          if (body.error !== undefined) {
            throw rpcError(method, body.error, attempt);
          }
          if (body.result === undefined) {
            throw new UpstreamError(`RPC ${method} returned neither result nor error`, {
              context: { method, attempt },
            });
          }
          return body.result;
        } catch (error) {
          if (error instanceof UpstreamError) throw error;
          // The identity of the underlying failure goes into context as well as
          // cause: context survives JSON.stringify at the CLI boundary, which is
          // where an operator reads it, and cause only survives describeError.
          throw new UpstreamError(`RPC ${method} failed`, {
            cause: error,
            context: {
              method,
              attempt,
              causeName: error instanceof Error ? error.name : typeof error,
              causeMessage: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      },
      {
        maxAttempts: this.#maxAttempts,
        minMs: 250,
        maxMs: 8000,
        ...(signal === undefined ? {} : { signal }),
        onRetry: (error, attempt, delayMs) => {
          // A retry is expected behaviour, not a failure, and the stack is
          // identical every time — the same four frames from this method. Under
          // a rate limit that stack is printed hundreds of times and buries the
          // one line that matters. Message and context carry the diagnosis:
          // status, Retry-After, and the provider's own words.
          const { stack: _stack, ...compact } = describeError(error);
          this.#logger.warn({ method, attempt, delayMs, err: compact }, 'retrying RPC call');
        },
      },
    );
  }
}

/**
 * -32602 and friends mean the request itself is wrong; retrying just burns
 * quota. Everything else is treated as transient.
 *
 * -32603 is deliberately absent from that set. It is JSON-RPC *Internal error*
 * — a fault on the server's side, and the generic bucket providers empty
 * overload into. Treating it as permanent gave up on attempt zero, and
 * `getSignaturesForAddress` has no catch around it, so one of them ended the
 * entire crawl.
 */
function rpcError(method: string, error: JsonRpcError, attempt: number): Error {
  const permanent = new Set([-32600, -32601, -32602]);
  const context = {
    method,
    code: error.code,
    attempt,
    ...(error.data === undefined ? {} : { data: error.data }),
  };
  const message = `RPC ${method} error ${error.code}: ${error.message}`;
  if (permanent.has(error.code)) {
    const err = new UpstreamError(message, { context });
    Object.defineProperty(err, 'retryable', { value: false });
    return err;
  }
  return new UpstreamError(message, { context });
}
