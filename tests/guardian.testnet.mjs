// Testnet ceremony and evidence for Qlyphs Guardian (docs/GUARDIAN.md, Trust boundary). Every required step
// must succeed or the script stops; progress is journaled in deployments/guardian-<release>.json and a resumed
// run continues only from state it can recognise on chain. Steps: release parent, legacy token V1, Guardian
// (creation audited), cutover (handover, then every token key deleted), PQ mint, PQ upgrade V1 -> V2, the
// retired-credential attacks, then maximum-size upgrades on a second token and Guardian (a failing migration,
// then a successful one), and the verification report at a block after all of it.
// Usage: FUNDER_ACCOUNT=<id> FUNDER_KEY_FILE=<file> SECRETS_DIR=<dir outside the repo> RELEASE_PARENT=<new>.testnet \
//        [FUND_NEAR=8] node tests/guardian.testnet.mjs
import { connect, KeyPair, keyStores, transactions, utils } from 'near-api-js';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Key } from '../sdk/vault.mjs';
import { encodeConfig, encodeOperation, approve, envelope, sha256, auditGuardianCreation, verifyControl } from '../sdk/guardian.mjs';
import { Rpc, edKey as rawKey, deployContract } from '../demo/src/near.js';

const NODE = process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com';
const { FUNDER_ACCOUNT: funderId, FUNDER_KEY_FILE, SECRETS_DIR: secrets, RELEASE_PARENT: PARENT } = process.env;
if (!PARENT || !secrets) throw new Error('set RELEASE_PARENT and SECRETS_DIR');
const release = PARENT.replace(/\.testnet$/, '');
const ids = { parent: PARENT, owner: `owner.${PARENT}`, token: `token.${PARENT}`, guardian: `guardian.${PARENT}`, relayer: `relayer.${PARENT}`,
  token2: `token-max.${PARENT}`, guardian2: `guardian-max.${PARENT}` };
const TGAS = 10n ** 12n, NEAR = 10n ** 24n;
const hex = (b) => Buffer.from(b).toString('hex');
const art = (f) => readFileSync(`build/${f}`);
const gWasm = art('guardian-testnet.wasm'), v1 = art('token-v1.wasm'), v2 = art('token-v2.wasm'), vmax = art('token-v2-max.wasm'), vbadmax = art('token-v2-failing-max.wasm');
const FILE = `deployments/guardian-${release}.json`;

class Stop extends Error {}
const must = (cond, msg) => { if (!cond) throw new Stop(msg); };
const ev = { network: 'testnet', release: PARENT, steps: [] };
const step = (name, extra = {}) => { ev.steps.push({ name, ok: true, ...extra }); console.log(`PASS ${name}${extra.tx ? ` tx=${extra.tx}` : ''}${extra.detail ? ` (${extra.detail})` : ''}`); };

// Secrets stay in SECRETS_DIR. The owner and token keys are retired credentials, published after the cutover.
const keyFile = (name) => join(secrets, `${release}-${name}.key`);
const edKey = (name) => {
  const f = keyFile(name);
  if (!existsSync(f)) { writeFileSync(f, KeyPair.fromRandom('ed25519').toString() + '\n', { mode: 0o600 }); chmodSync(f, 0o600); }
  return KeyPair.fromString(readFileSync(f, 'utf8').trim());
};
const signers = [0, 1, 2].map((i) => { const f = join(secrets, `${release}-signer-${i}.pem`); return existsSync(f) ? new Key(f) : Key.generate(f); });
const config = encodeConfig({ target: ids.token, delaySeconds: 60n, windowSeconds: 86400n, signerKeys: signers.map((k) => k.publicKey) });
const config2 = encodeConfig({ target: ids.token2, delaySeconds: 60n, windowSeconds: 86400n, signerKeys: signers.map((k) => k.publicKey) });

// The journal must describe this exact release before any of its completion records are trusted.
const fingerprint = { network: 'testnet', accounts: ids, guardian_sha256: hex(sha256(gWasm)), config_sha256: hex(sha256(config)), config2_sha256: hex(sha256(config2)),
  reviewed_target_sha256: { v1: hex(sha256(v1)), v2: hex(sha256(v2)) }, max_target_sha256: { v2_max: hex(sha256(vmax)), v2_failing_max: hex(sha256(vbadmax)) } };
const d = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { ...fingerprint };
for (const k of Object.keys(fingerprint)) must(JSON.stringify(d[k]) === JSON.stringify(fingerprint[k]), `${FILE}: ${k} does not match this build and release; start a new RELEASE_PARENT`);
d.guardian_creation ??= {};
d.guardian_creation.config_hex = hex(config);
d.guardian_creation.guardian_sha256 = hex(sha256(gWasm));
const save = () => writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');

const keyStore = new keyStores.InMemoryKeyStore();
if (funderId) await keyStore.setKey('testnet', funderId, KeyPair.fromString(readFileSync(FUNDER_KEY_FILE, 'utf8').trim()));
const K = { parent: edKey('release-parent'), owner: edKey('owner'), token: edKey('token'), relayer: edKey('demo-relayer'), token2: edKey('token-max') };
for (const [who, k] of Object.entries(K)) await keyStore.setKey('testnet', ids[who], k);
const near = await connect({ networkId: 'testnet', nodeUrl: NODE, keyStore });
const provider = near.connection.provider;
const send0 = provider.sendJsonRpc.bind(provider);
provider.sendJsonRpc = async (method, params) => {
  for (let i = 0; ; i++) {
    try { return await send0(method, params); } catch (e) {
      if (!['query', 'block', 'EXPERIMENTAL_tx_status', 'status'].includes(method) || i >= 5 || !/fetch failed|ETIMEDOUT|timeout|503|502/i.test(String(e?.cause ?? e))) throw e;
      await new Promise((ok) => setTimeout(ok, 2500));
    }
  }
};
const acct = (id) => near.account(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (id) => provider.query({ request_type: 'view_account', finality: 'optimistic', account_id: id }).then(() => true, () => false);
const view = async (id, method, args = {}) => JSON.parse(Buffer.from((await provider.query({ request_type: 'call_function', finality: 'optimistic', account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString() || 'null');
const keysOf = async (id) => (await provider.query({ request_type: 'view_access_key_list', finality: 'optimistic', account_id: id })).keys;
const failure = (r) => JSON.stringify(r.status.Failure ?? r.receipts_outcome.map((o) => o.outcome.status.Failure).filter(Boolean));
const okTx = (r) => r && !('Failure' in r.status) && r.receipts_outcome.every((o) => !('Failure' in o.outcome.status));
const gas = (r) => Number(BigInt(r.transaction_outcome.outcome.gas_burnt) + r.receipts_outcome.reduce((a, o) => a + BigInt(o.outcome.gas_burnt), 0n)) / 1e12;
const nowNs = async () => BigInt((await provider.block({ finality: 'optimistic' })).header.timestamp_nanosec);
// Sends one transaction and waits for its complete final execution.
const sendTx = async (from, receiverId, actions) => {
  const r = await (await acct(from)).signAndSendTransaction({ receiverId, actions, returnError: true });
  return provider.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: r.transaction.hash, sender_account_id: from, wait_until: 'FINAL' });
};
const required = async (name, from, receiverId, actions) => { const r = await sendTx(from, receiverId, actions); must(okTx(r), `${name} failed: ${failure(r)}`); return r; };
const fc = (method, args, g = 30n * TGAS, dep = 0n) => transactions.functionCall(method, Buffer.isBuffer(args) || args instanceof Uint8Array ? Buffer.from(args) : Buffer.from(JSON.stringify(args)), g, dep);

// 1. Release parent through the testnet registrar, plus the demo relayer.
if (!d.parent_tx) {
  must(!(await exists(ids.parent)), `${ids.parent} already exists: ids are used once`);
  const funder = await acct(funderId);
  const r = await funder.functionCall({ contractId: 'testnet', methodName: 'create_account', args: { new_account_id: ids.parent, new_public_key: K.parent.getPublicKey().toString() }, gas: 100n * TGAS, attachedDeposit: BigInt(process.env.FUND_NEAR ?? 8) * NEAR });
  must(okTx(r), 'release parent creation failed');
  d.parent_tx = r.transaction.hash; save();
  while (!(await exists(ids.parent))) await sleep(1500);
  step('release parent created', { tx: d.parent_tx });
}
if (!d.relayer_tx) {
  const r = await required('demo relayer', ids.parent, ids.relayer, [transactions.createAccount(), transactions.transfer(NEAR), transactions.addKey(K.relayer.getPublicKey(), transactions.fullAccessKey())]);
  d.relayer_tx = r.transaction.hash; save(); step('demo relayer created', { tx: d.relayer_tx });
}

// 2. Legacy token: its own key, V1, initialized by itself, two holders minted by the owner.
if (!d.legacy) {
  const ro = await required('owner account', ids.parent, ids.owner, [transactions.createAccount(), transactions.transfer(NEAR / 4n), transactions.addKey(K.owner.getPublicKey(), transactions.fullAccessKey())]);
  const rt = await required('token account', ids.parent, ids.token, [transactions.createAccount(), transactions.transfer(NEAR / 2n), transactions.addKey(K.token.getPublicKey(), transactions.fullAccessKey()), transactions.deployContract(v1)]);
  const rn = await required('token new', ids.token, ids.token, [fc('new', { owner_id: ids.owner })]);
  const m1 = await required('owner mint 1', ids.owner, ids.token, [fc('mint', { receiver_id: ids.parent, amount: '1000000' })]);
  const m2 = await required('owner mint 2', ids.owner, ids.token, [fc('mint', { receiver_id: ids.owner, amount: '250000' })]);
  d.legacy = { owner_tx: ro.transaction.hash, token_tx: rt.transaction.hash, new_tx: rn.transaction.hash, mint_txs: [m1.transaction.hash, m2.transaction.hash] }; save();
  step('legacy token: V1 with its own key, initialized, two holders', { detail: Object.values(d.legacy).flat().join(' ') });
}

// 3. Guardian: one batch, then the per-deployment audit (complete final execution).
async function createGuardian(gid, cfg, fund, rec) {
  if (!rec.tx) {
    const r = await required('Guardian creation', ids.parent, gid, [transactions.createAccount(), transactions.transfer(fund), transactions.deployContract(gWasm), fc('init', cfg, 50n * TGAS)]);
    rec.tx = r.transaction.hash; rec.sender = ids.parent; save();
  }
  rec.audit = await auditGuardianCreation(provider, { txHash: rec.tx, sender: ids.parent, guardian: gid, codeSha256: hex(sha256(gWasm)), config: cfg }); save();
  step(`${gid} created and audited`, { tx: rec.tx, detail: `${rec.audit.actions.join(',')}, ${rec.audit.receipts} receipts, final` });
}
await createGuardian(ids.guardian, config, NEAR * 6n / 10n, d.guardian_creation);

// 4. Cutover, in order, each step confirmed on chain before the next.
async function cutover(target, gid, cfg, rec, ownerId, tokenKeyName) {
  if (!rec.handover_tx) {
    const gs = await view(gid, 'state');
    must(gs.target === target && gs.config_sha256 === hex(sha256(cfg)) && gs.chain === 'testnet', 'preflight: the Guardian does not guard this target with the expected config');
    const r = await required('handover', ownerId, target, [fc('handover', { guardian_id: gid })]);
    rec.handover_tx = r.transaction.hash; save();
  }
  const ts = await view(target, 'state');
  must(ts.guardian === gid && ts.owner === null, 'target is not guarded by the expected Guardian after handover');
  if (!rec.delete_keys_tx) {
    const keys = await keysOf(target);
    must(keys.length === 1 && keys[0].public_key === K[tokenKeyName].getPublicKey().toString(), `unexpected keys on ${target}: ${keys.map((k) => k.public_key)}`);
    const r = await required('delete target keys', target, target, keys.map((k) => transactions.deleteKey(utils.PublicKey.from(k.public_key))));
    rec.delete_keys_tx = r.transaction.hash; rec.deleted_keys = keys.map((k) => k.public_key); save();
  }
  must((await keysOf(target)).length === 0, `${target} still has keys`);
  step(`cutover of ${target}: handover, then every key deleted`, { detail: `handover ${rec.handover_tx}, delete ${rec.delete_keys_tx}` });
}
d.cutover ??= {};
await cutover(ids.token, ids.guardian, config, d.cutover, ids.owner, 'token');

// 5. PQ operations, journaled: the exact message and the real propose transaction are saved before execution.
async function runOp(key, gid, cfg, target, fields, code, pair, expect = { settled: 'applied' }) {
  d.operations ??= {};
  let j = d.operations[key];
  const gs = await view(gid, 'state');
  if (j?.execute_tx) return j;
  if (!j) {
    must(gs.active === null, `${gid} has an unexpected active operation`);
    const m = encodeOperation({ chain: 'testnet', guardian: gid, target, configHash: sha256(cfg), nonce: BigInt(gs.next_nonce), deadlineNs: (await nowNs()) + 3600n * 10n ** 9n, ...fields });
    const r = await required(`${key} propose`, ids.relayer, gid, [fc('propose', envelope(m, [approve(signers[pair[0]], pair[0], m), approve(signers[pair[1]], pair[1], m)], code), 300n * TGAS)]);
    j = d.operations[key] = { nonce: gs.next_nonce, message_hex: hex(m), proposal_hash: hex(sha256(m)), propose_tx: r.transaction.hash, propose_tgas: gas(r), signers: pair }; save();
    const act = (await view(gid, 'state')).active;
    must(act?.proposal_hash === j.proposal_hash, `${key}: queued operation is not the one proposed`);
    if ((await nowNs()) < BigInt(act.eta_ns)) {
      const early = await sendTx(ids.relayer, gid, [fc('execute', Buffer.alloc(0), 300n * TGAS)]);
      must(!okTx(early) && failure(early).includes('timelock has not passed'), `${key}: early execute was not refused by the timelock`);
      j.early_execute_tx = early.transaction.hash; save();
    }
    step(`${key}: queued (signers ${pair.join(' and ')})`, { tx: j.propose_tx, detail: `${j.propose_tgas} Tgas${j.early_execute_tx ? `, early execute refused ${j.early_execute_tx}` : ''}` });
  } else {
    must(gs.active?.proposal_hash === j.proposal_hash, `${key}: the active operation is not the journaled one`);
    step(`${key}: resuming the journaled operation`, { detail: `nonce ${j.nonce}` });
  }
  const act = (await view(gid, 'state')).active;
  while ((await nowNs()) < BigInt(act.eta_ns)) await sleep(3000);
  const sent = await (await acct(ids.relayer)).signAndSendTransaction({ receiverId: gid, actions: [fc('execute', Buffer.alloc(0), 300n * TGAS)], returnError: true });
  j.execute_tx = sent.transaction.hash; save();
  const r = await provider.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: j.execute_tx, sender_account_id: ids.relayer, wait_until: 'FINAL' });
  const cb = r.receipts_outcome.find((o) => o.outcome.logs.some((l) => /^(applied|failed), nonce/.test(l)));
  const last = (await view(gid, 'state')).last;
  must(last?.proposal_hash === j.proposal_hash, `${key}: settlement is for another operation`);
  must(last.status === expect.settled, `${key}: settled ${last.status}, expected ${expect.settled}: ${failure(r)}`);
  if (expect.settled === 'applied') must(okTx(r), `${key} execute failed: ${failure(r)}`);
  else must(failure(r).includes(expect.reason), `${key}: the target failed for another reason: ${failure(r)}`);
  Object.assign(j, { execute_tgas: gas(r), callback_tgas: cb ? Number(BigInt(cb.outcome.gas_burnt)) / 1e12 : null, settled: last.status }); save();
  step(`${key}: executed, settled ${last.status}`, { tx: j.execute_tx, detail: `${j.execute_tgas} Tgas, callback ${j.callback_tgas} Tgas` });
  return j;
}
const mint = await runOp('mint', ids.guardian, config, ids.token, { action: 'mint', receiver: ids.parent, amount: 5000n }, undefined, [0, 1]);
must(mint.settled === 'applied', 'PQ mint did not apply');
const up = await runOp('upgrade', ids.guardian, config, ids.token, { action: 'upgrade', code: v2, from: 1, to: 2 }, v2, [1, 2]);
must(up.settled === 'applied', 'PQ upgrade did not apply');
{
  const t = await view(ids.token, 'state');
  must(t.version === 2 && t.guardian === ids.guardian && t.owner === null && t.next_op === String(BigInt(up.nonce) + 1n), `token state after upgrade: ${JSON.stringify(t)}`);
  must((await view(ids.token, 'ft_balance_of', { account_id: ids.parent })) === '1005000' && (await view(ids.token, 'ft_balance_of', { account_id: ids.owner })) === '250000', 'balances changed across the upgrade');
  must((await view(ids.token, 'ft_metadata')).name === 'Guardian Demo Token v2', 'V2 metadata not live');
  step('after the upgrade: V2 live; balances, Guardian and op high-water mark kept', { detail: JSON.stringify(t) });
}

// 6. Retired credentials: the refusals must be the expected ones, not any error.
{
  const rm = await sendTx(ids.owner, ids.token, [fc('mint', { receiver_id: ids.owner, amount: '1000000000', op_id: '999999' })]);
  must(!okTx(rm) && failure(rm).includes('only the Guardian can do this'), `former owner mint: ${failure(rm)}`);
  // Signed and sent as raw bytes so that the network, not this client, refuses the deleted key.
  const sent = await new Rpc(NODE).send(ids.token, rawKey(K.token.toString()), ids.token, [deployContract(v1)]);
  const deleted = sent.failure ?? 'accepted';
  must(!sent.ok && /InvalidAccessKeyError/.test(deleted) && /AccessKeyNotFound/.test(deleted), `deleted key deploy: ${deleted.slice(0, 200)}`);
  ev.attacks = { former_owner_mint_tx: rm.transaction.hash, deleted_key_deploy: deleted.trim().slice(0, 200) };
  step('former owner mint refused: only the Guardian can do this', { tx: rm.transaction.hash });
  step('deleted token key refused by the network: InvalidAccessKeyError AccessKeyNotFound', { detail: deleted.slice(0, 160) });
}

// 7. Maximum-size upgrades on a second token and Guardian: a 131,072-byte V2 whose migration fails, then one that applies.
d.max ??= {};
if (!d.max.legacy) {
  const rt = await required('max token account', ids.parent, ids.token2, [transactions.createAccount(), transactions.transfer(NEAR * 17n / 10n), transactions.addKey(K.token2.getPublicKey(), transactions.fullAccessKey()), transactions.deployContract(v1)]);
  await required('max token new', ids.token2, ids.token2, [fc('new', { owner_id: ids.owner })]);
  await required('max token mint', ids.owner, ids.token2, [fc('mint', { receiver_id: ids.owner, amount: '42' })]);
  d.max.legacy = { token_tx: rt.transaction.hash }; save();
}
d.max.guardian_creation ??= {};
await createGuardian(ids.guardian2, config2, NEAR * 18n / 10n, d.max.guardian_creation);
d.max.cutover ??= {};
await cutover(ids.token2, ids.guardian2, config2, d.max.cutover, ids.owner, 'token2');
{
  const tcode = async () => hex(sha256(Buffer.from((await provider.query({ request_type: 'view_code', finality: 'optimistic', account_id: ids.token2 })).code_base64, 'base64')));
  const failing = await runOp('max_failing', ids.guardian2, config2, ids.token2, { action: 'upgrade', code: vbadmax, from: 1, to: 2 }, vbadmax, [0, 2], { settled: 'failed', reason: 'migration refused' });
  // Checked once, right after the failing execution; later steps change the code, so a resumed run trusts the journal.
  if (!d.max.failing_rollback_checked) {
    must(failing.settled === 'failed' && (await tcode()) === hex(sha256(v1)) && (await view(ids.token2, 'state')).version === 1, 'failing max upgrade did not roll back');
    d.max.failing_rollback_checked = true; save();
  }
  step('131,072-byte upgrade with a failing migration: settled failed, V1 code kept', { tx: failing.execute_tx });
  const good = await runOp('max_upgrade', ids.guardian2, config2, ids.token2, { action: 'upgrade', code: vmax, from: 1, to: 2 }, vmax, [0, 1]);
  must(good.settled === 'applied' && (await tcode()) === hex(sha256(vmax)) && (await view(ids.token2, 'ft_balance_of', { account_id: ids.owner })) === '42', 'max upgrade did not apply cleanly');
  step('131,072-byte upgrade applied and settled', { tx: good.execute_tx, detail: `callback ${good.callback_tgas} of 10 Tgas` });
}

// 8. The report, at a final block after every recorded transaction.
{
  const r = await provider.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: d.operations.max_upgrade.execute_tx, sender_account_id: ids.relayer, wait_until: 'FINAL' });
  const heights = await Promise.all(r.receipts_outcome.map(async (o) => (await provider.sendJsonRpc('block', { block_id: o.block_hash })).header.height));
  while ((await provider.block({ finality: 'final' })).header.height <= Math.max(...heights)) await sleep(2000);
}
const report = await verifyControl(provider, { network: 'testnet', guardian: ids.guardian, target: ids.token, guardianSha256: hex(sha256(gWasm)), reviewedTargetSha256: d.reviewed_target_sha256, config, deployment: d });
for (const c of report.checks) console.log(`${c.status === 'pass' ? 'PASS' : 'FAIL'} verify: ${c.name} (${c.detail})`);
must(report.ok, 'verification report is not ok');
ev.report = report;
writeFileSync(`evidence/guardian-${release}.json`, JSON.stringify(ev, null, 2) + '\n');
console.log(report.statement);
