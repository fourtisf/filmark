import { quoteAsset, type Logger, silentLogger } from '@exitliquidity/core';
import type { MintRepository } from '@exitliquidity/clickhouse';
import type { SolanaRpcClient } from '@exitliquidity/solana';

export interface MintDecimalsResolverOptions {
  readonly repository?: MintRepository;
  readonly rpc?: SolanaRpcClient;
  readonly logger?: Logger;
  /** Entries held in memory before the oldest are evicted. */
  readonly cacheSize?: number;
}

/**
 * Resolves mint decimals, cheapest source first.
 *
 * Almost every transaction declares the decimals of the mints it touches, so
 * this is only reached for the minority that do not — typically a buy that
 * creates the trader's token account in the same transaction. The tiers exist
 * so a backfill does not spend its RPC budget re-asking for values it already
 * has: memory, then the ClickHouse cache, then RPC.
 *
 * A mint that cannot be resolved returns null. The pipeline drops the swap
 * rather than assuming 6 decimals, because a wrong exponent is a thousand-fold
 * error in every downstream dollar figure.
 */
export class MintDecimalsResolver {
  readonly #cache = new Map<string, number>();
  readonly #missing = new Set<string>();
  readonly #repository: MintRepository | undefined;
  readonly #rpc: SolanaRpcClient | undefined;
  readonly #logger: Logger;
  readonly #cacheSize: number;

  constructor(options: MintDecimalsResolverOptions = {}) {
    this.#repository = options.repository;
    this.#rpc = options.rpc;
    this.#logger = options.logger ?? silentLogger;
    this.#cacheSize = options.cacheSize ?? 50_000;
  }

  /** Seeds the cache from a transaction's own token balances. */
  remember(mint: string, decimals: number): void {
    this.#missing.delete(mint);
    this.#put(mint, decimals);
  }

  async resolve(mint: string, signal?: AbortSignal): Promise<number | null> {
    const known = quoteAsset(mint);
    if (known !== null) return known.decimals;

    const cached = this.#cache.get(mint);
    if (cached !== undefined) return cached;

    // A mint that RPC has already said it does not know about must not be
    // re-requested for every swap in a backfill.
    if (this.#missing.has(mint)) return null;

    const resolved = await this.#resolveMany([mint], signal);
    return resolved.get(mint) ?? null;
  }

  /** Resolves several mints in one round trip. */
  async resolveMany(mints: readonly string[], signal?: AbortSignal): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const unresolved: string[] = [];

    for (const mint of new Set(mints)) {
      const known = quoteAsset(mint)?.decimals ?? this.#cache.get(mint);
      if (known !== undefined) out.set(mint, known);
      else if (!this.#missing.has(mint)) unresolved.push(mint);
    }

    for (const [mint, decimals] of await this.#resolveMany(unresolved, signal)) {
      out.set(mint, decimals);
    }
    return out;
  }

  async #resolveMany(mints: readonly string[], signal?: AbortSignal): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    if (mints.length === 0) return found;

    let pending = [...mints];

    if (this.#repository !== undefined) {
      const stored = await this.#repository.getMany(pending);
      for (const [mint, decimals] of stored) {
        this.#put(mint, decimals);
        found.set(mint, decimals);
      }
      pending = pending.filter((mint) => !stored.has(mint));
    }

    if (pending.length > 0 && this.#rpc !== undefined) {
      const results = await this.#rpc.getMintDecimals(pending, signal);
      const learned: { mint: string; decimals: number }[] = [];

      results.forEach((decimals, index) => {
        const mint = pending[index] as string;
        if (decimals === null) {
          this.#missing.add(mint);
          this.#logger.debug({ mint }, 'mint decimals unavailable from RPC');
          return;
        }
        this.#put(mint, decimals);
        found.set(mint, decimals);
        learned.push({ mint, decimals });
      });

      if (learned.length > 0) await this.#repository?.upsertMany(learned);
    } else {
      for (const mint of pending) this.#missing.add(mint);
    }

    return found;
  }

  #put(mint: string, decimals: number): void {
    // Insertion-ordered Map, so deleting the first key evicts the oldest.
    if (this.#cache.size >= this.#cacheSize) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(mint, decimals);
  }
}
