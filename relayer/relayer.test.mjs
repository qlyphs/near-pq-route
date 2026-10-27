// Unit tests of the relayer: refusals before any gas, idempotence, quotas, spend cap, outcomes, HTTP limits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { CONTEXT, Key, SIG_LEN, encodeMessage, vaultAddress } from '../sdk/vault.mjs';
import { nobleKeyFromPem } from '../tests/ml-dsa-seed.mjs';
import { loadConfig } from './config.mjs';
import { Limiter, Quota, SpendCap } from './limits.mjs';
import { REQUEST_LEN, parseRequest } from './message.mjs';
import { classify, outcome } from './outcome.mjs';
import { attachedGas, createRelay } from './relay.mjs';
import { RpcError, TransportError } from './rpc.mjs';
import { createRelayerServer } from './server.mjs';
import { verifyAuthorization } from './signature.mjs';

const deployment = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
const TGAS = 10n ** 12n;
const PRICE = 10n ** 9n;
const scratch = mkdtempSync(join(tmpdir(), 'qvault-relayer-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const owner = ml_dsa87.keygen(randomBytes(32));
const vault = vaultAddress(owner.publicKey, deployment.factory);
const sign = (m, key = owner) => Buffer.from(ml_dsa87.sign(m, key.secretKey, { context: CONTEXT }));
const msg = (over = {}) => encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: 'alice.testnet', amount: 10n ** 22n, nonce: 3n, issued: 1000n, expiry: 1600n, ...over });
const body = (m, sig = sign(m)) => Buffer.concat([sig, m]);

/** A relay over a fake chain: the vault sits at nonce 3, final height 1200. Records every submission. */
function harness({ cap = 10n ** 24n, vaultPerHour = 100, ipPerHour = 100, nonce = 3n, height = 1200n, submit } = {}) {
  const sent = [];
  const reads = [];
  const state = { nonce, height };
  const r = createRelay({
    deployment,
    readVault: async (v) => { reads.push(v); return { publicKey: owner.publicKey, ...state }; },
    submit: submit ?? (async (req) => { sent.push(req); return `Tx${String(sent.length).padStart(41, '1')}`; }),
    limiter: new Limiter({ concurrency: 2, queue: 4 }),
    vaultQuota: new Quota({ limit: vaultPerHour, windowMs: 3600e3 }),
    ipQuota: new Quota({ limit: ipPerHour, windowMs: 3600e3 }),
    cap: new SpendCap(cap),
    gasPriceYocto: PRICE,
  });
  return { ...r, sent, reads, state };
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
      const h = createRelay({ deployment, readVault: async () => { throw err; }, submit: async () => assert.fail('submitted'),
        limiter: new Limiter({ concurrency: 1, queue: 1 }), vaultQuota: new Quota({ limit: 9, windowMs: 1e6 }), ipQuota: new Quota({ limit: 9, windowMs: 1e6 }), cap: new SpendCap(10n ** 24n), gasPriceYocto: PRICE });
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
    const h = harness({ submit: async () => { calls++; await gate; return 'Tx1111111111111111111111111111111111111111111'; } });
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

  test('a node refusal frees the slot; a lost answer keeps the hash', async () => {
    let mode = 'refuse';
    const h = harness({ submit: async () => {
      if (mode === 'refuse') throw new RpcError({ name: 'INVALID_TRANSACTION' });
      const e = new TransportError('timeout'); e.transaction = 'Tx2222222222222222222222222222222222222222222'; throw e;
    } });
    const b = body(msg());
    assert.equal((await h.relay(b, 'ip')).status, 502);
    mode = 'lost';
    const lost = await h.relay(b, 'ip');
    assert.equal(lost.status, 504);
    assert.equal(lost.body.transaction, 'Tx2222222222222222222222222222222222222222222');
    mode = 'refuse';
    const again = await h.relay(b, 'ip');
    assert.equal(again.status, 200);
    assert.equal(again.body.transaction, lost.body.transaction);
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
    const r = createRelay({ deployment, readVault: async () => ({ publicKey: owner.publicKey, nonce, height: 1200n }),
      submit: async (q) => { sent.push(q); return `Tx${String(sent.length).padStart(41, '3')}`; },
      limiter: new Limiter({ concurrency: 1, queue: 9 }), vaultQuota: new Quota({ limit: 99, windowMs: 1e6 }), ipQuota: new Quota({ limit: 99, windowMs: 1e6 }),
      cap: new SpendCap(perTx * 2n + 1n), gasPriceYocto: PRICE });
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

describe('outcome', () => {
  const V = vault;
  const result = ({ execute = { SuccessValue: '' }, payment = { SuccessValue: '' }, kind = 'Transfer', withPayment = true } = {}) => ({
    transaction: { receiver_id: V, actions: [{ FunctionCall: { method_name: 'execute' } }] },
    transaction_outcome: { outcome: { status: { SuccessReceiptId: 'E' } } },
    receipts_outcome: [
      { id: 'E', outcome: { status: execute, receipt_ids: withPayment ? ['P', 'R'] : ['R'] } },
      ...(withPayment && payment ? [{ id: 'P', outcome: { status: payment, receipt_ids: [] } }] : []),
      { id: 'R', outcome: { status: { SuccessValue: '' }, receipt_ids: [] } },
    ],
    receipts: [
      { receipt_id: 'P', predecessor_id: V, receiver_id: 'alice.testnet', receipt: { Action: { actions: [kind === 'Transfer' ? { Transfer: { deposit: '1' } } : { FunctionCall: { method_name: 'ft_transfer' } }] } } },
      { receipt_id: 'R', predecessor_id: 'system', receiver_id: 'relayer.testnet', receipt: { Action: { actions: [{ Transfer: { deposit: '9' } }] } } },
    ],
  });

  test('delivered, NEAR and ft', () => {
    assert.equal(classify(result()).status, 'delivered');
    assert.equal(classify(result({ kind: 'ft' })).status, 'delivered');
  });
  test('payment receipt failed', () => assert.equal(classify(result({ payment: { Failure: {} } })).status, 'failed'));
  test('execute refused', () => assert.equal(classify(result({ execute: { Failure: {} } })).status, 'failed'));
  test('accepted while the payment has no outcome', () => assert.equal(classify(result({ payment: null })).status, 'accepted'));
  test('gas refund is not mistaken for a payment', () => assert.equal(classify(result({ withPayment: false })).status, 'accepted'));
  test('missing data is unknown', () => {
    assert.equal(classify({}).status, 'unknown');
    assert.equal(classify({ ...result(), receipts_outcome: [] }).status, 'unknown');
  });
  test('a timeout is never failed', async () => {
    const rpc = { call: async () => { throw new TransportError('timeout'); } };
    assert.equal((await outcome(rpc, { txHash: 'x', sender: 's', ours: true })).status, 'unknown');
    const unknownTx = { call: async () => { throw new RpcError({ cause: { name: 'UNKNOWN_TRANSACTION' } }); } };
    assert.equal((await outcome(unknownTx, { txHash: 'x', sender: 's', ours: true })).status, 'submitted');
    assert.equal((await outcome(unknownTx, { txHash: 'x', sender: 's', ours: false })).status, 'unknown');
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
      outcomeOf: async () => ({ status: 'unknown' }), health: () => ({ ok: true }),
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
  });
  test('another network is refused unless named explicitly', () => {
    const file = join(scratch, 'mainnet.json');
    writeFileSync(file, JSON.stringify({ ...deployment, network: 'mainnet' }));
    assert.throws(() => loadConfig({ ...env, RELAYER_DEPLOYMENT: file }), /testnet only/);
    assert.throws(() => loadConfig({ ...env, RELAYER_DEPLOYMENT: file, RELAYER_ALLOW_NETWORK: 'sandbox' }), /testnet only/);
    assert.equal(loadConfig({ ...env, RELAYER_DEPLOYMENT: file, RELAYER_ALLOW_NETWORK: 'mainnet' }).deployment.network, 'mainnet');
  });
});
