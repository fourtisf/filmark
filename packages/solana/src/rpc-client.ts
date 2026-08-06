import {
  RateLimiter,
  chunk,
  mapWithConcurrency,
  sleep,
  UpstreamError,
  describeError,
  retry,
  type Logger,
  silentLogger,
} from '@exitliquidity/core';

/** Host and path only: everything past `?` is a credential. */
function sanitiseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}
import type { RpcTransactionResponse } from './adapters/rpc.js';

/**
 * Transaction batches in flight at once.
 *
 * Not a way to exceed the rate limit — the limiter still hands out one slot at
 * a time — but a way to actually reach it when a round trip is slower than the
 * gap between slots. Small, because every one of these is a retry surface and a
 * provider counts them all against the same allowance.
 */
const TRANSACTION_BATCH_CONCURRENCY = 3;

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface SolanaRpcOptions {
  /**
   * One RPC endpoint, or several separated by commas.
   *
   * Several is the useful case: a rate limit belongs to a key, so the
   * allowances add up rather than compete, and a key that runs out of credit
   * mid-crawl takes its own traffic down and nothing else.
   */
  readonly url: string;
  readonly maxRequestsPerSecond?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  /**
   * Transactions per JSON-RPC batch request. 1 disables batching.
   *
   * Clamped to `maxRequestsPerSecond`: one batch arrives as a single burst, and
   * a burst wider than the provider's per-second allowance is refused however
   * patiently the client spaced it.
   */
  readonly batchSize?: number;
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
/**
 * One endpoint in the pool, with the state that is genuinely its own.
 *
 * A rate limit belongs to a key, not to a client, so two endpoints are two
 * separate allowances — and a key that has exhausted its credits says nothing
 * about the one beside it. Keeping the limiter and the cooldown per endpoint is
 * what lets a dead key stop the traffic to itself and nothing else.
 */
interface Endpoint {
  readonly url: string;
  readonly limiter: RateLimiter;
  /** Epoch ms before which this endpoint is not worth asking. */
  cooldownUntil: number;
  consecutiveFailures: number;
}

/**
 * Longest a refused endpoint is set aside before it is tried again.
 *
 * The base is deliberately short. Its job is to make the *next* pick prefer a
 * different key, and any positive value does that; a long one would mostly add
 * delay on a single-endpoint deployment, where the retry backoff is already the
 * thing doing the waiting.
 */
const MAX_COOLDOWN_MS = 30_000;
const COOLDOWN_BASE_MS = 250;

/** A rejected credential is not a busy moment; wait properly before retrying. */
const REJECTED_COOLDOWN_MS = 300_000;

export class SolanaRpcClient {
  readonly #endpoints: readonly Endpoint[];
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #batchSize: number;
  readonly #commitment: Commitment;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  #nextId = 1;
  #cursor = 0;

  constructor(options: SolanaRpcOptions) {
    const rps = options.maxRequestsPerSecond ?? 10;
    const requested = Math.max(1, options.batchSize ?? 20);

    /*
     * `url` may carry several, comma separated.
     *
     * One endpoint is one provider's opinion of how much you may ask, and that
     * opinion can change without notice — a plan downgrades, a monthly credit
     * runs out mid-trace, a region has a bad hour. With one URL every one of
     * those is total. With three it is a third of the throughput and a line in
     * the log, and the allowances add up rather than compete, because each key
     * is metered on its own.
     */
    const urls = [...new Set(options.url.split(',').map((entry) => entry.trim()))].filter(
      (entry) => entry !== '',
    );
    if (urls.length === 0) throw new RangeError('at least one RPC url is required');
    this.#endpoints = urls.map((url) => ({
      url,
      limiter: new RateLimiter(rps),
      cooldownUntil: 0,
      consecutiveFailures: 0,
    }));

    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#commitment = options.commitment ?? 'confirmed';
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;

    /*
     * A batch is a burst the limiter cannot smooth: it charges the full cost so
     * the *average* rate is right, but every call in it still lands in the same
     * millisecond. Clamping to the whole per-second allowance was not enough —
     * it puts an entire second's budget on the wire at one instant, and a
     * provider measuring a sliding window is still counting those when the next
     * batch arrives. A live endpoint refused every attempt at exactly that
     * setting, which reads as a dead key rather than as a batch too wide by
     * half. Half the allowance costs one extra round trip and leaves the meter
     * somewhere to breathe.
     */
    this.#batchSize = Math.min(requested, Math.max(1, Math.floor(rps / 2)));
    if (this.#batchSize < requested) {
      this.#logger.warn(
        { requested, applied: this.#batchSize, maxRequestsPerSecond: rps },
        'batch size reduced to half the per-second limit; a wider batch puts the whole allowance on the wire at once',
      );
    }
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

  /** How many transactions one JSON-RPC batch carries. */
  get transactionBatchSize(): number {
    return this.#batchSize;
  }

  /**
   * How many signatures to hand `getTransactions` at once to keep it busy.
   *
   * A caller that pre-chunks to `transactionBatchSize` and calls once per
   * chunk gets no overlap at all — every call contains exactly one batch, so
   * the concurrency inside has nothing to run alongside and the crawl waits out
   * every round trip. That is precisely what happened: the overlap was added,
   * the throughput did not move, and the reason was one caller chunking to the
   * wrong width. Chunk to this instead, and check whatever budget you keep
   * between windows rather than between batches.
   */
  get transactionWindowSize(): number {
    return this.#batchSize * this.#concurrency();
  }

  /**
   * Batches to keep in flight, which is not always the same question as rate.
   *
   * Providers meter more than one thing. Some cap requests per second, some cap
   * how many may be open at once, and a plan that refuses a fourth connection
   * refuses it however patiently the client spaced the first three. Backing the
   * *rate* off does nothing there: a live endpoint was slowed from ten calls a
   * second to under one and refused every step of the way, which no per-second
   * limit does. Serial is the shape that was working before the overlap was
   * added, so a throttled client returns to it rather than continuing to insist
   * on the concurrency that may be what is being refused.
   */
  #concurrency(): number {
    // One healthy endpoint is enough to keep overlapping; the pool only goes
    // serial when every key in it is pushing back.
    const anyHealthy = this.#endpoints.some((entry) => !entry.limiter.throttled);
    return anyHealthy ? TRANSACTION_BATCH_CONCURRENCY : 1;
  }

  /**
   * Where this client is pointed, safe to log.
   *
   * Host and path only. Every provider puts the API key in the query string, so
   * anything past `?` is a credential and never belongs in a log line.
   */
  get endpoint(): string {
    return this.#endpoints.map((entry) => sanitiseUrl(entry.url)).join(', ');
  }

  /** How many endpoints are in the pool. */
  get endpointCount(): number {
    return this.#endpoints.length;
  }

  /**
   * The endpoint that can take work soonest.
   *
   * Both halves matter: an endpoint in cooldown has told us it will refuse, and
   * an endpoint whose limiter is booked out for the next second is idle time we
   * do not have to spend. Picking the earliest of the two spreads a crawl over
   * every key that is willing, without a scheduler.
   */
  #pick(): Endpoint {
    const count = this.#endpoints.length;
    // Scanning from a rotating start makes ties alternate. Without it every
    // equal choice goes to the first endpoint, so a pool of healthy keys all
    // queue behind one and the rest are decoration — and a key just out of
    // cooldown is picked again the instant it ties, before it has proved
    // anything.
    const start = this.#cursor % count;
    let best = this.#endpoints[start] as Endpoint;
    let bestIndex = start;
    let bestAt = Math.max(best.cooldownUntil, best.limiter.availableAt);

    for (let step = 1; step < count; step += 1) {
      const index = (start + step) % count;
      const entry = this.#endpoints[index] as Endpoint;
      const at = Math.max(entry.cooldownUntil, entry.limiter.availableAt);
      if (at < bestAt) {
        best = entry;
        bestIndex = index;
        bestAt = at;
      }
    }

    this.#cursor = (bestIndex + 1) % count;
    return best;
  }

  /** Sets an endpoint aside, for longer each time it refuses in a row. */
  #cool(endpoint: Endpoint, baseMs: number): void {
    endpoint.consecutiveFailures += 1;
    const wait = Math.min(MAX_COOLDOWN_MS, baseMs * 2 ** (endpoint.consecutiveFailures - 1));
    endpoint.cooldownUntil = Date.now() + wait;
  }

  /**
   * Transactions for many signatures, in the order requested, null where one has
   * been pruned or is not yet available.
   *
   * One HTTP request per `batchSize` signatures. Public endpoints rate-limit per
   * RPC call, and a crawl that opens a connection per transaction spends its
   * entire budget on round trips: 200 transactions is 200 requests one way and
   * ten the other. JSON-RPC batching is in the 2.0 spec and Solana serves it.
   */
  async getTransactions(
    signatures: readonly string[],
    signal?: AbortSignal,
  ): Promise<(RpcTransactionResponse | null)[]> {
    if (signatures.length === 0) return [];

    if (this.#batchSize === 1) {
      const out: (RpcTransactionResponse | null)[] = [];
      for (const signature of signatures) out.push(await this.getTransaction(signature, signal));
      return out;
    }

    /*
     * Batches overlap; the limiter still decides the rate.
     *
     * Run end to end, batch N+1 does not leave until batch N has come back, so
     * the achieved rate is whichever is *slower*: the configured allowance, or
     * one batch per round trip. A ten-wide batch on a ten-per-second budget has
     * a second to play with, and a `getTransaction` batch that takes longer than
     * that spends the difference idle — a wallet crawl then runs at well under
     * the rate it was configured for and the config looks like a lie.
     *
     * This does not raise the rate. `acquire` hands out successive slots from
     * one schedule, so three callers get three consecutive slots rather than
     * three at once; overlapping them only fills the gap between a slot opening
     * and the previous response arriving. Order is preserved by the mapper, and
     * callers index into the result by position.
     */
    const groups = chunk([...signatures], this.#batchSize);
    const pages = await mapWithConcurrency(
      groups,
      Math.max(1, Math.min(this.#concurrency(), groups.length)),
      (group) => this.#transactionBatch(group, signal),
      signal,
    );
    return pages.flat();
  }

  async #transactionBatch(
    signatures: readonly string[],
    signal?: AbortSignal,
  ): Promise<(RpcTransactionResponse | null)[]> {
    const requests = signatures.map((signature) => ({
      jsonrpc: '2.0' as const,
      id: this.#nextId++,
      method: 'getTransaction',
      params: [
        signature,
        {
          encoding: 'json',
          commitment: this.#commitment === 'processed' ? 'confirmed' : this.#commitment,
          maxSupportedTransactionVersion: 0,
        },
      ],
    }));

    return this.#send<(RpcTransactionResponse | null)[]>(
      'getTransaction[batch]',
      requests,
      (body, attempt) => {
        if (!Array.isArray(body)) {
          // A gateway that rejects the batch outright answers with one error
          // object rather than an array. Surface its reason, not a shape error.
          const single = body as JsonRpcResponse<unknown>;
          if (single.error !== undefined) throw rpcError('getTransaction', single.error, attempt);
          throw new UpstreamError('RPC batch did not return an array', {
            context: { method: 'getTransaction', attempt, size: requests.length },
          });
        }

        // A batch response may come back in any order; the ids tie it together.
        const byId = new Map<number | string, JsonRpcResponse<RpcTransactionResponse | null>>();
        for (const message of body as JsonRpcResponse<RpcTransactionResponse | null>[]) {
          byId.set(message.id, message);
        }

        return requests.map((request) => {
          const message = byId.get(request.id);
          if (message === undefined) {
            throw new UpstreamError('RPC batch response is missing a request id', {
              context: { method: 'getTransaction', attempt, id: request.id },
            });
          }
          if (message.error !== undefined) throw rpcError('getTransaction', message.error, attempt);
          return message.result ?? null;
        });
      },
      signal,
      requests.length,
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

  /**
   * Any other JSON-RPC method, through the same limiter, timeout and retries.
   *
   * The typed methods above are the supported surface and should be preferred.
   * This exists for the provider extensions that only some endpoints serve —
   * Helius's DAS calls, for one — where the alternative is a second HTTP path
   * with its own fetch, its own backoff and its own share of the rate limit.
   * Two paths to one key is how a shared key gets exhausted.
   *
   * The caller owns the response shape; nothing here validates `T`.
   */
  async call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    return this.#call<T>(method, params, signal);
  }

  async #call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const id = this.#nextId++;
    return this.#send<T>(
      method,
      { jsonrpc: '2.0', id, method, params },
      (body, attempt) => {
        const message = body as JsonRpcResponse<T>;
        if (message.error !== undefined) throw rpcError(method, message.error, attempt);
        if (message.result === undefined) {
          throw new UpstreamError(`RPC ${method} returned neither result nor error`, {
            context: { method, attempt },
          });
        }
        return message.result;
      },
      signal,
    );
  }

  /**
   * One HTTP round trip, retried.
   *
   * `parse` runs inside the retry so a JSON-RPC level fault — a -32603, a
   * truncated body — gets another attempt on the same terms as a 429. Pulling it
   * out would quietly make every server-side error permanent.
   */
  async #send<T>(
    label: string,
    payload: unknown,
    parse: (body: unknown, attempt: number) => T,
    signal?: AbortSignal,
    cost = 1,
  ): Promise<T> {
    const method = label;
    return retry(
      async (attempt) => {
        // Picked per attempt, not per call: a retry that lands on a different
        // key is the whole point of having more than one.
        const endpoint = this.#pick();
        const wait = endpoint.cooldownUntil - Date.now();
        if (wait > 0) await sleep(wait, signal);

        // Charged per RPC call, not per request: a batch of twenty spends
        // twenty units, because that is what the provider counts.
        await endpoint.limiter.acquire(signal, cost);
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, this.#timeoutMs);
        const onAbort = (): void => {
          controller.abort();
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
          const response = await this.#fetch(endpoint.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          if (!response.ok) {
            /*
             * A 429 is the endpoint stating its real limit, which is worth more
             * than the one in the config. Retrying at the pace that was just
             * refused earns the same answer five times and then gives up, so
             * the limiter is slowed before the next attempt is scheduled — and
             * stays slowed for the calls behind this one, which are the ones
             * that would otherwise arrive at exactly the rejected rate. The
             * cooldown is what moves the next attempt to a different key.
             */
            if (response.status === 429) {
              endpoint.limiter.backOff();
              this.#cool(endpoint, COOLDOWN_BASE_MS);
              this.#logger.warn(
                {
                  method,
                  attempt,
                  endpoint: sanitiseUrl(endpoint.url),
                  rate: Number(endpoint.limiter.effectiveRate.toFixed(2)),
                  batchesInFlight: this.#concurrency(),
                  endpoints: this.#endpoints.length,
                },
                'rate limited; slowing this endpoint down, going serial, and preferring the others. If it keeps happening all the way down, it is not a per-second limit — check the plan for a credit or connection quota',
              );
            }
            // A refused credential is not a busy moment. Set the endpoint aside
            // properly rather than spending every retry rediscovering it.
            if (response.status === 401 || response.status === 403) {
              endpoint.consecutiveFailures += 1;
              endpoint.cooldownUntil = Date.now() + REJECTED_COOLDOWN_MS;
              this.#logger.error(
                { method, endpoint: sanitiseUrl(endpoint.url), status: response.status },
                'the endpoint refused this service’s credentials; setting it aside. Check the key and its quota',
              );
            }
            // 5xx is the other shape a provider hiccup takes. The body is where
            // it says which limit was hit and for how long; a bare status
            // number sends the operator guessing.
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

          const body: unknown = await response.json();
          const parsed = parse(body, attempt);
          // Clean call. Ease back towards the configured rate, slowly enough
          // that the client settles under the real limit instead of
          // oscillating across it, and let the endpoint out of any cooldown.
          endpoint.limiter.recover();
          endpoint.consecutiveFailures = 0;
          endpoint.cooldownUntil = 0;
          return parsed;
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
