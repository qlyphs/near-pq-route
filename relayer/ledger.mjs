// Idempotence: what the relayer already submitted, keyed by hashes of public bytes only.
import { createHash } from 'node:crypto';

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

/** SHA-256 of the canonical 256-byte message: two signatures of one message are one payment. */
export const messageId = (message) => sha256(message);
/** One slot per (vault, nonce): the vault accepts only one message per nonce, so only one may be in flight. */
export const slotId = (message) => sha256(message.subarray(16, 81), message.subarray(228, 236));

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

export class Ledger {
  constructor({ maxEntries = 100000 } = {}) {
    this.max = maxEntries;
    this.byMessage = new Map(); // message id -> { tx } once submitted, { pending } while submitting
    this.bySlot = new Map(); // slot id -> message id
    this.txs = new Set();
  }

  /** The submitted transaction or the in-flight submission for this message, if any. */
  lookup(msg) {
    return this.byMessage.get(msg) ?? null;
  }

  /** Claims the slot for `msg`. False if another message holds it (in flight or already submitted). */
  claim(slot, msg, pending) {
    const owner = this.bySlot.get(slot);
    if (owner !== undefined && owner !== msg) return false;
    remember(this.bySlot, slot, msg, this.max);
    remember(this.byMessage, msg, { pending }, this.max);
    return true;
  }

  /** Records the hash once RPC accepted (or may have accepted) the transaction. */
  submitted(slot, msg, tx) {
    remember(this.byMessage, msg, { tx }, this.max);
    remember(this.bySlot, slot, msg, this.max);
    this.txs.add(tx);
    if (this.txs.size > this.max) this.txs.delete(this.txs.values().next().value);
  }

  /** Frees the slot after a submission that certainly did not reach the network. */
  release(slot, msg) {
    if (this.bySlot.get(slot) === msg) this.bySlot.delete(slot);
    if (this.byMessage.get(msg)?.pending) this.byMessage.delete(msg);
  }

  knows(tx) {
    return this.txs.has(tx);
  }
}
