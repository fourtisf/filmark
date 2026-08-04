import { ANCHOR_CPI_EVENT_TAG, DISCRIMINATOR_LENGTH } from '@exitliquidity/core';
import { BinaryReader, hasPrefix } from './binary.js';
import type { InstructionNode } from './types.js';

export interface AnchorEvent {
  /** The 8-byte event discriminator, `sha256("event:<Name>")[..8]`. */
  readonly discriminator: Uint8Array;
  /** Borsh-encoded event body, discriminator already stripped. */
  readonly payload: Uint8Array;
  /** The self-CPI instruction that carried the event. */
  readonly node: InstructionNode;
}

/**
 * Reads an Anchor `emit_cpi!` event off a node, if that is what it is.
 *
 * Anchor emits events as a self-CPI back into the same program, with data laid
 * out as `[anchor:event tag][event discriminator][borsh body]`. We read events
 * rather than instruction arguments because the arguments are only the user's
 * *request* — a buy states the SOL it is willing to spend, not what it spent.
 * The event carries what actually happened.
 */
export function readAnchorEvent(node: InstructionNode): AnchorEvent | null {
  if (!hasPrefix(node.data, ANCHOR_CPI_EVENT_TAG)) return null;
  if (node.data.length < ANCHOR_CPI_EVENT_TAG.length + DISCRIMINATOR_LENGTH) return null;

  const start = ANCHOR_CPI_EVENT_TAG.length;
  return {
    discriminator: node.data.subarray(start, start + DISCRIMINATOR_LENGTH),
    payload: node.data.subarray(start + DISCRIMINATOR_LENGTH),
    node,
  };
}

/**
 * Finds the event a given invocation emitted.
 *
 * Scoped to the node's direct children on purpose: when a router batches five
 * pump.fun buys into one transaction, every buy has its own event and matching
 * them by position in a flat list pairs the wrong ones together.
 */
export function findChildEvent(
  node: InstructionNode,
  discriminator: Uint8Array,
): AnchorEvent | null {
  for (const child of node.children) {
    if (child.programId !== node.programId) continue;
    const event = readAnchorEvent(child);
    if (event !== null && bytesEqual(event.discriminator, discriminator)) return event;
  }
  return null;
}

/** Reads the 8-byte instruction discriminator, or null if the data is too short. */
export function instructionDiscriminator(node: InstructionNode): Uint8Array | null {
  if (node.data.length < DISCRIMINATOR_LENGTH) return null;
  return node.data.subarray(0, DISCRIMINATOR_LENGTH);
}

/** A reader positioned just past an instruction's discriminator. */
export function instructionArgsReader(node: InstructionNode, label: string): BinaryReader {
  return new BinaryReader(node.data.subarray(DISCRIMINATOR_LENGTH), label);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Computes an Anchor discriminator.
 *
 * Exists so tests can assert the hardcoded constants against the definition
 * instead of against a copy of themselves.
 */
export async function anchorDiscriminator(preimage: string): Promise<Uint8Array> {
  const { createHash } = await import('node:crypto');
  return Uint8Array.from(createHash('sha256').update(preimage).digest().subarray(0, 8));
}
