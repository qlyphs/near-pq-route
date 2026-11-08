// Sandbox suite for Qlyphs Guardian (contract/guardian.c) driving the reference token: init rules, the common
// validator, quorum, nonce and replay, timelock, cancel, expiry, dispatch once, gas, upgrade failure and success,
// maximum code size. Writes evidence/guardian-sandbox.json.
import { Worker } from 'near-workspaces';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Key } from '../sdk/vault.mjs';
import { encodeConfig, encodeOperation, approve, sha256, MAX_CODE, OP_LEN } from '../sdk/guardian.mjs';

// Raw envelope, without the SDK's client-side checks: these tests send malformed input on purpose to see
// what the contract itself refuses (the SDK's own refusals are in tests/sdk.unit.mjs).
const envelope = (op, approvals, code) => new Uint8Array(Buffer.concat([Buffer.from(op), ...approvals.flatMap(({ index, signature }) => [Buffer.from([index]), Buffer.from(signature)]), ...(code ? [Buffer.from(code)] : [])]));

const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const hex = (b) => Buffer.from(b).toString('hex');
const results = [];
let failures = 0;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
const failureText = (r) => JSON.stringify(r.Failure ?? r.receiptFailures ?? r.result?.status ?? '');
async function refused(name, call, reason) {
  const r = await call();
  record(name, r.failed && failureText(r).includes(reason), r.failed ? (failureText(r).includes(reason) ? reason : failureText(r).slice(0, 160)) : 'was accepted');
  return r;
}
const gasOf = (r) => Number(BigInt(r.result.transaction_outcome.outcome.gas_burnt) + r.result.receipts_outcome.reduce((a, x) => a + BigInt(x.outcome.gas_burnt), 0n)) / 1e12;

const dir = mkdtempSync(join(tmpdir(), 'guardian-keys-'));
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const provider = worker.provider;
  const gWasm = readFileSync('build/guardian-sandbox.wasm');
  const v1 = readFileSync('build/token-v1.wasm'), v2 = readFileSync('build/token-v2.wasm'), v2bad = readFileSync('build/token-v2-failing.wasm');
  const signers = [0, 1, 2].map((i) => Key.generate(join(dir, `s${i}.pem`)));
  const outsider = Key.generate(join(dir, 'outsider.pem'));
  const now = async () => BigInt((await provider.block({ finality: 'optimistic' })).header.timestamp_nanosec);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const advance = async (seconds) => {
    const target = (await now()) + BigInt(seconds) * 10n ** 9n;
    while ((await now()) < target) { await provider.fastForward(500); await sleep(300); }
  };

  const parent = await root.createSubAccount('release', { initialBalance: 100n * NEAR });
  const owner = await root.createSubAccount('owner', { initialBalance: 20n * NEAR });
  const alice = await root.createSubAccount('alice', { initialBalance: 5n * NEAR });
  const relayer = await root.createSubAccount('relayer', { initialBalance: 50n * NEAR });
  const token = await parent.createSubAccount('token', { initialBalance: 10n * NEAR });
  await token.deploy(v1);
  await token.call(token, 'new', { owner_id: owner.accountId });
  await owner.call(token, 'mint', { receiver_id: alice.accountId, amount: '1000' });

  const config = encodeConfig({ target: token.accountId, delaySeconds: 60n, windowSeconds: 3600n, signerKeys: signers.map((k) => k.publicKey) });
  const configHash = sha256(config);
  const createGuardian = (name, cfg = config, from = parent) =>
    from.batch(`${name}.${from.accountId}`).createAccount().transfer(5n * NEAR).deployContract(gWasm)
      .functionCall('init', new Uint8Array(cfg), { gas: 50n * TGAS }).transact();
  const gr = await createGuardian('guardian');
  const guardian = `guardian.${parent.accountId}`;
  record('Guardian created in one batch: create, fund, deploy, init', gr.succeeded, `${gasOf(gr)} Tgas`);
  record('Guardian account has no access key', (await root.viewAccessKeys(guardian)).keys.length === 0);
  const gstate = () => root.getAccount(guardian).view('state');
  const tstate = () => token.view('state');
  const s0 = await gstate();
  record('state reports config hash, target, delay, signer key hashes', s0.config_sha256 === hex(configHash) && s0.target === token.accountId && s0.delay_seconds === 60 && s0.signer_key_sha256[1] === hex(sha256(signers[1].publicKey)) && s0.next_nonce === '0' && s0.active === null);

  await refused('init only once', () => parent.callRaw(guardian, 'init', new Uint8Array(config), { gas: 50n * TGAS }), 'already initialized');
  const dupCfg = encodeConfig({ target: token.accountId, delaySeconds: 60n, windowSeconds: 3600n, signerKeys: signers.map((k) => k.publicKey) });
  signers[0].publicKey.copy(dupCfg, 81 + 2592);
  await refused('init refuses duplicate signer keys', () => createGuardian('g-dup', dupCfg), 'signer keys must be distinct');
  await refused('init refuses a delay under 60 s', () => createGuardian('g-fast', encodeConfig({ target: token.accountId, delaySeconds: 59n, windowSeconds: 3600n, signerKeys: signers.map((k) => k.publicKey) })), 'delay must be');
  await refused('init refuses a window under 1 hour', () => createGuardian('g-short', encodeConfig({ target: token.accountId, delaySeconds: 60n, windowSeconds: 3599n, signerKeys: signers.map((k) => k.publicKey) })), 'window must be');
  await refused('init refuses the Guardian as its own target', () => createGuardian('g-self', encodeConfig({ target: `g-self.${parent.accountId}`, delaySeconds: 60n, windowSeconds: 3600n, signerKeys: signers.map((k) => k.publicKey) })), 'cannot guard itself');
  await parent.batch(`g-bare.${parent.accountId}`).createAccount().transfer(5n * NEAR).deployContract(gWasm).transact();
  await refused('init only from the direct parent', () => alice.callRaw(`g-bare.${parent.accountId}`, 'init', new Uint8Array(config), { gas: 50n * TGAS }), 'init must come from the parent');

  await owner.call(token, 'handover', { guardian_id: guardian });
  record('target handed to the Guardian', (await tstate()).guardian === guardian);

  const deadline = async (s = 600n) => (await now()) + s * 10n ** 9n;
  const base = { chain: 'sandbox', guardian, target: token.accountId, configHash };
  const op = async (fields) => encodeOperation({ ...base, deadlineNs: await deadline(), ...fields });
  const both = (m, a = 0, b = 1) => [approve(signers[a], a, m), approve(signers[b], b, m)];
  const propose = (input, gas = 300n * TGAS) => relayer.callRaw(guardian, 'propose', input, { gas });
  const cancel = (input) => relayer.callRaw(guardian, 'cancel', input, { gas: 300n * TGAS });
  const execute = (gas = 300n * TGAS) => relayer.callRaw(guardian, 'execute', new Uint8Array(0), { gas });

  // The common validator.
  const mint0 = await op({ nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 500n });
  await refused('one signer twice is not a quorum', () => propose(envelope(mint0, [approve(signers[0], 0, mint0), approve(signers[0], 0, mint0)])), 'distinct signers');
  await refused('an outsider key is not a signer', () => propose(envelope(mint0, [approve(signers[0], 0, mint0), approve(outsider, 1, mint0)])), 'invalid approval');
  await refused('approval index pointing at another signer', () => propose(envelope(mint0, [approve(signers[0], 0, mint0), approve(signers[1], 2, mint0)])), 'invalid approval');
  {
    const a = both(mint0), tampered = Buffer.from(mint0); tampered[260] ^= 1;
    await refused('approvals do not transfer to a changed amount', () => propose(envelope(tampered, a)), 'invalid approval');
  }
  await refused('wrong network tag', async () => { const m = await op({ chain: 'testnet', nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'wrong network');
  await refused('operation for another Guardian', async () => { const m = await op({ guardian: `other.${parent.accountId}`, nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'another Guardian');
  await refused('operation for another target', async () => { const m = await op({ target: alice.accountId, nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'another target');
  await refused('operation for another configuration', async () => { const m = await op({ configHash: Buffer.alloc(32, 7), nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'another configuration');
  await refused('expired approvals', async () => { const m = encodeOperation({ ...base, deadlineNs: (await now()) - 1n, nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'approvals expired');
  await refused('future nonce', async () => { const m = await op({ nonce: 5n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'stale or future nonce');
  await refused('nonzero reserved byte', async () => { const m = await op({ nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); m[300] = 1; return propose(envelope(m, both(m))); }, 'reserved bytes');
  await refused('non-canonical receiver padding', async () => { const m = await op({ nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); m[195 + 1 + 63] = 0x61; return propose(envelope(m, both(m))); }, 'bad receiver');
  await refused('unknown action', async () => { const m = await op({ nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 1n }); m[186] = 9; return propose(envelope(m, both(m))); }, 'unknown action');
  await refused('trailing bytes after a mint', () => propose(new Uint8Array(Buffer.concat([Buffer.from(envelope(mint0, both(mint0))), Buffer.from([0])]))), 'unexpected trailing');
  await refused('truncated envelope', () => propose(envelope(mint0, both(mint0)).subarray(0, OP_LEN + 100)), 'input shorter');
  await refused('propose refuses a cancel operation', async () => { const m = await op({ nonce: 0n, action: 'cancel', proposalHash: Buffer.alloc(32) }); return propose(envelope(m, both(m))); }, 'mint or an upgrade');
  record('rejections changed nothing', (await gstate()).next_nonce === '0' && (await gstate()).active === null);

  // Queue, timelock, execute once.
  const q0 = await propose(envelope(mint0, both(mint0, 1, 2)));
  const a0 = (await gstate()).active;
  record('valid mint queued with signers 1 and 2', q0.succeeded && a0?.status === 'queued' && a0.nonce === '0' && a0.receiver_id === alice.accountId && a0.amount === '500' && a0.signers === 6, `${gasOf(q0)} Tgas`);
  record('active record exposes the exact message', a0.message_hex === hex(mint0) && a0.proposal_hash === hex(sha256(mint0)));
  record('timelock = queue time + 60 s, in nanoseconds', BigInt(a0.eta_ns) - BigInt(a0.queued_at_ns) === 60n * 10n ** 9n && BigInt(a0.expires_ns) - BigInt(a0.eta_ns) === 3600n * 10n ** 9n);
  await refused('second proposal while one is active', async () => { const m = await op({ nonce: 1n, action: 'mint', receiver: alice.accountId, amount: 1n }); return propose(envelope(m, both(m))); }, 'another operation is active');
  await refused('replay of the queued approvals', () => propose(envelope(mint0, both(mint0))), 'stale or future nonce');
  await refused('execute before the timelock', () => execute(), 'timelock has not passed');
  record('early execute left the operation queued', (await gstate()).active?.status === 'queued');
  await advance(61);
  await refused('execute with too little gas after the timelock', () => execute(25n * TGAS), 'Exceeded the prepaid gas');
  record('underfunded execute left the operation queued', (await gstate()).active?.status === 'queued');
  const relayer2 = await root.createSubAccount('relayer2', { initialBalance: 50n * NEAR });
  const [e1, e2] = await Promise.all([execute(), relayer2.callRaw(guardian, 'execute', new Uint8Array(0), { gas: 300n * TGAS })]);
  record('two racing executes dispatch exactly once', [e1, e2].filter((r) => r.succeeded).length === 1 && [e1, e2].some((r) => failureText(r).includes('no queued operation')), [e1, e2].map((r) => r.succeeded ? `ok ${gasOf(r)} Tgas` : failureText(r).slice(0, 120)).join(' | '));
  const s1 = await gstate();
  record('mint applied and settled', s1.active === null && s1.last?.status === 'applied' && s1.last.nonce === '0' && (await token.view('ft_balance_of', { account_id: alice.accountId })) === '1500' && (await tstate()).next_op === '1');
  await refused('execute after settlement', () => execute(), 'no queued operation');
  await refused('on_result is private', () => relayer.callRaw(guardian, 'on_result', new Uint8Array(8), { gas: 30n * TGAS }), 'private');
  await refused('former owner cannot mint after handover', () => owner.callRaw(token, 'mint', { receiver_id: owner.accountId, amount: '9', op_id: '9' }), 'only the Guardian');

  // Cancel: domain-checked, bound to nonce and proposal hash, frees the slot.
  const mint1 = await op({ nonce: 1n, action: 'mint', receiver: alice.accountId, amount: 7n });
  await propose(envelope(mint1, both(mint1)));
  const other = await root.createSubAccount('guardian2', { initialBalance: 1n * NEAR });
  void other;
  {
    const wrong = await op({ nonce: 1n, action: 'cancel', proposalHash: Buffer.alloc(32, 1) });
    await refused('cancel naming another proposal', () => cancel(envelope(wrong, both(wrong))), 'another proposal');
    const elsewhere = await op({ guardian: `guardian2.${root.accountId}`, nonce: 1n, action: 'cancel', proposalHash: sha256(mint1) });
    await refused('cancel signed for another Guardian', () => cancel(envelope(elsewhere, both(elsewhere))), 'another Guardian');
    const late = await op({ nonce: 2n, action: 'cancel', proposalHash: sha256(mint1) });
    await refused('cancel naming another nonce', () => cancel(envelope(late, both(late))), 'another nonce');
    const one = await op({ nonce: 1n, action: 'cancel', proposalHash: sha256(mint1) });
    await refused('cancel needs two signers', () => cancel(envelope(one, [approve(signers[2], 2, one), approve(signers[2], 2, one)])), 'distinct signers');
    const c = await cancel(envelope(one, both(one, 0, 2)));
    const s2 = await gstate();
    record('cancel ends the queued operation and frees the slot', c.succeeded && s2.active === null && s2.last?.status === 'canceled' && s2.last.nonce === '1' && s2.next_nonce === '2');
    await refused('cancel replay', () => cancel(envelope(one, both(one, 0, 2))), 'no queued operation');
    await refused('canceled approvals cannot be queued again', () => propose(envelope(mint1, both(mint1))), 'stale or future nonce');
  }

  // Upgrade that fails in migration: settles Failed, target unchanged.
  const tcode = async () => sha256(Buffer.from((await provider.query({ request_type: 'view_code', account_id: token.accountId, finality: 'optimistic' })).code_base64, 'base64'));
  {
    const up = await op({ nonce: 2n, action: 'upgrade', code: v2bad, from: 1, to: 2 });
    await refused('upgrade code must match the approved hash', () => propose(envelope(up, both(up), v2)), 'code length does not match');
    const swapped = Buffer.from(v2bad); swapped[swapped.length - 1] ^= 1;
    await refused('upgrade code with the right length but other bytes', () => propose(envelope(up, both(up), swapped)), 'does not match the approved hash');
    const qu = await propose(envelope(up, both(up), v2bad));
    record('failing upgrade queued with its code', qu.succeeded && (await gstate()).active?.code_sha256 === hex(sha256(v2bad)), `${gasOf(qu)} Tgas`);
    await advance(61);
    const ex = await execute();
    const s3 = await gstate();
    record('failed migration settles Failed, old code and state kept', ex.succeeded && s3.last?.status === 'failed' && s3.active === null && hex(await tcode()) === hex(sha256(v1)) && (await tstate()).version === 1 && (await tstate()).next_op === '1');
  }

  // Successful upgrade V1 -> V2.
  {
    const up = await op({ nonce: 3n, action: 'upgrade', code: v2, from: 1, to: 2 });
    await propose(envelope(up, both(up, 0, 2), v2));
    await advance(61);
    const ex = await execute();
    const s4 = await gstate(), t4 = await tstate();
    record('upgrade V1 to V2 through the Guardian', ex.succeeded && s4.last?.status === 'applied' && t4.version === 2 && hex(await tcode()) === hex(sha256(v2)), `execute ${gasOf(ex)} Tgas`);
    record('balances, supply, Guardian and op high-water mark preserved', (await token.view('ft_balance_of', { account_id: alice.accountId })) === '1500' && t4.total_supply === '1500' && t4.guardian === guardian && t4.owner === null && t4.next_op === '4');
    const { values } = await provider.query({ request_type: 'view_state', account_id: guardian, prefix_base64: 'Yw==', finality: 'optimistic' });
    record('queued code deleted after settlement', values.length === 0);
  }

  // Expiry.
  {
    const m = await op({ nonce: 4n, action: 'mint', receiver: alice.accountId, amount: 1n });
    await propose(envelope(m, both(m)));
    await refused('expire before the window closes', () => relayer.callRaw(guardian, 'expire', new Uint8Array(0), { gas: 30n * TGAS }), 'still open');
    await advance(3661);
    await refused('execute after the dispatch window', () => execute(), 'dispatch window closed');
    const ex = await relayer.callRaw(guardian, 'expire', new Uint8Array(0), { gas: 30n * TGAS });
    record('expire frees the slot', ex.succeeded && (await gstate()).last?.status === 'expired' && (await gstate()).active === null);
  }

  // Maximum code size: queue, read back by paginated view_state, cancel, cleanup.
  {
    const big = randomBytes(MAX_CODE);
    const up = await op({ nonce: 5n, action: 'upgrade', code: big, from: 2, to: 3 });
    await refused('code above the cap', async () => { const m = Buffer.from(up); m.writeUInt32LE(MAX_CODE + 1, 227); return propose(envelope(m, both(m), Buffer.concat([big, Buffer.alloc(1)]))); }, 'register too large');
    const q = await propose(envelope(up, both(up), big));
    record('131,072-byte code queued', q.succeeded && (await gstate()).active?.code_length === MAX_CODE, `${gasOf(q)} Tgas`);
    // Paginated view_state (limit) exists from nearcore 2.13; the testnet suite reads the blob that way.
    const { version } = await provider.status();
    const page = await provider.query({ request_type: 'view_state', account_id: guardian, prefix_base64: 'Yw==', finality: 'optimistic', limit: 1 }).catch((e) => ({ error: e.message }));
    const blob = page.values?.find((v) => Buffer.from(v.key, 'base64').toString() === 'c');
    if (blob) record('maximum-size code readable by paginated view_state', sha256(Buffer.from(blob.value, 'base64')).equals(sha256(big)));
    else console.log(`NOTE sandbox nearcore ${version.version} cannot page view_state (${page.error?.slice(0, 80)}); checked on testnet`);
    const c = await op({ nonce: 5n, action: 'cancel', proposalHash: sha256(up) });
    const cr = await cancel(envelope(c, both(c)));
    const { values } = await provider.query({ request_type: 'view_state', account_id: guardian, prefix_base64: 'Yw==', finality: 'optimistic' });
    record('cancel deletes the maximum-size code', cr.succeeded && values.length === 0, `${gasOf(cr)} Tgas`);
  }

  // Maximum-size upgrades that really execute: a 131,072-byte V2 whose migration fails (rolled back, settled
  // failed), then a 131,072-byte V2 that applies. The callback's actual gas is recorded against its budget.
  {
    const vmax = readFileSync('build/token-v2-max.wasm'), vbadmax = readFileSync('build/token-v2-failing-max.wasm');
    const t3 = await parent.createSubAccount('token3', { initialBalance: 10n * NEAR });
    await t3.deploy(v1); await t3.call(t3, 'new', { owner_id: owner.accountId });
    await owner.call(t3, 'mint', { receiver_id: alice.accountId, amount: '42' });
    const cfg3 = encodeConfig({ target: t3.accountId, delaySeconds: 60n, windowSeconds: 3600n, signerKeys: signers.map((k) => k.publicKey) });
    await parent.batch(`gmax.${parent.accountId}`).createAccount().transfer(5n * NEAR).deployContract(gWasm).functionCall('init', new Uint8Array(cfg3), { gas: 50n * TGAS }).transact();
    const g3 = `gmax.${parent.accountId}`;
    await owner.call(t3, 'handover', { guardian_id: g3 });
    const view3 = () => root.getAccount(g3).view('state');
    const code3 = async () => sha256(Buffer.from((await provider.query({ request_type: 'view_code', account_id: t3.accountId, finality: 'optimistic' })).code_base64, 'base64'));
    const callbackGas = (r) => Number(BigInt(r.result.receipts_outcome.find((o) => o.outcome.logs.some((l) => /^(applied|failed), nonce/.test(l)))?.outcome.gas_burnt ?? 0)) / 1e12;
    const run = async (nonce, code) => {
      const m = encodeOperation({ chain: 'sandbox', guardian: g3, target: t3.accountId, configHash: sha256(cfg3), deadlineNs: await deadline(), nonce, action: 'upgrade', code, from: 1, to: 2 });
      const q = await relayer.callRaw(g3, 'propose', envelope(m, both(m), code), { gas: 300n * TGAS });
      await advance(61);
      const ex = await relayer.callRaw(g3, 'execute', new Uint8Array(0), { gas: 300n * TGAS });
      return { q, ex };
    };
    const bad = await run(0n, vbadmax);
    const sb = await view3();
    record('131,072-byte upgrade with a failing migration: settled failed, V1 code and state kept', bad.q.succeeded && sb.last?.status === 'failed' && hex(await code3()) === hex(sha256(v1)) && (await t3.view('state')).version === 1 && (await t3.view('ft_balance_of', { account_id: alice.accountId })) === '42', `propose ${gasOf(bad.q)} Tgas, execute ${gasOf(bad.ex)} Tgas, callback ${callbackGas(bad.ex)} of 10 Tgas`);
    const good = await run(1n, vmax);
    const sg = await view3(), ts = await t3.view('state');
    record('131,072-byte upgrade applies and settles', good.ex.succeeded && sg.last?.status === 'applied' && hex(await code3()) === hex(sha256(vmax)) && ts.version === 2 && ts.next_op === '2' && (await t3.view('ft_balance_of', { account_id: alice.accountId })) === '42', `execute ${gasOf(good.ex)} Tgas, callback ${callbackGas(good.ex)} of 10 Tgas`);
  }

  // A settlement callback that fails: the target's effect stays applied, the Guardian stays unresolved for good.
  {
    const t2 = await parent.createSubAccount('token2', { initialBalance: 10n * NEAR });
    await t2.deploy(v1);
    await t2.call(t2, 'new', { owner_id: owner.accountId });
    await owner.call(t2, 'mint', { receiver_id: alice.accountId, amount: '1' });
    const cfg2 = encodeConfig({ target: t2.accountId, delaySeconds: 60n, windowSeconds: 3600n, signerKeys: signers.map((k) => k.publicKey) });
    await parent.batch(`gbroken.${parent.accountId}`).createAccount().transfer(5n * NEAR).deployContract(readFileSync('build/guardian-sandbox-failing-callback.wasm')).functionCall('init', new Uint8Array(cfg2), { gas: 50n * TGAS }).transact();
    const g2 = `gbroken.${parent.accountId}`;
    await owner.call(t2, 'handover', { guardian_id: g2 });
    const m = encodeOperation({ chain: 'sandbox', guardian: g2, target: t2.accountId, configHash: sha256(cfg2), deadlineNs: await deadline(), nonce: 0n, action: 'mint', receiver: alice.accountId, amount: 5n });
    await relayer.callRaw(g2, 'propose', envelope(m, both(m)), { gas: 300n * TGAS });
    await advance(61);
    const ex = await relayer.callRaw(g2, 'execute', new Uint8Array(0), { gas: 300n * TGAS });
    const st = await root.getAccount(g2).view('state');
    record('failed callback: mint stays applied, operation stays executing', failureText(ex).includes('callback refused') && (await t2.view('ft_balance_of', { account_id: alice.accountId })) === '6' && st.active?.status === 'executing' && st.last === null);
    await refused('unresolved operation is not dispatched again', () => relayer.callRaw(g2, 'execute', new Uint8Array(0), { gas: 300n * TGAS }), 'no queued operation');
    await refused('unresolved operation cannot be expired', () => relayer.callRaw(g2, 'expire', new Uint8Array(0), { gas: 30n * TGAS }), 'no queued operation');
    const m1 = encodeOperation({ chain: 'sandbox', guardian: g2, target: t2.accountId, configHash: sha256(cfg2), deadlineNs: await deadline(), nonce: 1n, action: 'mint', receiver: alice.accountId, amount: 5n });
    await refused('no new operation while one is unresolved', () => relayer.callRaw(g2, 'propose', envelope(m1, both(m1)), { gas: 300n * TGAS }), 'another operation is active');
  }

  writeFileSync('evidence/guardian-sandbox.json', JSON.stringify({ suite: 'guardian.sandbox', guardian_sha256: hex(sha256(gWasm)), token_v1_sha256: hex(sha256(v1)), token_v2_sha256: hex(sha256(v2)), results }, null, 2) + '\n');
} finally {
  await worker.tearDown();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
