// Unit tests of the relayer: refusals before any gas, idempotence, slot reconciliation, quotas, spend bound, outcomes, HTTP limits.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { CONTEXT, Key, SIG_LEN, encodeMessage, vaultAddress } from '../sdk/vault.mjs';
import { nobleKeyFromPem } from '../tests/ml-dsa-seed.mjs';
import { KeyPair } from 'near-api-js';
import { loadConfig } from './config.mjs';
import { checkRelayerAccount, spendableBalance } from './account.mjs';
import { costBound, priceSafeBlocks, readProtocolCosts } from './cost.mjs';
import { Ledger, messageId, slotId } from './ledger.mjs';
import { Limiter, Quota, SpendCap } from './limits.mjs';
import { acquireLock } from './lock.mjs';
import { REQUEST_LEN, parseRequest } from './message.mjs';
import { classify, createOutcomeReader, outcome } from './outcome.mjs';
import { attachedGas, createRelay } from './relay.mjs';
import { RpcError, TransportError } from './rpc.mjs';
import { createRelayerServer, startFromEnv } from './server.mjs';
import { verifyAuthorization } from './signature.mjs';
import { INCLUSION_MARGIN_BLOCKS, PriceTooHigh, StaleReference, createSubmitter } from './submitter.mjs';

const deployment = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
const TGAS = 10n ** 12n;
const PRICE = 10n ** 9n;
const STEP = { num: 1n, den: 100n }; // testnet gas_price_adjustment_rate
// Fees of testnet protocol 88 (EXPERIMENTAL_protocol_config, 2026-10-27).
const protocolConfig = {
  chain_id: 'testnet', protocol_version: 88, max_gas_price: '10000000000000000000000', gas_price_adjustment_rate: [1, 100],
  runtime_config: {
    min_gas_purchase_price: '1000000000',
    storage_amount_per_byte: '10000000000000000000',
    transaction_costs: {
      pessimistic_gas_price_inflation_ratio: [1, 1],
      action_receipt_creation_config: { execution: 108059500000, send_not_sir: 108059500000, send_sir: 108059500000 },
      action_creation_config: {
        function_call_cost: { execution: 780000000000, send_not_sir: 200000000000, send_sir: 200000000000 },
        function_call_cost_per_byte: { execution: 2235934, send_not_sir: 47683715, send_sir: 2235934 },
      },
    },
  },
};
const scratch = mkdtempSync(join(tmpdir(), 'qvault-relayer-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const owner = ml_dsa87.keygen(randomBytes(32));
const vault = vaultAddress(owner.publicKey, deployment.factory);
const sign = (m, key = owner) => Buffer.from(ml_dsa87.sign(m, key.secretKey, { context: CONTEXT }));
const msg = (over = {}) => encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: 'alice.testnet', amount: 10n ** 22n, nonce: 3n, issued: 1000n, expiry: 1600n, ...over });
const body = (m, sig = sign(m)) => Buffer.concat([sig, m]);

const VALIDATION = () => new RpcError({ name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} } });
const fakeHash = (n, fill = '1') => `Tx${String(n).padStart(41, fill)}`;

/** Fills the dependencies of createRelay that a test does not care about: a fake chain and fake RPC. */
function relayDeps(over = {}) {
  return {
    deployment,
    readVault: async () => ({ publicKey: owner.publicKey, nonce: 3n, height: 1200n }),
    gasPrice: async () => 10n ** 8n,
    submit: async (req, onSigned) => { onSigned?.({ transaction: fakeHash(1), signed: 'c2lnbmVk' }); return fakeHash(1); },
    rebroadcast: async () => assert.fail('rebroadcast'),
    limiter: new Limiter({ concurrency: 2, queue: 4 }),
    vaultQuota: new Quota({ limit: 99, windowMs: 3600e3 }),
    ipQuota: new Quota({ limit: 99, windowMs: 3600e3 }),
    cap: new SpendCap(10n ** 24n),
    costOf: (req) => attachedGas(req) * PRICE,
    maxGasPriceYocto: PRICE,
    ...over,
  };
}

/**
 * A relay over a fake chain: the vault sits at nonce 3, final height 1200. Records every submission;
 * `submit(req, n, onSigned)` may replace the default, which signs as hash n and succeeds.
 */
function harness({ cap = 10n ** 24n, vaultPerHour = 100, ipPerHour = 100, nonce = 3n, height = 1200n, submit, rebroadcast, price = 10n ** 8n } = {}) {
  const sent = [];
  const resent = [];
  const reads = [];
  const state = { nonce, height, price };
  const r = createRelay(relayDeps({
    readVault: async (v) => { reads.push(v); return { publicKey: owner.publicKey, nonce: state.nonce, height: state.height }; },
    gasPrice: async () => state.price,
    submit: async (req, onSigned) => {
      sent.push(req);
      const n = sent.length;
      if (submit) return submit(req, n, onSigned);
      onSigned({ transaction: fakeHash(n), signed: Buffer.from(`signed ${n}`).toString('base64') });
      return fakeHash(n);
    },
    rebroadcast: async (signed) => { resent.push(signed); if (rebroadcast) return rebroadcast(signed); return {}; },
    vaultQuota: new Quota({ limit: vaultPerHour, windowMs: 3600e3 }),
    ipQuota: new Quota({ limit: ipPerHour, windowMs: 3600e3 }),
    cap: new SpendCap(cap),
  }));
  return { ...r, sent, resent, reads, state };
}

const mutate = (m, at, value) => { const c = Buffer.from(m); c[at] = value; return c; };

describe('parsing refusals (400, no chain read)', () => {
  const cases = [
    ['short body', Buffer.alloc(REQUEST_LEN - 1)],
    ['long body', Buffer.alloc(REQUEST_LEN + 1)],
    ['empty body', Buffer.alloc(0)],
    ['bad magic', body(mutate(msg(), 0, 0x41))],
    ['wrong network', body(encodeMessage({ chain: 'mainnet', vault, kind: 'near', receiver: 'alice.testnet', amount: 1n, nonce: 3n, issued: 1000n, expiry: 1600n }))],
    ['vault of another factory', body(msg({ vault: `${vault.slice(0, 16)}.other.testnet` }))],
    ['vault is a grandchild', body(msg({ vault: `ab.cd.${deployment.factory}` }))],
    ['vault label not 16 hex', body(msg({ vault: `x${vault.slice(1)}` }))],
    ['vault is the factory', body(msg({ vault: deployment.factory }))],
    ['unknown action', body(mutate(msg(), 81, 2))],
    ['token set on a NEAR transfer', body(mutate(msg(), 100, 1))],
    ['NEAR transfer naming a valid token (R2-M3)', body((() => { const m = msg(); m[82] = 12; m.write('wrap.testnet', 83, 'ascii'); return m; })())],
    ['NEAR transfer with a token length only (R2-M3)', body(mutate(msg(), 82, 12))],
    ['gas byte on a NEAR transfer', body(mutate(msg(), 252, 30))],
    ['ft gas below 10', body(mutate(msg({ kind: 'ft', token: 'wrap.testnet' }), 252, 9))],
    ['ft gas above 100', body(mutate(msg({ kind: 'ft', token: 'wrap.testnet' }), 252, 101))],
    ['reserved byte set', body(mutate(msg(), 255, 1))],
    ['receiver padding not zero', body(mutate(msg(), 148 + 63, 1))],
    ['receiver is the vault', body(msg({ receiver: vault }))],
    ['uppercase receiver', body(mutate(msg(), 148, 0x41))],
    ['zero amount', (() => { const m = msg(); m.fill(0, 212, 228); return body(m); })()],
    ['window over 1800 blocks', body(msg({ issued: 1000n, expiry: 2801n }))],
    ['empty window', body(msg({ issued: 1000n, expiry: 1000n }))],
  ];
  for (const [name, b] of cases) {
    test(name, async () => {
      const h = harness();
      const r = await h.relay(b, '1.1.1.1');
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(h.reads.length, 0);
      assert.equal(h.sent.length, 0);
    });
  }

  test('shared differential vectors (relayer/vectors/messages.json): same verdict as the wallet parser', () => {
    const { factory, vectors } = JSON.parse(readFileSync(new URL('./vectors/messages.json', import.meta.url), 'utf8'));
    assert.equal(factory, deployment.factory);
    assert.ok(vectors.length >= 30);
    for (const v of vectors) {
      const b = Buffer.concat([Buffer.alloc(SIG_LEN), Buffer.from(v.message, 'hex')]);
      if (v.accept) assert.doesNotThrow(() => parseRequest(b, deployment), v.name);
      else assert.throws(() => parseRequest(b, deployment), /./, v.name);
    }
    const nearWithToken = vectors.find((v) => v.name === 'NEAR transfer naming a token');
    assert.throws(() => parseRequest(Buffer.concat([Buffer.alloc(SIG_LEN), Buffer.from(nearWithToken.message, 'hex')]), deployment), /NEAR transfers carry no token fields/);
  });

  test('accepts a well-formed NEAR and ft message', () => {
    assert.equal(parseRequest(body(msg()), deployment).action, 0);
    const ft = parseRequest(body(msg({ kind: 'ft', token: 'wrap.testnet', ftGasTgas: 30 })), deployment);
    assert.equal(ft.token, 'wrap.testnet');
    assert.equal(attachedGas(ft), 60n * TGAS);
    assert.equal(attachedGas(parseRequest(body(msg()), deployment)), 30n * TGAS);
  });
});

describe('chain checks before submission', () => {
  test('invalid signature: refused, nothing submitted', async () => {
    const h = harness();
    const m = msg();
    const stranger = ml_dsa87.keygen(randomBytes(32));
    for (const b of [body(m, sign(m, stranger)), body(m, Buffer.alloc(SIG_LEN)), body(mutate(m, 227, 1), sign(m))]) {
      const r = await h.relay(b, '1.1.1.1');
      assert.equal(r.status, 422);
      assert.equal(r.body.error, 'invalid signature');
    }
    assert.equal(h.sent.length, 0);
  });

  test('signature under another context: refused', async () => {
    const h = harness();
    const m = msg();
    const r = await h.relay(body(m, Buffer.from(ml_dsa87.sign(m, owner.secretKey, { context: Buffer.from('qlyphs/near-vault/v2') }))), '1.1.1.1');
    assert.equal(r.status, 422);
    assert.equal(h.sent.length, 0);
  });

  test('stale nonce, future nonce, expired and not yet valid: refused', async () => {
    for (const [over, opts] of [[{ nonce: 2n }, {}], [{ nonce: 4n }, {}], [{}, { height: 1600n }], [{}, { height: 999n }]]) {
      const h = harness(opts);
      const r = await h.relay(body(msg(over)), '1.1.1.1');
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(h.sent.length, 0);
    }
  });

  test('a vault check failure or an unreachable RPC submits nothing', async () => {
    const { Refusal } = await import('./message.mjs');
    for (const [err, status] of [[new Refusal(422, 'vault check failed: x'), 422], [new TransportError('timeout'), 502]]) {
      const h = createRelay(relayDeps({ readVault: async () => { throw err; }, submit: async () => assert.fail('submitted') }));
      assert.equal((await h.relay(body(msg()), 'ip')).status, status);
    }
  });

  test('submits execute with 30 Tgas (NEAR) and 30 + signed gas (ft), no other choice', async () => {
    const h = harness();
    const ok = await h.relay(body(msg()), '1.1.1.1');
    assert.equal(ok.status, 200);
    assert.match(ok.body.transaction, /^Tx/);
    const ft = await h.relay(body(msg({ kind: 'ft', token: 'wrap.testnet', ftGasTgas: 45, nonce: 3n, amount: 7n })), '1.1.1.1');
    assert.equal(ft.status, 409); // same vault nonce as the first payment
    const h2 = harness();
    assert.equal((await h2.relay(body(msg({ kind: 'ft', token: 'wrap.testnet', ftGasTgas: 45 })), 'ip')).status, 200);
    assert.equal(h.sent[0].gas, 30n * TGAS);
    assert.equal(h2.sent[0].gas, 75n * TGAS);
    assert.equal(h.sent[0].vault, vault);
    assert.equal(Buffer.from(h.sent[0].args).length, REQUEST_LEN);
  });
});

describe('idempotence', () => {
  test('a repeat returns the same hash without resubmitting', async () => {
    const h = harness();
    const m = msg();
    const b = body(m);
    const first = await h.relay(b, '1.1.1.1');
    const again = await h.relay(b, '2.2.2.2');
    assert.deepEqual(again, first);
    assert.equal(h.sent.length, 1);
    assert.equal(h.reads.length, 1, 'a known message is answered without chain reads');
  });

  test('another signature of the same message is the same payment', async () => {
    const h = harness();
    const m = msg();
    const a = await h.relay(body(m), 'ip');
    const b = await h.relay(body(m), 'ip'); // ML-DSA signing is hedged: a new signature each time
    assert.equal(b.body.transaction, a.body.transaction);
    assert.equal(h.sent.length, 1);
  });

  test('concurrent identical requests: one submission', async () => {
    let release;
    const gate = new Promise((ok) => { release = ok; });
    let calls = 0;
    const h = harness({ submit: async (req, n, onSigned) => { calls++; onSigned({ transaction: fakeHash(1), signed: 'eA==' }); await gate; return fakeHash(1); } });
    const b = body(msg());
    const all = Promise.all([h.relay(b, 'a'), h.relay(b, 'b'), h.relay(b, 'c')]);
    await new Promise((ok) => setTimeout(ok, 50));
    release();
    const rs = await all;
    assert.equal(calls, 1);
    assert.ok(rs.every((r) => r.status === 200 && r.body.transaction === rs[0].body.transaction));
  });

  test('one message per (vault, nonce): a different message for a used nonce is refused', async () => {
    const h = harness();
    assert.equal((await h.relay(body(msg()), 'ip')).status, 200);
    const other = await h.relay(body(msg({ amount: 5n })), 'ip');
    assert.equal(other.status, 409);
    assert.equal(h.sent.length, 1);
  });

  test('an invalid signature cannot hold a slot', async () => {
    const h = harness();
    const m = msg();
    assert.equal((await h.relay(body(m, Buffer.alloc(SIG_LEN, 1)), 'ip')).status, 422);
    assert.equal((await h.relay(body(m), 'ip')).status, 200);
  });

  test('a validation refusal frees the slot; a lost answer keeps the hash', async () => {
    let mode = 'refuse';
    const h = harness({ submit: async (req, n, onSigned) => {
      onSigned({ transaction: fakeHash(n, '2'), signed: Buffer.from(`s${n}`).toString('base64') });
      if (mode === 'refuse') throw VALIDATION();
      throw new TransportError('timeout');
    } });
    const b = body(msg());
    assert.equal((await h.relay(b, 'ip')).status, 502);
    mode = 'lost';
    const lost = await h.relay(b, 'ip');
    assert.equal(lost.status, 504);
    assert.equal(lost.body.transaction, fakeHash(2, '2'));
    const again = await h.relay(b, 'ip');
    assert.equal(again.status, 200);
    assert.equal(again.body.transaction, lost.body.transaction);
    assert.equal(h.sent.length, 2, 'the retry re-broadcast, it did not build a third transaction');
    assert.deepEqual(h.resent, [Buffer.from('s2').toString('base64')]);
  });
});

describe('R2-M5: the hash is fixed before broadcast and never dropped', () => {
  test('a timeout carrying a known hash keeps hash and slot; the retry re-broadcasts the same signed bytes', async () => {
    let resendMode = 'timeout';
    const h = harness({
      submit: async (req, n, onSigned) => {
        onSigned({ transaction: fakeHash(n, '5'), signed: Buffer.from(`signed ${n}`).toString('base64') });
        const e = new TransportError('send_tx: timeout');
        e.transaction = fakeHash(n, '5'); // what the real submitter attaches
        throw e;
      },
      rebroadcast: async () => { if (resendMode === 'timeout') throw new TransportError('send_tx: timeout'); return {}; },
    });
    const b = body(msg());
    const first = await h.relay(b, 'ip');
    assert.equal(first.status, 504);
    assert.equal(first.body.transaction, fakeHash(1, '5'));
    assert.equal(h.ledger.lookup(messageId(msg())).state, 'uncertain');
    // Another message for the same nonce cannot take the slot while the window is open.
    assert.equal((await h.relay(body(msg({ amount: 5n })), 'ip')).status, 409);
    const second = await h.relay(b, 'ip');
    assert.equal(second.status, 504);
    assert.equal(second.body.transaction, fakeHash(1, '5'));
    resendMode = 'ok';
    const third = await h.relay(b, 'ip');
    assert.equal(third.status, 200);
    assert.equal(third.body.transaction, fakeHash(1, '5'));
    assert.equal(h.sent.length, 1, 'one transaction was ever built');
    assert.deepEqual(h.resent, [Buffer.from('signed 1').toString('base64'), Buffer.from('signed 1').toString('base64')]);
  });

  test('an RPC error that is not a validation refusal keeps the hash (it used to be dropped)', async () => {
    const h = harness({ submit: async (req, n, onSigned) => {
      onSigned({ transaction: fakeHash(n, '6'), signed: 'eA==' });
      const e = new RpcError({ name: 'HANDLER_ERROR', cause: { name: 'INTERNAL_ERROR' } });
      e.transaction = fakeHash(n, '6');
      throw e;
    } });
    const r = await h.relay(body(msg()), 'ip');
    assert.equal(r.status, 504);
    assert.equal(r.body.transaction, fakeHash(1, '6'));
    assert.ok(h.ledger.knows(fakeHash(1, '6')));
    assert.equal((await h.relay(body(msg({ amount: 5n })), 'ip')).status, 409, 'the slot is kept');
  });

  test('a failure before anything is signed frees the slot', async () => {
    const h = harness({ submit: async (req, n) => { if (n === 1) throw new TransportError('block: timeout'); return fakeHash(n); } });
    assert.equal((await h.relay(body(msg()), 'ip')).status, 502);
    assert.equal(h.ledger.lookup(messageId(msg())), null);
  });

  test('the real submitter: onSigned gets the hash before send_tx; errors carry it; rebroadcast sends identical bytes', async () => {
    const calls = [];
    let signedSeen = null;
    const rpc = { call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'query') return { nonce: 41 };
      if (method === 'block') return { header: { hash: '11111111111111111111111111111111', height: 500, gas_price: '100000000' } };
      if (method === 'send_tx') {
        assert.ok(signedSeen, 'hash recorded before the broadcast');
        throw new TransportError('send_tx: timeout');
      }
      throw new Error(method);
    } };
    const { submit, rebroadcast } = createSubmitter({ rpc, accountId: 'relayer.testnet', keyPair: KeyPair.fromRandom('ed25519'), maxGasPriceYocto: PRICE, priceStep: STEP });
    const err = await submit({ vault, args: new Uint8Array(REQUEST_LEN), gas: 30n * TGAS }, (s) => { signedSeen = s; }).catch((e) => e);
    assert.ok(err instanceof TransportError);
    assert.equal(err.transaction, signedSeen.transaction);
    assert.match(err.transaction, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.equal(err.signed, signedSeen.signed);
    const sends = () => calls.filter((c) => c.method === 'send_tx').map((c) => c.params.signed_tx_base64);
    await rebroadcast(err.signed, signedSeen.rebroadcastUntil).catch(() => {});
    assert.deepEqual(sends(), [err.signed, err.signed]);
  });
});

describe('R2-M2: slot reconciliation', () => {
  test('a rejected attempt keeps the slot while the old window is open, then releases it once closed with the nonce unchanged', async () => {
    const h = harness();
    const a = msg({ expiry: 1300n });
    const first = await h.relay(body(a), 'ip');
    assert.equal(first.status, 200);
    h.ledger.observe(first.body.transaction, { status: 'unknown', attemptRejected: true });
    assert.equal(h.ledger.lookup(messageId(a)).state, 'rejected');
    const b = msg({ amount: 5n, issued: 1200n, expiry: 2000n });
    assert.equal((await h.relay(body(b), 'ip')).status, 409, 'old window still open at height 1200');
    h.state.height = 1300n; // final height reached the old expiry, vault nonce still 3
    const taken = await h.relay(body(b), 'ip');
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(h.sent.length, 2);
    const hist = h.ledger.released.at(-1);
    assert.equal(hist.msg, messageId(a));
    assert.equal(hist.tx, first.body.transaction);
    assert.equal(hist.state, 'rejected');
  });

  test('an uncertain submission is released the same way once its window closed and the nonce is unchanged', async () => {
    const h = harness({ submit: async (req, n, onSigned) => {
      onSigned({ transaction: fakeHash(n, '7'), signed: 'eA==' });
      if (n === 1) throw new TransportError('send_tx: timeout');
      return fakeHash(n, '7');
    } });
    assert.equal((await h.relay(body(msg({ expiry: 1300n })), 'ip')).status, 504);
    h.state.height = 1300n;
    assert.equal((await h.relay(body(msg({ amount: 5n, issued: 1250n, expiry: 2000n })), 'ip')).status, 200);
  });

  test('a slot whose message was accepted is never released', () => {
    const l = new Ledger();
    const a = msg({ expiry: 1300n });
    const [slot, ma] = [slotId(a), messageId(a)];
    assert.ok(l.claim(slot, ma, { nonce: 3n, expiry: 1300n, pending: null, chain: { nonce: 3n, height: 1200n } }));
    l.signed(ma, fakeHash(1), 'eA==');
    l.settle(ma, 'submitted');
    l.observe(fakeHash(1), { status: 'delivered' });
    const mb = messageId(msg({ amount: 5n }));
    assert.equal(l.claim(slot, mb, { nonce: 3n, expiry: 2000n, pending: null, chain: { nonce: 3n, height: 5000n } }), false);
    // and an unspent one only if the finalized nonce is unchanged
    l.observe(fakeHash(1), { status: 'unknown', attemptRejected: true });
    assert.equal(l.lookup(ma).state, 'delivered', 'a spent nonce never goes back');
    const l2 = new Ledger();
    assert.ok(l2.claim(slot, ma, { nonce: 3n, expiry: 1300n, pending: null, chain: { nonce: 3n, height: 1200n } }));
    l2.signed(ma, fakeHash(2), 'eA==');
    l2.settle(ma, 'uncertain');
    assert.equal(l2.claim(slot, mb, { nonce: 3n, expiry: 2000n, pending: null, chain: { nonce: 4n, height: 5000n } }), false);
  });

  test('the same still-valid message is resent after a known rejection, not merely because of a repeat', async () => {
    const h = harness();
    const b = body(msg());
    const first = await h.relay(b, 'ip');
    assert.deepEqual(await h.relay(b, 'ip'), first, 'a plain repeat returns the first hash');
    assert.equal(h.sent.length, 1);
    h.ledger.observe(first.body.transaction, { status: 'unknown', attemptRejected: true });
    const again = await h.relay(b, 'ip');
    assert.equal(again.status, 200);
    assert.notEqual(again.body.transaction, first.body.transaction);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.ledger.lookup(messageId(msg())).history.map((x) => x.tx), [first.body.transaction]);
    assert.deepEqual(await h.relay(b, 'ip'), again, 'and only once per known rejection');
  });

  test('after a rejection the resend still needs the chain: a moved nonce or a closed window refuses it', async () => {
    for (const change of [(s) => { s.nonce = 4n; }, (s) => { s.height = 1600n; }]) {
      const h = harness();
      const b = body(msg());
      const first = await h.relay(b, 'ip');
      h.ledger.observe(first.body.transaction, { status: 'unknown', attemptRejected: true });
      change(h.state);
      assert.equal((await h.relay(b, 'ip')).status, 422);
      assert.equal(h.sent.length, 1);
    }
  });

  test('a delivered or failed payment is never resent', async () => {
    for (const status of ['delivered', 'failed', 'accepted']) {
      const h = harness();
      const b = body(msg());
      const first = await h.relay(b, 'ip');
      h.ledger.observe(first.body.transaction, { status });
      assert.deepEqual(await h.relay(b, 'ip'), first);
      assert.equal(h.sent.length, 1);
    }
  });
});

describe('quotas (after the signature only)', () => {
  test('per vault', async () => {
    const h = harness({ vaultPerHour: 2 });
    for (const n of [3n, 4n]) assert.equal((await harnessNonce(h, n)).status, 200);
    const third = await harnessNonce(h, 5n);
    assert.equal(third.status, 429);
    assert.equal(h.sent.length, 2);
  });

  test('per client address', async () => {
    const h = harness({ ipPerHour: 1, vaultPerHour: 9 });
    assert.equal((await harnessNonce(h, 3n, 'x')).status, 200);
    assert.equal((await harnessNonce(h, 4n, 'x')).status, 429);
    assert.equal((await harnessNonce(h, 4n, 'y')).status, 200);
  });

  test('invalid signatures do not consume quota', async () => {
    const h = harness({ vaultPerHour: 1, ipPerHour: 1 });
    for (let i = 0; i < 5; i++) assert.equal((await h.relay(body(msg(), Buffer.alloc(SIG_LEN, i)), 'x')).status, 422);
    assert.equal((await h.relay(body(msg()), 'x')).status, 200);
  });

  // The fake chain follows the nonce the request asks for, as if each earlier payment had executed.
  function harnessNonce(h, nonce, ip = 'ip') {
    h.state.nonce = nonce;
    return h.relay(body(msg({ nonce })), ip);
  }
});

describe('spend cap', () => {
  test('pauses once the next budget would cross the cap, then refuses with 503', async () => {
    const perTx = 30n * TGAS * PRICE;
    let nonce = 3n;
    const sent = [];
    const r = createRelay(relayDeps({ readVault: async () => ({ publicKey: owner.publicKey, nonce, height: 1200n }),
      submit: async (q, onSigned) => { sent.push(q); const tx = fakeHash(sent.length, '3'); onSigned({ transaction: tx, signed: 'eA==' }); return tx; },
      limiter: new Limiter({ concurrency: 1, queue: 9 }), cap: new SpendCap(perTx * 2n + 1n) }));
    const first = body(msg({ nonce: 3n }));
    assert.equal((await r.relay(first, 'ip')).status, 200);
    nonce = 4n;
    assert.equal((await r.relay(body(msg({ nonce: 4n })), 'ip')).status, 200);
    nonce = 5n;
    const over = await r.relay(body(msg({ nonce: 5n })), 'ip');
    assert.equal(over.status, 503);
    const after = await r.relay(body(msg({ nonce: 5n, amount: 1n })), 'ip');
    assert.equal(after.status, 503, 'stays paused');
    assert.equal(sent.length, 2);
    assert.equal((await r.relay(first, 'ip')).status, 200, 'a repeat of a submitted message is still answered');
  });

  test('a zero cap starts paused', () => {
    const c = new SpendCap(0n);
    assert.equal(c.paused, true);
    assert.equal(c.reserve(1n), false);
  });

  test('bounded queue refuses beyond capacity', async () => {
    const l = new Limiter({ concurrency: 1, queue: 1 });
    let open;
    const gate = new Promise((ok) => { open = ok; });
    const a = l.run(() => gate);
    const b = l.run(async () => 'b');
    await assert.rejects(l.run(async () => 'c'), /busy/);
    open('a');
    assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  });
});

describe('ML-DSA-87 interoperability: wallet (noble) and test signer (OpenSSL)', () => {
  const pem = join(scratch, 'owner.pem');
  const key = Key.generate(pem);
  const noble = nobleKeyFromPem(pem);
  const m = msg();

  test('same public key from the same seed', () => {
    assert.ok(Buffer.from(noble.publicKey).equals(key.publicKey));
  });

  test('OpenSSL signature verifies with noble', () => {
    assert.equal(verifyAuthorization(key.sign(m), m, key.publicKey), true);
    assert.equal(verifyAuthorization(key.sign(m, Buffer.from('other')), m, key.publicKey), false);
  });

  test('noble signature verifies with OpenSSL', () => {
    const sig = ml_dsa87.sign(m, noble.secretKey, { context: CONTEXT });
    const spki = Buffer.concat([Buffer.from('30820a32300b060960864801650304031303820a2100', 'hex'), key.publicKey]);
    writeFileSync(join(scratch, 'pub.der'), spki);
    writeFileSync(join(scratch, 'm'), m);
    writeFileSync(join(scratch, 's'), sig);
    const verify = (ctx) => execFileSync('openssl', ['pkeyutl', '-verify', '-rawin', '-pubin', '-keyform', 'DER', '-inkey', join(scratch, 'pub.der'),
      '-in', join(scratch, 'm'), '-sigfile', join(scratch, 's'), '-pkeyopt', `hexcontext-string:${ctx.toString('hex')}`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    assert.match(verify(CONTEXT), /Signature Verified Successfully/);
    assert.throws(() => verify(Buffer.from('qlyphs/near-vault/v2')));
  });
});

describe('outcome (R2-H1)', () => {
  const V = vault;
  const AMOUNT = 10n ** 22n;
  const args = (m) => Buffer.concat([sign(m), m]).toString('base64');
  const nearMsg = msg({ amount: AMOUNT });
  const ftMsg = msg({ kind: 'ft', token: 'wrap.testnet', ftGasTgas: 30, amount: 7n });
  const transferTo = (receiver, deposit = AMOUNT.toString()) => ({ receipt_id: 'P', predecessor_id: V, receiver_id: receiver, receipt: { Action: { actions: [{ Transfer: { deposit } }] } } });
  const ftArgs = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
  // What the vault emits for ftMsg (contract/vault.c): exact JSON bytes, 1 yocto, the signed 30 Tgas.
  const ftAction = (over = {}) => ({ method_name: 'ft_transfer', args: ftArgs({ receiver_id: 'alice.testnet', amount: '7' }), gas: 30 * 1e12, deposit: '1', ...over });
  const ftCall = { receipt_id: 'P', predecessor_id: V, receiver_id: 'wrap.testnet', receipt: { Action: { actions: [{ FunctionCall: ftAction() }] } } };
  const ftWith = (over) => ({ ...ftCall, receipt: { Action: { actions: [{ FunctionCall: ftAction(over) }] } } });
  // A refund to the relayer, executed like the payment would be: never to be taken for it.
  const refund = { receipt_id: 'R', predecessor_id: 'system', receiver_id: 'relayer.testnet', receipt: { Action: { actions: [{ Transfer: { deposit: AMOUNT.toString() } }] } } };
  const result = ({ m = nearMsg, tx = { Success: true }, execute = { SuccessValue: '' }, payment = { SuccessValue: '' }, receipts, emitted = ['P', 'R'] } = {}) => ({
    transaction: { receiver_id: V, actions: [{ FunctionCall: { method_name: 'execute', args: args(m) } }] },
    transaction_outcome: { outcome: { status: tx.Failure ? { Failure: {} } : { SuccessReceiptId: 'E' }, receipt_ids: tx.Failure ? [] : ['E'], executor_id: 'relayer.testnet' } },
    receipts_outcome: [
      { id: 'E', outcome: { status: execute, receipt_ids: emitted, executor_id: V } },
      ...(payment ? [{ id: 'P', outcome: { status: payment, receipt_ids: [], executor_id: 'alice.testnet' } }] : []),
      { id: 'R', outcome: { status: { SuccessValue: '' }, receipt_ids: [], executor_id: 'relayer.testnet' } },
    ],
    receipts: receipts ?? [transferTo('alice.testnet'), refund],
  });
  const c = (r) => classify(r, deployment);

  test('delivered, NEAR and ft', () => {
    assert.equal(c(result()).status, 'delivered');
    assert.equal(c(result({ m: ftMsg, receipts: [ftCall, refund] })).status, 'delivered');
  });
  test('failed only when an accepted execute\'s payment receipt failed', () => {
    assert.equal(c(result({ payment: { Failure: {} } })).status, 'failed');
  });
  test('a refused execute is unknown with attemptRejected, never failed', () => {
    const r = c(result({ execute: { Failure: { ActionError: {} } }, emitted: ['R'] }));
    assert.equal(r.status, 'unknown');
    assert.equal(r.attemptRejected, true);
  });
  test('a refused transaction is unknown with attemptRejected', () => {
    const r = c(result({ tx: { Failure: true } }));
    assert.deepEqual([r.status, r.attemptRejected], ['unknown', true]);
  });
  test('accepted while the payment has no outcome', () => assert.equal(c(result({ payment: null })).status, 'accepted'));
  test('no payment receipt among those execute emitted: unknown (a refund is not a payment)', () => {
    assert.equal(c(result({ emitted: ['R'], receipts: [refund] })).status, 'unknown');
    assert.equal(c(result({ receipts: [{ ...refund, receipt_id: 'P' }] })).status, 'unknown', 'refund under the payment id, from system');
  });
  test('a receipt that does not carry exactly the signed action is not the payment', () => {
    for (const receipts of [
      [transferTo('alice.testnet', '1'), refund], // wrong amount
      [transferTo('mallory.testnet'), refund], // wrong receiver
      [{ ...transferTo('alice.testnet'), predecessor_id: 'other.testnet' }, refund],
      [{ ...transferTo('alice.testnet'), receipt: { Action: { actions: [{ Transfer: { deposit: AMOUNT.toString() } }, { Transfer: { deposit: '1' } }] } } }],
    ]) assert.equal(c(result({ receipts })).status, 'unknown', JSON.stringify(receipts[0]));
    assert.equal(c(result({ m: ftMsg, receipts: [ftWith({ deposit: '2' })] })).status, 'unknown');
    assert.equal(c(result({ m: ftMsg, receipts: [{ ...ftCall, receiver_id: 'alice.testnet' }] })).status, 'unknown');
  });
  test('R3: an ft_transfer whose decoded arguments or gas differ from the signed ones is not the payment', () => {
    assert.equal(c(result({ m: ftMsg, receipts: [ftCall, refund] })).status, 'delivered', 'the exact call');
    for (const [why, over] of [
      ['another receiver', { args: ftArgs({ receiver_id: 'mallory.testnet', amount: '7' }) }],
      ['another amount', { args: ftArgs({ receiver_id: 'alice.testnet', amount: '8' }) }],
      ['amount as a number', { args: ftArgs('{"receiver_id":"alice.testnet","amount":7}') }],
      ['amount with a leading zero', { args: ftArgs({ receiver_id: 'alice.testnet', amount: '07' }) }],
      ['an extra field', { args: ftArgs({ receiver_id: 'alice.testnet', amount: '7', memo: 'x' }) }],
      ['a duplicate key', { args: ftArgs('{"receiver_id":"mallory.testnet","receiver_id":"alice.testnet","amount":"7"}') }],
      ['fields reordered', { args: ftArgs({ amount: '7', receiver_id: 'alice.testnet' }) }],
      ['not JSON', { args: ftArgs('not json') }],
      ['no args', { args: undefined }],
      ['less gas', { gas: 29 * 1e12 }],
      ['more gas', { gas: 31 * 1e12 }],
      ['gas malformed', { gas: 'lots' }],
      ['another method', { method_name: 'ft_transfer_call' }],
    ]) assert.equal(c(result({ m: ftMsg, receipts: [ftWith(over), refund] })).status, 'unknown', why);
    // The gas may come as a decimal string too.
    assert.equal(c(result({ m: ftMsg, receipts: [ftWith({ gas: '30000000000000' }), refund] })).status, 'delivered');
  });
  test('two matching receipts are ambiguous: unknown', () => {
    assert.equal(c(result({ emitted: ['P', 'Q'], receipts: [transferTo('alice.testnet'), { ...transferTo('alice.testnet'), receipt_id: 'Q' }] })).status, 'unknown');
  });
  test('execute found by id and executor, not by executor alone', () => {
    const r = result();
    r.transaction_outcome.outcome.receipt_ids = ['X'];
    assert.equal(c(r).status, 'unknown');
    const r2 = result();
    r2.receipts_outcome[0].outcome.executor_id = 'other.testnet';
    assert.equal(c(r2).status, 'unknown');
  });
  test('a transaction that carries no valid authorization, or targets another account, is unknown', () => {
    const r = result();
    r.transaction.actions[0].FunctionCall.args = Buffer.alloc(10).toString('base64');
    assert.equal(c(r).status, 'unknown');
    const r2 = result();
    r2.transaction.receiver_id = 'other.testnet';
    assert.equal(c(r2).status, 'unknown');
  });
  test('missing data is unknown', () => {
    assert.equal(c({}).status, 'unknown');
    assert.equal(c({ ...result(), receipts_outcome: [] }).status, 'unknown');
  });
  test('a timeout is never failed', async () => {
    const rpc = { call: async () => { throw new TransportError('timeout'); } };
    assert.equal((await outcome(rpc, { txHash: 'x', sender: 's', deployment, ours: true })).status, 'unknown');
    const unknownTx = { call: async () => { throw new RpcError({ cause: { name: 'UNKNOWN_TRANSACTION' } }); } };
    assert.equal((await outcome(unknownTx, { txHash: 'x', sender: 's', deployment, ours: true })).status, 'submitted');
    assert.equal((await outcome(unknownTx, { txHash: 'x', sender: 's', deployment, ours: false })).status, 'unknown');
  });
});

describe('R2-M4: outcome reads are bounded and coalesced', () => {
  const H = (i) => `${'4Ga95c7VWAAcUN8ajizoXLQrNExzwxWKoWue1wKnMUp'}${'abcdefghij'[i]}`;
  const reader = ({ concurrency = 1, queue = 1, perIp = 99, global = 99, read }) => createOutcomeReader({
    read, limiter: new Limiter({ concurrency, queue }),
    ipQuota: new Quota({ limit: perIp, windowMs: 6e4 }), globalQuota: new Quota({ limit: global, windowMs: 6e4 }),
  });

  test('concurrent reads of one transaction share a single RPC read', async () => {
    let calls = 0, open;
    const gate = new Promise((ok) => { open = ok; });
    const read = reader({ read: async () => { calls++; await gate; return { status: 'delivered' }; } });
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => read(H(0), `ip${i}`)));
    await new Promise((ok) => setTimeout(ok, 20));
    open();
    const rs = await all;
    assert.equal(calls, 1);
    assert.ok(rs.every((r) => r.status === 200 && r.body.status === 'delivered'));
  });

  test('distinct transactions beyond concurrency + queue are refused with 503', async () => {
    let open;
    const gate = new Promise((ok) => { open = ok; });
    const read = reader({ read: async () => { await gate; return { status: 'unknown' }; } });
    const a = read(H(0), 'x'), b = read(H(1), 'x');
    assert.equal((await read(H(2), 'x')).status, 503);
    open();
    assert.deepEqual((await Promise.all([a, b])).map((r) => r.status), [200, 200]);
  });

  test('per-client and global ingress budgets', async () => {
    const read = reader({ concurrency: 9, queue: 9, perIp: 2, global: 3, read: async () => ({ status: 'unknown' }) });
    assert.equal((await read(H(0), 'a')).status, 200);
    assert.equal((await read(H(1), 'a')).status, 200);
    assert.equal((await read(H(2), 'a')).status, 429, 'client budget');
    assert.equal((await read(H(3), 'b')).status, 200);
    assert.equal((await read(H(4), 'c')).status, 429, 'global budget');
  });

  test('a malformed hash is refused without any read; the ledger observes each answer', async () => {
    const seen = [];
    const read = createOutcomeReader({ read: async () => ({ status: 'unknown', attemptRejected: true }), limiter: new Limiter({ concurrency: 1, queue: 1 }),
      ipQuota: new Quota({ limit: 9, windowMs: 6e4 }), globalQuota: new Quota({ limit: 9, windowMs: 6e4 }), observe: (tx, r) => seen.push([tx, r.status]) });
    assert.equal((await read('nope', 'x')).status, 400);
    assert.equal((await read(H(0), 'x')).body.attemptRejected, true);
    assert.deepEqual(seen, [[H(0), 'unknown']]);
  });
});

describe('R2-M6: spend bound from the protocol config, persisted across restarts', () => {
  const config = protocolConfig;
  const rpcWith = (c) => ({ call: async (method) => { assert.equal(method, 'EXPERIMENTAL_protocol_config'); if (c instanceof Error) throw c; return c; } });

  test('bound = (send + execution fees + prepaid gas) x max(ceiling, purchase floor)', async () => {
    const costs = await readProtocolCosts(rpcWith(config), deployment);
    const bytes = BigInt('execute'.length + REQUEST_LEN);
    const gas = 2n * 108059500000n + 200000000000n + 780000000000n + (47683715n + 2235934n) * bytes + 30n * TGAS;
    assert.equal(costBound(costs, { argsLen: REQUEST_LEN, prepaidGas: 30n * TGAS, maxGasPriceYocto: 10n ** 9n }), gas * 10n ** 9n);
    // The purchase floor applies even under a lower ceiling; a higher ceiling raises the bound.
    assert.equal(costBound(costs, { argsLen: REQUEST_LEN, prepaidGas: 30n * TGAS, maxGasPriceYocto: 10n ** 8n }), gas * 10n ** 9n);
    assert.equal(costBound(costs, { argsLen: REQUEST_LEN, prepaidGas: 30n * TGAS, maxGasPriceYocto: 2n * 10n ** 9n }), gas * 2n * 10n ** 9n);
    assert.ok(gas * 10n ** 9n > 30n * TGAS * 10n ** 9n, 'strictly more than the old prepaid-only reservation');
  });

  test('no start without a usable protocol config', async () => {
    await assert.rejects(readProtocolCosts(rpcWith(new TransportError('timeout')), deployment), /unavailable/);
    await assert.rejects(readProtocolCosts(rpcWith({ ...config, chain_id: 'mainnet' }), deployment), /not testnet/);
    const inflating = structuredClone(config);
    inflating.runtime_config.transaction_costs.pessimistic_gas_price_inflation_ratio = [103, 100];
    await assert.rejects(readProtocolCosts(rpcWith(inflating), deployment), /inflation/);
    const missing = structuredClone(config);
    delete missing.runtime_config.min_gas_purchase_price;
    await assert.rejects(readProtocolCosts(rpcWith(missing), deployment), /min_gas_purchase_price/);
  });

  test('startFromEnv refuses to start when the RPC cannot give the protocol config', async () => {
    const rpcServer = (await import('node:http')).createServer((req, res) => { res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'INTERNAL_ERROR' } } })); });
    await new Promise((ok) => rpcServer.listen(0, '127.0.0.1', ok));
    try {
      await assert.rejects(startFromEnv({ RELAYER_ACCOUNT: 'relayer.testnet', RELAYER_KEY_FILE: '/dev/null', RELAYER_STATE_DIR: scratch, PORT: '0',
        NEAR_RPC: `http://127.0.0.1:${rpcServer.address().port}` }), /protocol config unavailable/);
    } finally {
      rpcServer.close();
    }
  });

  test('the gas price must leave 2x headroom under the ceiling, or nothing is signed', async () => {
    const h = harness({ price: PRICE / 2n + 1n });
    assert.equal((await h.relay(body(msg()), 'ip')).status, 503);
    assert.equal(h.sent.length, 0);
    h.state.price = PRICE / 2n;
    assert.equal((await h.relay(body(msg()), 'ip')).status, 200);
  });

  test('an exhausted budget survives a restart; only a raised cap or a deleted file resumes', () => {
    const file = join(scratch, 'spend.json');
    rmSync(file, { force: true });
    const a = new SpendCap(10n, { file });
    assert.equal(a.reserve(6n), true);
    assert.equal(a.reserve(6n), false);
    assert.equal(a.paused, true);
    const restarted = new SpendCap(10n, { file });
    assert.equal(restarted.paused, true, 'same cap after restart: still paused');
    assert.equal(restarted.spent, 6n);
    assert.equal(restarted.reserve(1n), false);
    const lower = new SpendCap(6n, { file });
    assert.equal(lower.paused, true);
    const raised = new SpendCap(20n, { file });
    assert.equal(raised.paused, false);
    assert.equal(raised.spent, 6n, 'raising the cap keeps what was already reserved');
    assert.equal(raised.reserve(14n), true);
    assert.equal(raised.reserve(1n), false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).reserved_yocto, '20');
    rmSync(file);
    assert.equal(new SpendCap(20n, { file }).spent, 0n);
  });

  test('a reservation is on disk before it counts; a malformed or unwritable file fails closed', () => {
    const file = join(scratch, 'spend2.json');
    const cap = new SpendCap(100n, { file });
    cap.reserve(7n);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).reserved_yocto, '7');
    writeFileSync(file, '{"version":1}');
    assert.throws(() => new SpendCap(100n, { file }), /malformed/);
    const dir = join(scratch, 'not-a-dir-file');
    writeFileSync(dir, '');
    assert.throws(() => new SpendCap(100n, { file: join(dir, 'x.json') }));
  });
});

describe('R3-1a: the gas price is checked at the block the transaction is signed against', () => {
  // A fake RPC whose final block, gas price and access key a test moves.
  function fakeRpc({ height = 500n, price = PRICE / 2n } = {}) {
    const st = { height, price, sends: [] };
    st.call = async (method, params) => {
      if (method === 'query') return { nonce: 41 };
      if (method === 'block') return { header: { hash: '11111111111111111111111111111111', height: Number(st.height), gas_price: String(st.price) } };
      if (method === 'send_tx') { st.sends.push(params.signed_tx_base64); return {}; }
      throw new Error(method);
    };
    return st;
  }
  const submitterOn = (rpc) => createSubmitter({ rpc, accountId: 'relayer.testnet', keyPair: KeyPair.fromRandom('ed25519'), maxGasPriceYocto: PRICE, priceStep: STEP });
  const request = { vault, args: new Uint8Array(REQUEST_LEN), gas: 30n * TGAS };

  test('price window: blocks until the price could pass the ceiling at 1 % per block', () => {
    // 1.01^69 = 1.989 <= 2 < 1.01^70 = 2.007
    assert.equal(priceSafeBlocks(PRICE / 2n, PRICE, STEP), 69n);
    assert.equal(priceSafeBlocks(PRICE, PRICE, STEP), 0n);
    assert.equal(priceSafeBlocks(PRICE + 1n, PRICE, STEP), 0n);
    let p = PRICE / 4n;
    const n = priceSafeBlocks(p, PRICE, STEP);
    for (let i = 0n; i < n; i++) p = p * 101n / 100n;
    assert.ok(p <= PRICE && p * 101n / 100n > PRICE * 99n / 100n, 'tight, and never past the ceiling');
  });

  test('a price above half the ceiling at the signing block: nothing signed, nothing sent', async () => {
    const rpc = fakeRpc({ price: PRICE / 2n + 1n });
    let signed = null;
    await assert.rejects(submitterOn(rpc).submit(request, (s) => { signed = s; }), PriceTooHigh);
    assert.equal(signed, null);
    assert.deepEqual(rpc.sends, []);
  });

  test('signing records the last height it may be re-broadcast at; past it nothing is sent again', async () => {
    const rpc = fakeRpc({ height: 500n, price: PRICE / 2n });
    const { submit, rebroadcast } = submitterOn(rpc);
    let seen;
    await submit(request, (s) => { seen = s; });
    assert.equal(seen.rebroadcastUntil, 500n + 69n - INCLUSION_MARGIN_BLOCKS);
    rpc.height = seen.rebroadcastUntil;
    await rebroadcast(seen.signed, seen.rebroadcastUntil);
    assert.deepEqual(rpc.sends, [seen.signed, seen.signed]);
    rpc.height = seen.rebroadcastUntil + 1n;
    await assert.rejects(rebroadcast(seen.signed, seen.rebroadcastUntil), StaleReference);
    await assert.rejects(rebroadcast(seen.signed, undefined), StaleReference, 'no recorded window: never sent');
    assert.equal(rpc.sends.length, 2);
  });

  test('a price that rose while the request waited: 503, reservation and quotas given back, slot free', async () => {
    let rising = true;
    const h = harness({ vaultPerHour: 1, ipPerHour: 1, submit: async (req, n, onSigned) => {
      if (rising) throw new PriceTooHigh('rose');
      onSigned({ transaction: fakeHash(n), signed: 'eA==', rebroadcastUntil: 2000n });
      return fakeHash(n);
    } });
    const r = await h.relay(body(msg()), 'ip');
    assert.equal(r.status, 503);
    assert.match(r.body.error, /gas price/);
    assert.equal(h.ledger.lookup(messageId(msg())), null);
    rising = false;
    const ok = await h.relay(body(msg()), 'ip');
    assert.equal(ok.status, 200, 'quota of 1 per vault and per client was given back');
    assert.equal(h.ledger.lookup(messageId(msg())).rebroadcastUntil, 2000n);
  });

  test('the reservation of an unsigned attempt goes back to the cap', async () => {
    const cap = new SpendCap(10n ** 24n);
    const r = createRelay(relayDeps({ cap, submit: async () => { throw new PriceTooHigh('rose'); } }));
    assert.equal((await r.relay(body(msg()), 'ip')).status, 503);
    assert.equal(cap.spent, 0n);
  });

  test('an uncertain transaction past its window is marked stopped and never re-broadcast', async () => {
    const h = harness({
      submit: async (req, n, onSigned) => {
        onSigned({ transaction: fakeHash(n, '7'), signed: 'eA==', rebroadcastUntil: 1300n });
        throw new TransportError('send_tx: timeout');
      },
      rebroadcast: async () => { throw new StaleReference('too old'); },
    });
    const b = body(msg());
    assert.equal((await h.relay(b, 'ip')).status, 504);
    const stopped = await h.relay(b, 'ip');
    assert.equal(stopped.status, 504);
    assert.match(stopped.body.error, /not re-broadcast/);
    assert.equal(stopped.body.transaction, fakeHash(1, '7'));
    const e = h.ledger.lookup(messageId(msg()));
    assert.equal(e.state, 'uncertain');
    assert.equal(e.stopped, true);
    assert.equal(h.resent.length, 1, 'one attempt hit the window');
    assert.deepEqual(await h.relay(b, 'ip'), stopped);
    assert.equal(h.resent.length, 1, 'and nothing is sent after it');
    assert.equal((await h.relay(body(msg({ amount: 5n })), 'ip')).status, 409, 'the slot is kept while the window is open');
    // The outcome is still learned from the chain.
    h.ledger.observe(fakeHash(1, '7'), { status: 'delivered' });
    assert.equal(h.ledger.lookup(messageId(msg())).state, 'delivered');
  });
});

describe('R3-1b: the relayer account balance is the hard budget', () => {
  const NEAR = 10n ** 24n;
  const perByte = 10n ** 19n;
  const rpcAccount = (view) => ({ call: async (method, params) => {
    assert.equal(params.request_type, 'view_account');
    assert.equal(params.finality, 'final');
    if (view instanceof Error) throw view;
    return view;
  } });

  test('spendable = balance minus the storage stake not covered by locked', async () => {
    const view = { amount: '501134797994649199999995', locked: '0', storage_usage: 14773 };
    assert.equal(await spendableBalance(rpcAccount(view), { account: 'r.testnet', storageAmountPerByte: perByte }), 501134797994649199999995n - 14773n * perByte);
    assert.equal(await spendableBalance(rpcAccount({ ...view, locked: String(NEAR) }), { account: 'r.testnet', storageAmountPerByte: perByte }), 501134797994649199999995n);
    assert.equal(await spendableBalance(rpcAccount({ ...view, amount: '1' }), { account: 'r.testnet', storageAmountPerByte: perByte }), 0n);
  });

  test('refuses above RELAYER_MAX_ACCOUNT_SPENDABLE, accepts at or below it, fails closed on a bad read', async () => {
    const view = { amount: String(NEAR), locked: '0', storage_usage: 0 };
    const args = (max) => ({ account: 'r.testnet', storageAmountPerByte: perByte, maxSpendable: max });
    await assert.rejects(checkRelayerAccount(rpcAccount(view), args(NEAR - 1n)), /RELAYER_MAX_ACCOUNT_SPENDABLE/);
    assert.equal(await checkRelayerAccount(rpcAccount(view), args(NEAR)), NEAR);
    await assert.rejects(checkRelayerAccount(rpcAccount(new TransportError('timeout')), args(NEAR)), /unreadable/);
    await assert.rejects(checkRelayerAccount(rpcAccount({ amount: 'x', locked: '0', storage_usage: 0 }), args(NEAR)), /malformed/);
    assert.equal(loadConfig({ RELAYER_ACCOUNT: 'r.testnet', RELAYER_KEY_FILE: '/dev/null' }).maxAccountSpendableYocto, NEAR / 2n, 'default 0.5 NEAR');
  });
});

describe('R3-2: one relayer per state directory', () => {
  const NEAR = 10n ** 24n;
  let rpcServer, rpcUrl, balance = NEAR / 4n;
  const keyFile = join(scratch, 'relayer.key');
  writeFileSync(keyFile, KeyPair.fromRandom('ed25519').toString() + '\n');
  const start = (dir, extra = {}) => startFromEnv({ RELAYER_ACCOUNT: 'relayer.testnet', RELAYER_KEY_FILE: keyFile, RELAYER_STATE_DIR: dir, PORT: '0', NEAR_RPC: rpcUrl, ...extra });
  const stop = (s) => new Promise((ok) => { s.server.closeAllConnections(); s.server.close(ok); });

  // A fake RPC with the protocol config and the relayer account.
  before(async () => {
    rpcServer = (await import('node:http')).createServer((req, res) => {
      let text = '';
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        const { id, method } = JSON.parse(text);
        const result = method === 'EXPERIMENTAL_protocol_config' ? protocolConfig
          : { amount: String(balance), locked: '0', storage_usage: 1000, block_hash: 'x', block_height: 1 };
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    });
    await new Promise((ok) => rpcServer.listen(0, '127.0.0.1', ok));
    rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
  });

  test('a second instance on the same directory refuses to start; the first keeps its spend file', async () => {
    const dir = mkdtempSync(join(scratch, 'state-'));
    const a = await start(dir);
    assert.equal(readFileSync(join(dir, 'relayer.lock'), 'utf8'), `${process.pid}\n`);
    await assert.rejects(start(dir), /locked by running process/);
    const other = await start(mkdtempSync(join(scratch, 'state-')));
    await stop(other);
    await stop(a);
    assert.throws(() => readFileSync(join(dir, 'relayer.lock')), /ENOENT/, 'closing releases the lock');
    const b = await start(dir);
    await stop(b);
  });

  test('a failed start releases the lock; an over-funded account does not start', async () => {
    const dir = mkdtempSync(join(scratch, 'state-'));
    balance = NEAR;
    await assert.rejects(start(dir), /RELAYER_MAX_ACCOUNT_SPENDABLE/);
    const lifted = await start(dir, { RELAYER_MAX_ACCOUNT_SPENDABLE: String(NEAR) });
    const health = await (await fetch(`http://127.0.0.1:${lifted.address.port}/health`)).json();
    assert.equal(health.account_spendable_at_start_yocto, String(NEAR - 1000n * 10n ** 19n));
    await stop(lifted);
    balance = NEAR / 4n;
  });

  test('a lock left by a dead process, or unreadable, is cleared only on explicit request', () => {
    const dir = mkdtempSync(join(scratch, 'state-'));
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(dir, 'relayer.lock'), `${dead}\n`);
    assert.throws(() => acquireLock(dir), /stale lock .*not running.*RELAYER_CLEAR_STALE_LOCK=1/);
    const release = acquireLock(dir, { clearStale: true });
    assert.equal(readFileSync(join(dir, 'relayer.lock'), 'utf8'), `${process.pid}\n`);
    release();
    writeFileSync(join(dir, 'relayer.lock'), '');
    assert.throws(() => acquireLock(dir), /unreadable/);
    acquireLock(dir, { clearStale: true })();
    // A live pid is never cleared, not even on request.
    writeFileSync(join(dir, 'relayer.lock'), `${process.pid}\n`);
    assert.throws(() => acquireLock(dir, { clearStale: true }), /running process/);
    assert.equal(loadConfig({ RELAYER_ACCOUNT: 'r.testnet', RELAYER_KEY_FILE: '/dev/null', RELAYER_CLEAR_STALE_LOCK: '1' }).clearStaleLock, true);
  });

  after(() => rpcServer.close());
});

describe('R3-4: delivery states follow acceptance and never regress', () => {
  const setup = () => {
    const l = new Ledger();
    const m = messageId(msg());
    l.claim(slotId(msg()), m, { nonce: 3n, expiry: 1600n, pending: null, chain: { nonce: 3n, height: 1200n } });
    l.signed(m, fakeHash(1), 'eA==', 2000n);
    l.settle(m, 'submitted');
    return { l, state: () => l.lookup(m).state };
  };
  test('accepted -> delivered and accepted -> delivery_failed', () => {
    for (const [status, final] of [['delivered', 'delivered'], ['failed', 'delivery_failed']]) {
      const { l, state } = setup();
      l.observe(fakeHash(1), { status: 'accepted' });
      assert.equal(state(), 'accepted');
      l.observe(fakeHash(1), { status });
      assert.equal(state(), final);
    }
  });
  test('accepted never goes back to unknown or rejected; a delivery state is final', () => {
    const { l, state } = setup();
    l.observe(fakeHash(1), { status: 'accepted' });
    l.observe(fakeHash(1), { status: 'unknown', attemptRejected: true });
    l.observe(fakeHash(1), { status: 'submitted' });
    assert.equal(state(), 'accepted');
    l.observe(fakeHash(1), { status: 'delivered' });
    for (const status of ['accepted', 'failed', 'unknown', 'submitted']) l.observe(fakeHash(1), { status, attemptRejected: true });
    assert.equal(state(), 'delivered');
    const b = setup();
    b.l.observe(fakeHash(1), { status: 'failed' });
    for (const status of ['accepted', 'delivered']) b.l.observe(fakeHash(1), { status });
    assert.equal(b.state(), 'delivery_failed');
  });
});

describe('http', () => {
  const post = (port, data, headers = {}) => new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/execute', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => ok({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', fail);
    if (typeof data === 'function') data(req); else req.end(data);
  });

  async function serve() {
    const calls = [];
    const server = createRelayerServer({
      relay: async (b, ip) => { calls.push({ len: b.length, ip }); return { status: 200, body: { transaction: 'T' } }; },
      outcomeOf: async (tx, ip) => (/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx) ? { status: 200, body: { transaction: tx, status: 'unknown', ip } } : { status: 400, body: { error: 'not a transaction hash' } }),
      health: () => ({ ok: true }),
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    return { server, calls, port: server.address().port };
  }

  test('oversize body refused by declared length, without reading it', async () => {
    const { server, calls, port } = await serve();
    const r = await post(port, (req) => { req.setHeader('content-length', 10_000_000); req.write(Buffer.alloc(1000)); });
    assert.equal(r.status, 400);
    assert.equal(calls.length, 0);
    server.close();
  });

  test('oversize streamed body refused once past 4,883 bytes', async () => {
    const { server, calls, port } = await serve();
    let written = 0;
    const r = await post(port, (req) => {
      req.setHeader('transfer-encoding', 'chunked');
      const pump = () => { while (written < 1_000_000) { written += 1000; if (!req.write(Buffer.alloc(1000))) return req.once('drain', pump); } req.end(); };
      req.on('error', () => {});
      pump();
    }).catch((e) => ({ status: 'reset', e }));
    assert.ok(r.status === 400 || r.status === 'reset', String(r.status));
    assert.equal(calls.length, 0);
    server.close();
  });

  test('exact length is passed on; other routes and methods refused', async () => {
    const { server, calls, port } = await serve();
    assert.equal((await post(port, Buffer.alloc(REQUEST_LEN))).status, 200);
    assert.equal(calls[0].len, REQUEST_LEN);
    const get = (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.status);
    assert.equal(await get('/health'), 200);
    assert.equal(await get('/execute'), 405);
    assert.equal(await get('/outcome/not-a-hash'), 400);
    assert.equal(await get('/outcome/4Ga95c7VWAAcUN8ajizoXLQrNExzwxWKoWue1wKnMUpm'), 200);
    const o = await (await fetch(`http://127.0.0.1:${port}/outcome/4Ga95c7VWAAcUN8ajizoXLQrNExzwxWKoWue1wKnMUpm`)).json();
    assert.equal(o.ip, '127.0.0.1', 'the outcome route passes the socket address to the reader');
    assert.equal(await get('/nope'), 404);
    server.close();
  });
});

describe('config', () => {
  const env = { RELAYER_ACCOUNT: 'relayer.testnet', RELAYER_KEY_FILE: '/dev/null' };
  test('testnet deployment starts, bound to 127.0.0.1', () => {
    const c = loadConfig(env);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.deployment.network, 'testnet');
    assert.match(c.stateFile, /relayer\/\.state\/spend-testnet-relayer\.testnet\.json$/);
    assert.equal(loadConfig({ ...env, RELAYER_STATE_DIR: '/x' }).stateFile, '/x/spend-testnet-relayer.testnet.json');
  });
  test('the old prepaid-price setting is refused, not silently ignored', () => {
    assert.throws(() => loadConfig({ ...env, RELAYER_GAS_PRICE_YOCTO: '1' }), /RELAYER_MAX_GAS_PRICE_YOCTO/);
  });
  test('another network is refused unless named explicitly', () => {
    const file = join(scratch, 'mainnet.json');
    writeFileSync(file, JSON.stringify({ ...deployment, network: 'mainnet' }));
    assert.throws(() => loadConfig({ ...env, RELAYER_DEPLOYMENT: file }), /testnet only/);
    assert.throws(() => loadConfig({ ...env, RELAYER_DEPLOYMENT: file, RELAYER_ALLOW_NETWORK: 'sandbox' }), /testnet only/);
    assert.equal(loadConfig({ ...env, RELAYER_DEPLOYMENT: file, RELAYER_ALLOW_NETWORK: 'mainnet' }).deployment.network, 'mainnet');
  });
});
