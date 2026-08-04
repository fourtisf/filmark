import bs58 from 'bs58';
import { DecodeError } from '@exitliquidity/core';

/**
 * A bounds-checked little-endian reader for Borsh-encoded Anchor payloads.
 *
 * Anchor events gain fields over time — pump.fun's `TradeEvent` has grown
 * several times — so readers here are written to consume a known prefix and
 * leave the remainder alone. Reading past the end is an error; trailing bytes
 * are not.
 */
export class BinaryReader {
  #offset = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly label = 'payload',
  ) {}

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.data.length - this.#offset;
  }

  #take(bytes: number): Uint8Array {
    if (bytes < 0) throw new RangeError('cannot read a negative number of bytes');
    if (this.#offset + bytes > this.data.length) {
      throw new DecodeError(
        `${this.label}: need ${bytes} bytes at offset ${this.#offset}, only ${this.remaining} left`,
        { context: { label: this.label, offset: this.#offset, need: bytes, have: this.remaining } },
      );
    }
    const slice = this.data.subarray(this.#offset, this.#offset + bytes);
    this.#offset += bytes;
    return slice;
  }

  skip(bytes: number): this {
    this.#take(bytes);
    return this;
  }

  u8(): number {
    return this.#take(1)[0] as number;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) {
      throw new DecodeError(`${this.label}: invalid bool byte ${value}`, {
        context: { label: this.label, value },
      });
    }
    return value === 1;
  }

  u16(): number {
    const b = this.#take(2);
    return (b[0] as number) | ((b[1] as number) << 8);
  }

  u32(): number {
    const b = this.#take(4);
    return (
      ((b[0] as number) | ((b[1] as number) << 8) | ((b[2] as number) << 16)) +
      (b[3] as number) * 0x1000000
    );
  }

  u64(): bigint {
    const b = this.#take(8);
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(b[i] as number);
    return value;
  }

  i64(): bigint {
    const unsigned = this.u64();
    return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
  }

  /** 32 raw bytes, returned base58-encoded the way the rest of the system holds addresses. */
  pubkey(): string {
    return bs58.encode(this.#take(32));
  }

  bytes(length: number): Uint8Array {
    return Uint8Array.from(this.#take(length));
  }

  /** A Borsh `Vec<u8>`/`String` length prefix followed by that many bytes. */
  vecU8(): Uint8Array {
    return this.bytes(this.u32());
  }

  string(): string {
    return new TextDecoder().decode(this.vecU8());
  }
}

/**
 * The write side of `BinaryReader`.
 *
 * Used to build byte-exact event payloads in tests. Having encode and decode
 * in the same file makes a layout change impossible to apply to only one of
 * them without noticing.
 */
export class BinaryWriter {
  readonly #chunks: Uint8Array[] = [];

  u8(value: number): this {
    this.#chunks.push(Uint8Array.of(value & 0xff));
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u64(value: bigint): this {
    const out = new Uint8Array(8);
    let remaining = value;
    for (let i = 0; i < 8; i += 1) {
      out[i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.#chunks.push(out);
    return this;
  }

  i64(value: bigint): this {
    return this.u64(value < 0n ? value + (1n << 64n) : value);
  }

  pubkey(base58: string): this {
    const decoded = bs58.decode(base58);
    if (decoded.length !== 32) throw new RangeError(`not a 32-byte pubkey: ${base58}`);
    this.#chunks.push(decoded);
    return this;
  }

  bytes(data: Uint8Array): this {
    this.#chunks.push(data);
    return this;
  }

  /** `count` zero bytes, for fields a decoder skips over. */
  zeros(count: number): this {
    this.#chunks.push(new Uint8Array(count));
    return this;
  }

  toBytes(): Uint8Array {
    const total = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** True when `data` begins with `prefix`. */
export function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

export function toHex(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}
