'use client';
/** State of the post-quantum route for one browser: its backup and keys, the payments it runs from the Qlyphs
 * wallet, the QTC it holds on NEAR, the withdrawals on their way back, and the requests it made. The screens only
 * read these and call their actions. */
import * as React from 'react';
import { useQlyphs } from '@/lib/qlyphs';
import { findInclusion, redeemDirect, withdrawToQuantus } from '@/lib/pq-route/chain';
import { advance, assertStartable, begin, forgetUnsent, NotSent, paymentKey, PREFIX, recordHash, Unknown, Unreadable, type Payment, type Store } from '@/lib/pq-route/payment';
import { stepsFor } from '@/lib/pq-route/pay-steps';
import { askPayable, loadAsks, saveAsks, type Ask } from '@/lib/pq-route/requests';
import {
  ROUTE, allReceipts, depositId, depositMinted, directBalance, encodeRoute, intentsBalance, isRouteNetwork, loadSeed, mintPointer, nearTx, newSeed,
  postClaim, rc, receiverProblem, routeChallenge, saveSeed, seedHex, sponsorAccount,
} from '@/lib/pq-route/route';
import { loadWithdrawals, markArrivals, saveWithdrawals, type Withdrawal } from '@/lib/pq-route/withdrawals';
import { qtc } from './parts';

/** This browser's route wallet, from its 32-byte backup. */
export function useRouteWallet() {
  const [seed, setSeed] = React.useState<Uint8Array | null>(null);
  React.useEffect(() => setSeed(loadSeed() ?? newSeed()), []);
  const w = React.useMemo(() => (seed ? rc.wallet(seed) : null), [seed]);
  return { w, seed, restore: (hex: string) => { const s = rc.unhex(hex.trim().toLowerCase()); if (s.length !== 32) throw new Error('A backup is 64 hex characters'); saveSeed(s); setSeed(s); } };
}

/** Payments in progress, kept in this browser so a retry or a reload resumes the same transfer. A saved payment that
 * cannot be read is never treated as absent: it may hold a sent transfer. */
const browserStore: Store = {
  get: (k) => {
    const v = localStorage.getItem(k);
    if (v === null) return null;
    try { const p = JSON.parse(v) as Payment; if (p?.v !== 2 || !p.terms) throw new Error(); return p; }
    catch { throw new Unreadable('A saved payment for this request cannot be read: do not pay again before checking your wallet'); }
  },
  set: (k, p) => localStorage.setItem(k, JSON.stringify(p)),
};
export interface Saved { key: string; p: Payment | null }
function savedPayments(payer: string): Saved[] {
  const out: Saved[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (!k.startsWith(PREFIX) || !k.endsWith(`:${payer}`)) continue;
    try { out.push({ key: k, p: browserStore.get(k) }); } catch { out.push({ key: k, p: null }); }
  }
  return out;
}
const deployment = () => ({ network: ROUTE.network, bridge: ROUTE.bridge, verifier: ROUTE.verifier, lockAccountId: ROUTE.lockAccountId, quantusGenesis: ROUTE.quantusGenesis, sponsor: ROUTE.sponsor });

/** The payments of the connected wallet and what runs them. One payment is worked on by one tab at a time. */
export function usePayments(w: rc.RouteWallet | null) {
  const { account, wallet, connect, connecting, submit, signSessionChallenge } = useQlyphs();
  const [saved, setSaved] = React.useState<Saved[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const onRoute = isRouteNetwork(account?.genesis ?? wallet?.network?.genesis);
  const refresh = React.useCallback(() => { setSaved(account ? savedPayments(account.owner) : []); }, [account]);
  React.useEffect(() => { refresh(); }, [refresh]);
  const fail = (key: string, message: string) => setErrors((e) => ({ ...e, [key]: message }));
  const clear = (key: string) => setErrors((e) => { const rest = { ...e }; delete rest[key]; return rest; });

  const steps = stepsFor({
    async sendQtc(to, amount, onSent) {
      // Only the wallet's own "nothing was submitted" lets the payment start over; any other failure stays in doubt.
      let notSent = false;
      const ok = await submit({ kind: 'sendQtc', to, amount } as never, `Lock ${qtc(amount)} QTC for NEAR`, { onSent, onNotSent: () => { notSent = true; } });
      if (!ok && notSent) throw new NotSent('Nothing was sent: the wallet request was closed or refused.');
      return ok;
    },
    findInclusion, depositId,
    routeChallenge: (p, dep) => {
      const r = p.terms.request;
      return routeChallenge(p.payer, window.location.origin, encodeRoute(dep, r.account, true, r.receipt, r.accountKey, p.terms.route.bridge), p.terms.route);
    },
    signSessionChallenge, postClaim, depositMinted, mintPointer, nearTx,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  /** One payment's work under an exclusive per-payment browser lock, so two tabs never touch the same payment. */
  async function locked<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) throw new Error('This browser cannot keep one tab per payment: use a recent Chrome, Firefox or Safari');
    let out: { v: T } | null = null;
    await locks.request(key, { ifAvailable: true }, async (lock) => { if (lock) out = { v: await fn() }; });
    if (!out) throw new Error('This payment is being processed in another tab');
    return (out as { v: T }).v;
  }
  /** The saved payment must name the deployment this page serves; an old operation never mixes with new services. */
  function sameDeployment(p: Payment) {
    const a = p.terms.route;
    if (a.network !== ROUTE.network || a.bridge !== ROUTE.bridge || a.verifier !== ROUTE.verifier || a.lockAccountId !== ROUTE.lockAccountId || a.quantusGenesis !== ROUTE.quantusGenesis || a.sponsor !== ROUTE.sponsor) {
      throw new Error(`This payment was made for another deployment (${a.bridge}); this page serves ${ROUTE.bridge}`);
    }
  }
  /** Starts (saved 'new': checks expiry and the account first) or resumes one payment, from its saved terms only.
   * `create` runs first under the same lock, so creating a payment and advancing it are one locked step. Returns
   * the stage it stopped at, or null when it never existed. */
  async function run(key: string, create?: () => void): Promise<Payment['stage'] | null> {
    clear(key); setBusy(key);
    try {
      await locked(key, async () => {
        create?.();
        refresh();
        const p = browserStore.get(key);
        if (!p) throw new Error('No saved payment');
        sameDeployment(p);
        if (p.stage === 'new') {
          assertStartable(p);
          const why = await receiverProblem(p.terms.request.account, p.terms.request.accountKey);
          if (why) throw new Error(`Not paying: ${why}.`);
        }
        await advance(browserStore, key, steps, () => refresh());
      });
    } catch (e) {
      if (e instanceof NotSent) {
        // Refused or closed in the wallet before anything was sent: nothing to keep.
        try { if (browserStore.get(key)?.stage === 'new') localStorage.removeItem(key); } catch { /* unreadable: kept */ }
      } else if (!(e instanceof Unknown)) fail(key, (e as Error).message);
    } finally { setBusy(null); refresh(); }
    try { return browserStore.get(key)?.stage ?? null; } catch { return null; }
  }

  /** Bridge your own QTC: the same route, with yourself as the requester. A fresh account from this browser's
   * backup, a request sealed to your own card and opened against its pin, then the usual locked payment. `onKey`
   * is told the payment's key before the wallet is asked for anything. Throws when the account cannot be opened. */
  async function startSelf(planck: bigint, onKey: (key: string) => void): Promise<Payment['stage'] | null> {
    if (!account || !w) return null;
    const mine = rc.card(w);
    const { sealed, account: near, rid } = rc.createRequest(w, mine, { network: ROUTE.network, sponsor: ROUTE.sponsor, amountPlanck: planck, memo: 'Bridge', expiresAt: Date.now() + 3600e3 });
    const { signer } = rc.paymentKeys(w, ROUTE.network, rid);
    try {
      const made = await sponsorAccount(signer.publicKey);
      if (made.accountId !== near) throw new Error('Route service: it opened another account than this transfer names');
    } finally { signer.destroy(); }
    const request = rc.openRequestPinned(w, sealed, { pin: rc.cardPin(mine), network: ROUTE.network, sponsor: ROUTE.sponsor });
    const id = seedHex(rid).slice(0, 32), key = paymentKey(id, account.owner);
    onKey(key);
    return run(key, () => begin(browserStore, key, id, account.owner, { request, recipient: mine, route: deployment() }));
  }
  /** Bridge your own QTC to an account you already hold elsewhere (Meteor), named by its only key's handle. The
   * terms are the same as a self bridge's, built here instead of opened from a sealed request, and say
   * destination 'meteor': this backup cannot restore that account (restore keeps rejecting receipts whose account it
   * does not derive), so the account's own wallet is its recovery. The receipt is sealed like any other only so the
   * mint carries the same fixed-size receipt. */
  async function startTo(near: string, handle: string, checkedAt: number, planck: bigint, onKey: (key: string) => void): Promise<Payment['stage'] | null> {
    if (!account || !w) return null;
    const rid = crypto.getRandomValues(new Uint8Array(32));
    const receipt = rc.sealReceipt(rc.receiptKeyFor(w, ROUTE.network, rid), rid, { v: rc.VERSION, network: ROUTE.network, account: near, amount: String(planck), memo: 'Bridge' });
    const request: rc.PaymentRequest = { v: rc.VERSION, network: ROUTE.network, account: near, accountKey: handle, amount: String(planck), memo: 'Bridge',
      expiresAt: Date.now() + 3600e3, receipt: rc.hex(receipt), recipient: rc.card(w) };
    const id = seedHex(rid).slice(0, 32), key = paymentKey(id, account.owner);
    onKey(key);
    return run(key, () => begin(browserStore, key, id, account.owner, { request, recipient: rc.card(w), route: deployment(), destination: 'meteor', checkedAt }));
  }
  /** Pays someone's opened request. `recipient` is the card the request was checked against. */
  function startPay(id: string, request: rc.PaymentRequest, recipient: rc.Card, onKey: (key: string) => void): Promise<Payment['stage'] | null> {
    if (!account) return Promise.resolve(null);
    const key = paymentKey(id, account.owner);
    onKey(key);
    return run(key, () => begin(browserStore, key, id, account.owner, { request, recipient, route: deployment() }));
  }
  /** The person found the transfer in their wallet: continue with its hash. */
  async function continueWith(key: string, hash: string) {
    try { await locked(key, () => recordHash(browserStore, key, hash.trim())); refresh(); void run(key); }
    catch (e) { fail(key, (e as Error).message); }
  }
  /** The person states nothing left their wallet: the payment is removed. */
  async function forget(key: string) {
    try { await locked(key, () => { forgetUnsent(browserStore, key); if (browserStore.get(key)?.stage === 'new') localStorage.removeItem(key); }); clear(key); refresh(); }
    catch (e) { fail(key, (e as Error).message); }
  }
  const mine = (p: Payment) => !!w && rc.sameCard(p.terms.recipient, rc.card(w));
  return { account, connect, connecting, onRoute, saved, busy, errors, run, startSelf, startTo, startPay, continueWith, forget, mine, keyFor: (id: string) => (account ? paymentKey(id, account.owner) : null) };
}
export type Payments = ReturnType<typeof usePayments>;

export interface Holding { account: string; rid: Uint8Array; inside: bigint; direct: bigint }
/** The QTC this backup holds on NEAR: its accounts are found among everyone's public receipts, then their balances
 * are read from NEAR. */
export function useHoldings(w: rc.RouteWallet | null) {
  const [found, setFound] = React.useState<Holding[] | null>(null);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const scan = React.useCallback(async () => {
    if (!w) return;
    const mine = ++generation.current;
    try {
      const hits = rc.findPayments(w, ROUTE.network, await allReceipts(), ROUTE.sponsor);
      const list = await Promise.all(hits.map(async (f) => ({ account: f.body.account as string, rid: f.rid,
        inside: BigInt(await intentsBalance(f.body.account)), direct: BigInt(await directBalance(f.body.account)) })));
      if (generation.current === mine) { setFound(list); setError(''); }
    } catch (e) { if (generation.current === mine) setError(`NEAR balances could not be read: ${(e as Error).message}`); }
  }, [w]);
  React.useEffect(() => { setFound(null); void scan(); }, [scan]);
  const held = (found ?? []).filter((h) => h.inside + h.direct > 0n);
  return { ready: found !== null, held, total: held.reduce((t, h) => t + h.inside + h.direct, 0n), error, scan };
}
export type Holdings = ReturnType<typeof useHoldings>;

/** How long the page keeps reading a destination's balance for a release, and shows the withdrawal as under way. */
export const WATCH_MS = 60 * 60_000;
export interface Batch { id: number; outs: Withdrawal[]; amount: bigint; dest: string; arrived: boolean; at: number }
export const batchesOf = (outs: Withdrawal[]): Batch[] => {
  const by = new Map<number, Withdrawal[]>();
  for (const o of outs) { const id = o.batch ?? o.at; by.set(id, [...(by.get(id) ?? []), o]); }
  return [...by.entries()].map(([id, list]) => ({ id, outs: list, amount: list.reduce((t, o) => t + BigInt(o.amount), 0n), dest: list[0]!.dest, arrived: list.every((o) => !!o.arrivedAt), at: Math.min(...list.map((o) => o.at)) }));
};
/** A run of withdrawals started by one click: how many of them NEAR has finalized so far. */
export interface Leaving { batch: number; total: number; done: number; amount: bigint; dest: string; error?: string }

/** Withdrawals back to Quantus: signs them with each NEAR account's ML-DSA-65 key, remembers them, and reads the
 * destination's Quantus balance to say when the release arrived. */
export function useWithdrawals(w: rc.RouteWallet | null, onChange: () => void) {
  const { indexer } = useQlyphs();
  const [outs, setOuts] = React.useState<Withdrawal[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const [leaving, setLeaving] = React.useState<Leaving | null>(null);
  React.useEffect(() => setOuts(loadWithdrawals()), []);
  const awaited = outs.some((o) => !o.arrivedAt && o.baseline !== null && now - o.at < WATCH_MS);
  React.useEffect(() => {
    if (!awaited || !indexer) return;
    let stop = false;
    const read = async () => {
      const dests = new Set(loadWithdrawals().filter((o) => !o.arrivedAt && o.baseline !== null).map((o) => o.dest));
      const free = new Map<string, bigint>();
      for (const d of dests) { try { free.set(d, BigInt((await indexer.balance(d)).free)); } catch { /* read again next time */ } }
      if (stop) return;
      // Load, mark and save in one go: a withdrawal recorded while the balances were read is kept.
      let list = loadWithdrawals();
      for (const [d, f] of free) list = markArrivals(list, d, f, Date.now());
      saveWithdrawals(list); setOuts(list); setNow(Date.now());
    };
    void read(); const t = setInterval(read, 6000);
    return () => { stop = true; clearInterval(t); };
  }, [awaited, indexer]);

  /** Withdraws every holding given to `dest` (0x + 64 hex), one after the other. Each is final on NEAR before the
   * next starts; one that fails stops the run and leaves the others where they are. */
  async function withdrawAll(holdings: Holding[], dest: string, batch: number): Promise<void> {
    if (!w || !holdings.length) return;
    let state: Leaving = { batch, total: holdings.length, done: 0, amount: holdings.reduce((t, h) => t + h.inside + h.direct, 0n), dest };
    setLeaving(state);
    for (const h of holdings) {
      const { signer } = rc.paymentKeys(w, ROUTE.network, h.rid);
      try {
        const inside = h.inside > 0n, amount = String(inside ? h.inside : h.direct);
        const baseline = indexer ? await indexer.balance(dest).then((b) => String(BigInt(b.free)), () => null) : null;
        const tx = inside ? await withdrawToQuantus(signer, h.account, amount, dest.slice(2)) : await redeemDirect(signer, h.account, amount, dest.slice(2));
        const list = [...loadWithdrawals(), { account: h.account, tx, amount, dest, at: Date.now(), batch, baseline }];
        saveWithdrawals(list); setOuts(list); setNow(Date.now());
        state = { ...state, done: state.done + 1 }; setLeaving(state);
      } catch (e) {
        setLeaving({ ...state, error: (e as Error).message }); onChange();
        return;
      } finally { signer.destroy(); }
    }
    setLeaving(null); onChange();
  }
  /** One withdrawal signed elsewhere (Meteor) from `account`: remembered and watched like the others. */
  async function withdrawWith(account: string, amount: bigint, dest: string, batch: number, send: () => Promise<string>): Promise<void> {
    const state: Leaving = { batch, total: 1, done: 0, amount, dest };
    setLeaving(state);
    try {
      const baseline = indexer ? await indexer.balance(dest).then((b) => String(BigInt(b.free)), () => null) : null;
      const tx = await send();
      const list = [...loadWithdrawals(), { account, tx, amount: String(amount), dest, at: Date.now(), batch, baseline }];
      saveWithdrawals(list); setOuts(list); setNow(Date.now());
      setLeaving(null);
    } catch (e) { setLeaving({ ...state, error: (e as Error).message }); }
    finally { onChange(); }
  }
  return { outs, now, leaving, withdrawAll, withdrawWith, dismiss: () => setLeaving(null) };
}
export type Withdrawals = ReturnType<typeof useWithdrawals>;

/** The requests this browser made; each one is watched on NEAR until it is paid or expires. */
export function useAsks() {
  const [asks, setAsks] = React.useState<Ask[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => setAsks(loadAsks()), []);
  const waiting = asks.some((a) => askPayable(a, now));
  React.useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const read = async () => {
      const paid = new Set<string>();
      for (const a of loadAsks()) {
        if (!askPayable(a, Date.now())) continue;
        try { if (BigInt(await intentsBalance(a.account)) + BigInt(await directBalance(a.account)) >= BigInt(a.amount)) paid.add(a.id); } catch { /* read again next time */ }
      }
      if (stop) return;
      const list = loadAsks().map((a) => (paid.has(a.id) && !a.paidAt ? { ...a, paidAt: Date.now() } : a));
      saveAsks(list); setAsks(list); setNow(Date.now());
    };
    void read(); const t = setInterval(read, 8000);
    return () => { stop = true; clearInterval(t); };
  }, [waiting]);
  const add = (a: Ask) => { const list = [...loadAsks(), a]; saveAsks(list); setAsks(list); };
  /** Gives a request up in this browser. Nothing can recall the link already sent: it stays payable until it expires. */
  const cancel = (id: string) => { const list = loadAsks().map((a) => (a.id === id && !a.paidAt && !a.cancelledAt ? { ...a, cancelledAt: Date.now() } : a)); saveAsks(list); setAsks(list); };
  return { asks, now, add, cancel };
}
export type Asks = ReturnType<typeof useAsks>;
