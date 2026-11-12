// The payment never sends a second transfer when a later step fails, finishes from saved terms after the request
// expired or the request service went away, and reports Intents only from the mint's receipts.
// Run: node --test payment.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, assertStartable, begin, classifyMint, controlFor, forgetUnsent, NotSent, recordHash, Unknown, type Payment, type Store, type Terms } from './payment.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { stepsFor, type PayIO } from './pay-steps.ts';

const memory = (): Store => { const m = new Map<string, Payment>(); return { get: (k) => m.get(k) ?? null, set: (k, p) => void m.set(k, structuredClone(p)) }; };
const B = 'qtc-pq.x.testnet', V = 'intents.x.testnet';
const terms = (expiresAt = Date.now() + 3600e3): Terms => ({
  request: { v: 1, network: 'testnet', account: 'rabc.sponsor.testnet', accountKey: 'ml-dsa-65:K', amount: '1250000000000', memo: '', expiresAt, receipt: 'aa', recipient: { v: 1, kem: 'k', id: 'i' } },
  recipient: { v: 1, kem: 'k', id: 'i' },
  route: { network: 'testnet', bridge: B, verifier: V, lockAccountId: '0xlock', quantusGenesis: '0x' + GEN, sponsor: 'sponsor.testnet' },
});
const b64 = (s: string) => btoa(s);
const bytesB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const GEN = '06'.repeat(32), DEP = 'dd'.repeat(32);
/** The 288-byte attestation of a mint (contract/bridge.c layout). */
function attestation(o: { dep?: string; receiver?: string; amount?: bigint; receipt?: string; mode?: number } = {}) {
  const m = new Uint8Array(288), te = new TextEncoder();
  m.set(te.encode('QLYPBRG1'), 0); m.set(te.encode('testnet'), 8);
  m[16] = B.length; m.set(te.encode(B), 17);
  m.set(Uint8Array.from((GEN.match(/../g) ?? []).map((h) => parseInt(h, 16))), 81);
  m.set(Uint8Array.from(((o.dep ?? DEP).match(/../g) ?? []).map((h) => parseInt(h, 16))), 113);
  let a = o.amount ?? 1250000000000n; for (let i = 0; i < 16; i++) { m[145 + i] = Number(a & 255n); a >>= 8n; }
  const rcv = o.receiver ?? 'rabc.sponsor.testnet'; m[161] = rcv.length; m.set(te.encode(rcv), 162);
  m.set(sha256(Uint8Array.from(((o.receipt ?? 'aa').match(/../g) ?? []).map((h) => parseInt(h, 16)))), 226);
  m[258] = o.mode ?? 1;
  return m;
}
/** A NEAR `tx` result for a mint: the mint receipt M, its children V (verifier) and R (bridge resolver). */
function mintTx(o: { verifier?: 'used' | 'unused' | 'failed'; kept: string; receiver?: string; method?: string; att?: Uint8Array }) {
  const vStatus = o.verifier === 'failed' ? { Failure: { ActionError: {} } } : { SuccessValue: b64(o.verifier === 'unused' ? `"${o.kept === '0' ? '1250000000000' : '0'}"` : '"0"') };
  return { final_execution_status: 'FINAL', status: { SuccessValue: b64(`"${o.kept}"`) },
    transaction: { hash: 'T', signer_id: 'relay', receiver_id: o.receiver ?? B, actions: [{ FunctionCall: { method_name: o.method ?? 'mint', args: bytesB64(o.att ?? attestation()) } }] },
    transaction_outcome: { outcome: { receipt_ids: ['M'] } },
    receipts_outcome: [
      { id: 'M', outcome: { executor_id: B, status: { SuccessReceiptId: 'R' }, receipt_ids: ['V', 'R'] } },
      { id: 'V', outcome: { executor_id: V, status: vStatus, receipt_ids: [] } },
      { id: 'R', outcome: { executor_id: B, status: { SuccessValue: b64(`"${o.kept}"`) }, receipt_ids: [] } },
    ] };
}

function io(o: { fail?: Partial<Record<'locate' | 'sign' | 'post' | 'noHash' | 'notSent', number>>; mint?: 'none' | 'intents' | 'direct' } = {}) {
  const calls = { send: 0, requestFetches: 0 };
  const left = { ...(o.fail ?? {}) };
  const x: PayIO = {
    async sendQtc(_to, _amount, onSent) {
      calls.send++;
      if (left.notSent && left.notSent-- > 0) throw new NotSent('rejected');
      if (left.noHash && left.noHash-- > 0) return false;
      onSent('0x' + 'aa'.repeat(32)); return true;
    },
    async findInclusion() { if (left.locate && left.locate-- > 0) return null; return { blockHash: '0x' + '11'.repeat(32), index: 1 }; },
    depositId: () => DEP,
    routeChallenge: () => 'chal',
    async signSessionChallenge() { if (left.sign && left.sign-- > 0) throw new Error('route rejected'); return { signature: 'sig', publicKey: 'pk' }; },
    async postClaim() { if (left.post && left.post-- > 0) throw new Error('route service down'); return {}; },
    async depositMinted() { return true; },
    async mintPointer() { return o.mint && o.mint !== 'none' ? { tx: 'T', signer: 'relay' } : null; },
    async nearTx() { return o.mint === 'direct' ? mintTx({ verifier: 'unused', kept: '0' }) : mintTx({ kept: '1250000000000' }); },
    async sleep() {},
  };
  return { x, calls };
}
const run = async (store: Store, x: PayIO) => { try { return await advance(store, 'k', stepsFor(x)); } catch (e) { return e as Error; } };

for (const step of ['locate', 'sign', 'post'] as const) {
  test(`a failed ${step} after the send resumes without sending again`, async () => {
    const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
    // locate polls up to 30 times inside one attempt: fail all of them so the attempt itself fails.
    const { x, calls } = io({ fail: { [step]: step === 'locate' ? 30 : 1 }, mint: 'intents' });
    assert.ok((await run(store, x)) instanceof Error);
    assert.equal(((await run(store, x)) as Payment).stage, 'settled');
    assert.equal(calls.send, 1);
  });
}

test('after the send, an expired request and a dead request service do not stop the payment', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms(Date.now() + 1000));
  const { x, calls } = io({ fail: { post: 1 }, mint: 'intents' });
  assert.ok((await run(store, x)) instanceof Error);
  // The request is now expired and the service that held it is gone: the steps never ask for it.
  const saved = store.get('k')!; saved.terms.request.expiresAt = Date.now() - 1; store.set('k', saved);
  const p = (await run(store, x)) as Payment;
  assert.equal(p.stage, 'settled');
  assert.equal(calls.send, 1);
  assert.equal(calls.requestFetches, 0);
});

test('a consumed deposit is not reported as delivered until its mint receipts say where', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  const pending = await run(store, io({ mint: 'none' }).x) as Payment;
  assert.equal(pending.stage, 'minted');
  assert.equal(pending.delivery, undefined);
  const direct = await run(store, io({ mint: 'direct' }).x) as Payment;
  assert.equal(direct.stage, 'settled');
  assert.equal(direct.delivery, 'direct');
});

test('only receipts showing credit inside Intents report Intents', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  assert.equal(((await run(store, io({ mint: 'intents' }).x)) as Payment).delivery, 'intents');
});

test('a send that returned no hash is never sent again blindly', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  const { x, calls } = io({ fail: { noHash: 1 }, mint: 'intents' });
  assert.ok((await run(store, x)) instanceof Error);
  assert.ok((await run(store, x)) instanceof Unknown);
  recordHash(store, 'k', '0x' + 'bb'.repeat(32));
  assert.equal(((await run(store, x)) as Payment).stage, 'settled');
  assert.equal(calls.send, 1);
});

test('a wallet that refused before submitting lets the payment start over', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  const { x, calls } = io({ fail: { notSent: 1 }, mint: 'intents' });
  assert.ok((await run(store, x)) instanceof NotSent);
  assert.equal(((await run(store, x)) as Payment).stage, 'settled');
  assert.equal(calls.send, 2);
});

test('a payment in progress cannot be resumed for other terms', () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  const t = terms(); t.request.amount = '1';
  assert.throws(() => begin(store, 'k', 'r1', '0xpayer', t), /other terms/);
});

test('a mint for another deposit, another recipient or an unrelated transaction never settles the payment', () => {
  const p = { v: 2, requestId: 'r1', payer: '0xp', terms: terms(), stage: 'minted', depositId: DEP, updatedAt: 0 } as Payment;
  assert.equal(classifyMint(mintTx({ kept: '1250000000000' }), p, sha256), 'intents');
  assert.equal(classifyMint(mintTx({ kept: '1250000000000', att: attestation({ dep: 'bb'.repeat(32) }) }), p, sha256), 'unknown');
  assert.equal(classifyMint(mintTx({ kept: '1250000000000', att: attestation({ receiver: 'bob.testnet' }) }), p, sha256), 'unknown');
  assert.equal(classifyMint(mintTx({ kept: '1250000000000', att: attestation({ amount: 1n }) }), p, sha256), 'unknown');
  assert.equal(classifyMint(mintTx({ kept: '1250000000000', receiver: 'other.testnet' }), p, sha256), 'unknown');
  assert.equal(classifyMint(mintTx({ kept: '1250000000000', method: 'ft_transfer' }), p, sha256), 'unknown');
});

test('a verifier that failed, with the whole amount refunded, is delivery to the account', () => {
  const p = { v: 2, requestId: 'r1', payer: '0xp', terms: terms(), stage: 'minted', depositId: DEP, updatedAt: 0 } as Payment;
  assert.equal(classifyMint(mintTx({ verifier: 'failed', kept: '0' }), p, sha256), 'direct');
  assert.equal(classifyMint(mintTx({ verifier: 'unused', kept: '0' }), p, sha256), 'direct');
});

test('page controls: a saved new payment can be started, also after a wallet refusal or a manual reset', async () => {
  const store = memory(); const p0 = begin(store, 'k', 'r1', '0xpayer', terms());
  assert.equal(controlFor(p0), 'start');
  // Wallet returns no hash: the payment is stuck in "sending", the page offers recovery, never a blind resend.
  const { x, calls } = io({ fail: { noHash: 1 }, mint: 'intents' });
  await run(store, x);
  assert.equal(controlFor(store.get('k')!), 'recover');
  forgetUnsent(store, 'k');
  assert.equal(controlFor(store.get('k')!), 'start');
  const settled = await run(store, x) as Payment;
  assert.equal(settled.stage, 'settled');
  assert.equal(controlFor(settled), 'none');
  assert.equal(calls.send, 2);
});

test('a first transfer needs an unexpired request; a payment already sent does not', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms(Date.now() - 1));
  assert.throws(() => assertStartable(store.get('k')!), /expired/);
  const sent = { ...store.get('k')!, stage: 'sent' as const }; 
  assert.doesNotThrow(() => assertStartable(sent));
});

test('the wallet gets the challenge as 0x hex, the claim and the saved payment keep the bare hex, and a retry signs a fresh challenge', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  const { x } = io({ fail: { sign: 1 }, mint: 'intents' });
  let built = 0; const asked: string[] = []; const claimed: string[] = [];
  x.routeChallenge = () => `0a0b${(++built).toString(16).padStart(2, '0')}`;
  const sign = x.signSessionChallenge; x.signSessionChallenge = async (c) => { asked.push(c); return sign(c); };
  x.postClaim = async (c: any) => { claimed.push(c.proof.challenge); return {}; };
  assert.ok((await run(store, x)) instanceof Error);
  const done = (await run(store, x)) as Payment;
  assert.deepEqual(asked, ['0x0a0b01', '0x0a0b02']);
  assert.deepEqual(claimed, ['0a0b02']);
  assert.equal(done.challenge, '0a0b02');
});

test('a mint pointer published a moment after the mint still settles the payment in the same attempt', async () => {
  const store = memory(); begin(store, 'k', 'r1', '0xpayer', terms());
  const { x } = io({ mint: 'intents' });
  let reads = 0; const ptr = x.mintPointer; x.mintPointer = async (d) => (++reads < 3 ? null : ptr(d));
  const done = (await run(store, x)) as Payment;
  assert.equal(done.stage, 'settled');
  assert.equal(done.delivery, 'intents');
  assert.equal(reads, 3);
});
