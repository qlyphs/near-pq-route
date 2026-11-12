/**
 * One payment of a route request as a durable operation. Everything needed to finish it (the authenticated request,
 * the pinned recipient card, the route's deployment) is saved before the wallet is asked for anything, and every
 * step is saved as it completes. A retry, a reload, an expired request or an unavailable request service resumes the
 * same QTC transfer from the saved terms; a new transfer is sent only while nothing was handed to the wallet yet, or
 * after the wallet said for certain that nothing was sent.
 */
import type { Card, PaymentRequest } from './crypto.js';

export type Stage = 'new' | 'sending' | 'sent' | 'located' | 'signed' | 'claimed' | 'minted' | 'settled';
/** Where the minted QTC ended up, read from the mint transaction's receipts on NEAR. */
export type Delivery = 'intents' | 'direct';
export interface Terms {
  /** The request as authenticated when the payment began (signature checked against `recipient`). */
  request: PaymentRequest;
  recipient: Card;
  /** The deployment the route bytes and the claim name; a later code change cannot move a payment elsewhere. */
  route: { network: string; bridge: string; verifier: string; lockAccountId: string; quantusGenesis: string; sponsor: string };
  /** Who holds the receiving account's key. 'meteor': an account the person holds in Meteor, which this browser's
   * backup cannot restore. Absent: a fresh account derived from the backup (or someone else's, when paying). */
  destination?: 'derived' | 'meteor';
  /** For 'meteor': the finalized block at which the account had exactly one ML-DSA-65 full-access key. */
  checkedAt?: number;
}
export interface Payment {
  v: 2;
  requestId: string;
  payer: string;
  terms: Terms;
  stage: Stage;
  delivery?: Delivery;
  txHash?: string;
  blockHash?: string;
  index?: number;
  depositId?: string;
  challenge?: string;
  signature?: string;
  publicKey?: string;
  updatedAt: number;
}
/** A saved payment that cannot be read: it may hold a sent transfer, so nothing new may start for that key. */
export class Unreadable extends Error {}
export interface Store { get(key: string): Payment | null; set(key: string, p: Payment): void }
export interface Steps {
  /** Asks the wallet for the transfer; calls onSent(hash) the moment the wallet returns the hash. Throws
   * NotSent when the wallet says for certain that nothing was submitted. */
  send(p: Payment, onSent: (hash: string) => void): Promise<void>;
  locate(hash: string): Promise<{ blockHash: string; index: number } | null>;
  depositId(blockHash: string, index: number): string;
  /** The site session challenge for this payment's route, built from the saved terms only. */
  challenge(p: Payment): string;
  sign(challenge: string): Promise<{ signature: string; publicKey: string }>;
  /** Queues the claim, built from the saved terms only. */
  post(p: Payment): Promise<void>;
  /** Whether the bridge consumed the deposit (it will never mint it again). */
  consumed(depositId: string): Promise<boolean>;
  /** Where the mint put the QTC, from its receipts on NEAR, or 'pending' / 'unknown' while that is not established. */
  delivery(p: Payment): Promise<Delivery | 'pending' | 'unknown'>;
}
/** The wallet refused before submitting anything: the payment can start over safely. */
export class NotSent extends Error {}
/** A transfer may have been handed to the wallet, but no hash came back: only the person can say what happened. */
export class Unknown extends Error {}

export const PREFIX = 'qlyphs:pq-route:payment:';
export const paymentKey = (requestId: string, payer: string) => `${PREFIX}${requestId}:${payer}`;

/**
 * Starts a payment for authenticated terms, or returns the one already in progress for this request and payer. The
 * request's expiry is the caller's check (openRequest) for a NEW payment only: a started payment never expires.
 */
export function begin(store: Store, key: string, requestId: string, payer: string, terms: Terms): Payment {
  const existing = store.get(key);
  if (existing) {
    const a = existing.terms.request, b = terms.request;
    if (a.amount !== b.amount || a.account !== b.account || a.accountKey !== b.accountKey || a.receipt !== b.receipt) {
      throw new Error('This request already has a payment in progress for other terms');
    }
    return existing;
  }
  const p: Payment = { v: 2, requestId, payer, terms, stage: 'new', updatedAt: Date.now() };
  store.set(key, p);
  return p;
}

/** Runs the payment from wherever it stopped, from the saved terms only. Each completed step is saved first. */
export async function advance(store: Store, key: string, steps: Steps, onStage: (p: Payment) => void = () => {}): Promise<Payment> {
  let p = store.get(key);
  if (!p) throw new Error('No payment to resume');
  const save = (next: Partial<Payment>) => { p = { ...p!, ...next, updatedAt: Date.now() }; store.set(key, p); onStage(p); };
  const now = (): Stage => (p as Payment).stage; // read through the closure: save() changes it

  if (now() === 'new' || now() === 'sending') {
    if (now() === 'sending') throw new Unknown('A transfer may already have been sent for this request: check your wallet, then paste its hash, or confirm nothing left it to allow another transfer');
    save({ stage: 'sending' });
    try {
      await steps.send(p, (hash) => save({ stage: 'sent', txHash: hash }));
    } catch (e) {
      if (e instanceof NotSent && now() === 'sending') { save({ stage: 'new' }); throw e; }
      throw e;
    }
    if (now() !== 'sent') throw new Unknown('The wallet did not return the transfer hash');
  }
  if (now() === 'sent') {
    const at = await steps.locate(p.txHash!);
    if (!at) throw new Error('The transfer is not in a recent block yet: retry in a minute (it will not be sent again)');
    save({ stage: 'located', blockHash: at.blockHash, index: at.index, depositId: steps.depositId(at.blockHash, at.index) });
  }
  if (now() === 'located') {
    // A fresh challenge on every attempt: it expires in minutes, and nothing was signed with an earlier one.
    const challenge = steps.challenge(p);
    const proof = await steps.sign(challenge);
    save({ stage: 'signed', challenge, signature: proof.signature, publicKey: proof.publicKey });
  }
  if (now() === 'signed') {
    await steps.post(p);
    save({ stage: 'claimed' });
  }
  if (now() === 'claimed' && (await steps.consumed(p.depositId!))) save({ stage: 'minted' });
  if (now() === 'minted') {
    // Consumed is not delivered: only the mint's own receipts say where the QTC went.
    const d = await steps.delivery(p);
    if (d === 'intents' || d === 'direct') save({ stage: 'settled', delivery: d });
  }
  return p;
}

/** The person found the transfer in their wallet: record its hash and resume from there. */
export function recordHash(store: Store, key: string, hash: string): Payment {
  const p = store.get(key);
  if (!p || (p.stage !== 'sending' && p.stage !== 'new')) throw new Error('This payment already has its transfer');
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('A transaction hash is 0x and 64 hex characters');
  const next: Payment = { ...p, stage: 'sent', txHash: hash, updatedAt: Date.now() };
  store.set(key, next);
  return next;
}
/** The person checked their wallet and states no transfer left it: this allows another transfer. */
export function forgetUnsent(store: Store, key: string): void {
  const p = store.get(key);
  if (p?.stage === 'sending') store.set(key, { ...p, stage: 'new', updatedAt: Date.now() });
}

/** What the page offers for a saved payment: start (saved terms, nothing sent), resume, recover (maybe sent, no hash), or nothing. */
export function controlFor(p: Payment): 'start' | 'resume' | 'recover' | 'none' {
  if (p.stage === 'new') return 'start';
  if (p.stage === 'sending') return 'recover';
  if (p.stage === 'settled') return 'none';
  return 'resume';
}
/** A first transfer only for a request that is still valid now; a payment already sent never expires. */
export function assertStartable(p: Payment, now = Date.now()): void {
  if (p.stage !== 'new') return;
  const e = p.terms.request.expiresAt;
  if (typeof e !== 'number' || !Number.isFinite(e) || now > e) throw new Error('This request has expired: ask the recipient for a new one (nothing was sent)');
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const okStatus = (st: any) => !!st && typeof st === 'object' && (typeof st.SuccessValue === 'string' || typeof st.SuccessReceiptId === 'string');

/**
 * Where the mint of THIS payment put the QTC, from a NEAR RPC `tx` result at FINAL. The transaction must be a single
 * `mint` call on the saved bridge whose attestation names this payment's deposit, recipient, amount, network, Quantus
 * genesis, Intents mode and receipt (sha256 of the saved receipt). Delivery is then read from that mint's own child
 * receipts: the verifier's ft_on_transfer and the bridge's ft_resolve_transfer. 'intents': the verifier used all of it
 * and the resolver kept the whole amount; 'direct': the resolver kept nothing (the verifier refused or failed and the
 * tokens moved to the recipient's account). Anything else, or any mismatch: 'unknown'.
 */
export function classifyMint(tx: any, p: Payment, sha256: (b: Uint8Array) => Uint8Array): Delivery | 'unknown' {
  const t = p.terms, r = t.request;
  if (tx?.final_execution_status !== 'FINAL' || typeof tx?.status?.SuccessValue !== 'string') return 'unknown';
  const action = tx.transaction?.actions?.[0]?.FunctionCall;
  if (tx.transaction?.receiver_id !== t.route.bridge || tx.transaction.actions.length !== 1 || action?.method_name !== 'mint') return 'unknown';
  let m: Uint8Array;
  try { m = b64(action.args).subarray(0, 288); } catch { return 'unknown'; }
  if (m.length !== 288) return 'unknown';
  const text = (a: number, n: number) => new TextDecoder().decode(m.subarray(a, a + n));
  const id = (at: number) => text(at + 1, m[at]!);
  const le = (a: number) => { let x = 0n; for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(m[a + i]!); return x; };
  const receipt = Uint8Array.from((r.receipt.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  const bound = text(0, 8) === 'QLYPBRG1' && text(8, 8).replace(/\0+$/, '') === t.route.network && id(16) === t.route.bridge
    && hexOf(m.subarray(81, 113)) === t.route.quantusGenesis.replace(/^0x/, '').toLowerCase() && hexOf(m.subarray(113, 145)) === p.depositId
    && le(145) === BigInt(r.amount) && id(161) === r.account && hexOf(m.subarray(226, 258)) === hexOf(sha256(receipt)) && m[258] === 1;
  if (!bound) return 'unknown';
  // The mint's own receipt, then its children: the verifier call and the bridge's resolver.
  const outcomes: any[] = Array.isArray(tx.receipts_outcome) ? tx.receipts_outcome : [];
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const mint = byId.get(tx.transaction_outcome?.outcome?.receipt_ids?.[0]);
  if (!mint || mint.outcome?.executor_id !== t.route.bridge || !okStatus(mint.outcome.status)) return 'unknown';
  const kids = (mint.outcome.receipt_ids ?? []).map((k: string) => byId.get(k)).filter(Boolean);
  const onTransfer = kids.find((o: any) => o.outcome.executor_id === t.route.verifier);
  const resolve = kids.find((o: any) => o.outcome.executor_id === t.route.bridge);
  if (!onTransfer || !resolve || typeof resolve.outcome.status?.SuccessValue !== 'string') return 'unknown';
  const kept = atob(resolve.outcome.status.SuccessValue);
  const used = typeof onTransfer.outcome.status?.SuccessValue === 'string' ? atob(onTransfer.outcome.status.SuccessValue) : null;
  if (used === '"0"' && kept === `"${r.amount}"`) return 'intents';
  if (kept === '"0"') return 'direct';
  return 'unknown';
}
