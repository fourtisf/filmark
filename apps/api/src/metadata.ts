import { describeError, silentLogger, type Logger } from '@exitliquidity/core';
import type { SolanaRpcClient } from '@exitliquidity/solana';

/** Mints per `getAssetBatch` call. Kept well under the endpoint's ceiling. */
const MAX_BATCH = 100;

export interface TokenMetadata {
  readonly mint: string;
  readonly symbol: string | null;
  readonly name: string | null;
}

export interface MetadataResolverOptions {
  readonly rpc: SolanaRpcClient;
  readonly logger?: Logger;
  readonly cacheSize?: number;
}

interface DasAsset {
  id?: string;
  content?: { metadata?: { symbol?: string; name?: string } };
  token_info?: { symbol?: string };
}

/**
 * Token symbols, for display only.
 *
 * A flow diagram labelled with base58 mint addresses is technically honest and
 * practically unreadable, so the trace asks for symbols — but nothing depends
 * on getting them. The Digital Asset Standard endpoint this uses is a provider
 * extension that Helius serves and a bare validator does not; the first refusal
 * turns the resolver off for the life of the process rather than re-asking on
 * every trace.
 *
 * A symbol is metadata the token's own deployer wrote. It is not evidence of
 * anything, it is not unique, and two tokens may share one — which is exactly
 * why every surface that shows a symbol shows the mint beside it.
 */
export class TokenMetadataResolver {
  readonly #rpc: SolanaRpcClient;
  readonly #logger: Logger;
  readonly #cache = new Map<string, TokenMetadata>();
  readonly #cacheSize: number;
  #supported = true;

  constructor(options: MetadataResolverOptions) {
    this.#rpc = options.rpc;
    this.#logger = options.logger ?? silentLogger;
    this.#cacheSize = options.cacheSize ?? 5000;
  }

  get supported(): boolean {
    return this.#supported;
  }

  async resolve(
    mints: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, TokenMetadata>> {
    const out = new Map<string, TokenMetadata>();
    const wanted: string[] = [];

    for (const mint of new Set(mints)) {
      const cached = this.#cache.get(mint);
      if (cached !== undefined) out.set(mint, cached);
      else wanted.push(mint);
    }

    if (!this.#supported || wanted.length === 0) return out;

    for (let i = 0; i < wanted.length; i += MAX_BATCH) {
      const group = wanted.slice(i, i + MAX_BATCH);
      const assets = await this.#fetch(group, signal);
      if (assets === null) return out;

      for (const asset of assets) {
        const mint = asset?.id;
        if (asset === null || typeof mint !== 'string') continue;
        const entry: TokenMetadata = {
          mint,
          symbol: clean(asset.token_info?.symbol ?? asset.content?.metadata?.symbol),
          name: clean(asset.content?.metadata?.name),
        };
        this.#put(entry);
        out.set(mint, entry);
      }
    }

    return out;
  }

  async #fetch(ids: readonly string[], signal?: AbortSignal): Promise<(DasAsset | null)[] | null> {
    try {
      return await this.#rpc.call<(DasAsset | null)[]>('getAssetBatch', [{ ids }], signal);
    } catch (error) {
      this.#supported = false;
      this.#logger.info(
        { err: describeError(error) },
        'token metadata unavailable from this RPC endpoint; traces will show mint addresses',
      );
      return null;
    }
  }

  #put(entry: TokenMetadata): void {
    if (this.#cache.size >= this.#cacheSize) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(entry.mint, entry);
  }
}

function clean(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  // A symbol is whatever the deployer typed into their own token's metadata,
  // and it is rendered into an SVG label downstream. Control characters, markup
  // delimiters and 200-character "symbols" are all routine on pump.fun; the
  // first two are an injection waiting for a careless template, and the third
  // breaks the diagram. Consumers escape as well — this is the narrow end.
  const trimmed = value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[<>&"'`\\]/g, '')
    .trim();
  return trimmed === '' ? null : trimmed.slice(0, 24);
}
