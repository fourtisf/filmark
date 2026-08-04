/**
 * Slot to block-time, bounded.
 *
 * Yellowstone transaction updates carry no block time; only block-meta updates
 * do. At `confirmed` commitment the meta for a slot usually arrives after that
 * slot's transactions, so this fills in for slots that have already closed and
 * the venue event's own clock reading covers the rest.
 *
 * Bounded because the stream never stops: an unbounded map here is a slow leak
 * that only shows up days into a run.
 */
export class BlockTimeCache {
  readonly #times = new Map<bigint, number>();

  constructor(private readonly capacity = 4096) {
    if (capacity < 1) throw new RangeError('capacity must be >= 1');
  }

  get size(): number {
    return this.#times.size;
  }

  set(slot: bigint, blockTime: number): void {
    // Insertion-ordered, so the first key is always the oldest slot recorded.
    if (this.#times.size >= this.capacity && !this.#times.has(slot)) {
      const oldest = this.#times.keys().next();
      if (!oldest.done) this.#times.delete(oldest.value);
    }
    this.#times.set(slot, blockTime);
  }

  get(slot: bigint): number | null {
    return this.#times.get(slot) ?? null;
  }
}
