// Idempotence and slot ownership: what the relayer submitted for each message, keyed by hashes of public bytes only.
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

/**
 * States of a message's current submission:
 * - pending: being checked, signed and broadcast right now;
 * - uncertain: signed and broadcast without a definitive answer; the hash and the signed bytes are kept.
 *   `stopped` once its price window passed: it is then never broadcast again;
 * - submitted: RPC accepted the transaction; no outcome read yet;
 * - rejected: this transaction (or its `execute`) was refused; that alone does not say the nonce is unspent;
 * - accepted, delivered, delivery_failed: `execute` accepted the message, so the nonce is spent for good.
 *   Only accepted moves on, to delivered or delivery_failed; those two are final.
 */
export const SPENT = new Set(['accepted', 'delivered', 'delivery_failed']);
const FROM_OUTCOME = { accepted: 'accepted', delivered: 'delivered', failed: 'delivery_failed' };
const DELIVERY = new Set(['delivered', 'delivery_failed']);

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

export class Ledger {
  constructor({ maxEntries = 100000 } = {}) {
    this.max = maxEntries;
    this.byMessage = new Map(); // message id -> { slot, nonce, expiry, state, tx, signed, pending, history }
    this.bySlot = new Map(); // slot id -> message id of the owner
    this.byTx = new Map(); // tx hash -> message id
    this.released = []; // history: entries that gave up their slot, newest last
  }

  lookup(msg) {
    return this.byMessage.get(msg) ?? null;
  }

  #archive(msg, entry, why) {
    this.released.push({ msg, slot: entry.slot, nonce: entry.nonce, expiry: entry.expiry, state: entry.state, tx: entry.tx, history: entry.history, why });
    if (this.released.length > this.max) this.released.shift();
  }

  /**
   * Claims `slot` for `msg`. `chain` is the vault's finalized { nonce, height }, read after this request's
   * signature verified, and the caller has checked that `nonce` is this message's nonce and its window is
   * open. Returns false if the slot stays taken:
   * - by another message, unless that one can no longer execute: its window closed at a final height
   *   (`height >= expiry`) and the finalized vault nonce still equals the slot's nonce, so it never was
   *   accepted. Its record then moves to the released history;
   * - by this same message, unless its last transaction was rejected (the chain read shows the nonce is
   *   still unspent, so the vault never accepted it): then it may be sent once more.
   */
  claim(slot, msg, { nonce, expiry, pending, chain }) {
    const ownerId = this.bySlot.get(slot);
    if (ownerId !== undefined && ownerId !== msg) {
      const old = this.byMessage.get(ownerId);
      if (old) {
        const stale = !old.pending && !SPENT.has(old.state) && chain.height >= old.expiry && chain.nonce === old.nonce;
        if (!stale) return false;
        this.#archive(ownerId, old, 'window closed, nonce unspent');
        this.byMessage.delete(ownerId);
      }
    }
    const prior = this.byMessage.get(msg);
    if (prior && (prior.pending || prior.state !== 'rejected' || chain.nonce !== prior.nonce)) return false;
    const history = prior ? [...prior.history, { tx: prior.tx, state: prior.state }] : [];
    remember(this.bySlot, slot, msg, this.max);
    remember(this.byMessage, msg, { slot, nonce, expiry, state: 'pending', pending, tx: null, signed: null, rebroadcastUntil: null, stopped: false, history }, this.max);
    return true;
  }

  /**
   * The transaction is signed and about to be broadcast: from now on its hash and bytes are kept, with
   * the last final height at which they may be broadcast again (submitter.mjs).
   */
  signed(msg, tx, signed, rebroadcastUntil = null) {
    const e = this.byMessage.get(msg);
    if (!e) return;
    Object.assign(e, { tx, signed, rebroadcastUntil, stopped: false, state: 'uncertain' });
    remember(this.byTx, tx, msg, this.max);
  }

  /** The broadcast is over: `submitted` (RPC accepted) or `uncertain` (no definitive answer). */
  settle(msg, state) {
    const e = this.byMessage.get(msg);
    if (!e) return;
    e.pending = null;
    if (e.state === 'uncertain' || e.state === 'submitted') e.state = state;
  }

  /** The price window of an uncertain transaction passed: it stays uncertain and is never sent again. */
  stop(msg) {
    const e = this.byMessage.get(msg);
    if (!e) return;
    e.pending = null;
    if (e.state === 'uncertain' || e.state === 'submitted') Object.assign(e, { state: 'uncertain', stopped: true });
  }

  /**
   * The submission certainly had no effect: nothing was signed, or the node refused the transaction while
   * validating it. Frees the slot (a first submission) or returns to the earlier rejection (a resend); a
   * refused hash stays in the released history.
   */
  release(slot, msg) {
    const e = this.byMessage.get(msg);
    if (!e) return;
    if (e.tx) this.#archive(msg, e, 'refused by the node before execution');
    const last = e.history.at(-1);
    if (last) {
      Object.assign(e, { state: 'rejected', tx: last.tx, signed: null, rebroadcastUntil: null, stopped: false, pending: null, history: e.history.slice(0, -1) });
      return;
    }
    if (this.bySlot.get(slot) === msg) this.bySlot.delete(slot);
    this.byMessage.delete(msg);
  }

  /**
   * Learns from an outcome read (outcome.mjs `classify`) of the current transaction of a message. A spent
   * nonce never goes back: accepted only moves on to a delivery state, and a delivery state is final.
   */
  observe(tx, result) {
    const msg = this.byTx.get(tx);
    const e = msg === undefined ? null : this.byMessage.get(msg);
    if (!e || e.tx !== tx || e.pending) return;
    const next = FROM_OUTCOME[result?.status];
    if (SPENT.has(e.state)) {
      if (e.state === 'accepted' && DELIVERY.has(next)) e.state = next;
      return;
    }
    if (next) e.state = next;
    else if (result?.status === 'unknown' && result.attemptRejected === true) e.state = 'rejected';
  }

  knows(tx) {
    return this.byTx.has(tx);
  }
}
