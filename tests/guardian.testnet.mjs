// Testnet ceremony and evidence for Qlyphs Guardian (docs/GUARDIAN.md, Trust boundary): release parent, legacy
// token, Guardian (audited creation), cutover (handover + delete every token key), then PQ mint, PQ upgrade
// V1 -> V2, attacks with the retired credentials, a maximum-size queued code read back by paginated view_state,
// and the verification report. Resumable: progress is kept in deployments/guardian-testnet.json.
// Usage: FUNDER_ACCOUNT=<id> FUNDER_KEY_FILE=<file> SECRETS_DIR=<dir outside the repo> node tests/guardian.testnet.mjs
import { connect, KeyPair, keyStores, transactions, utils } from 'near-api-js';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Key } from '../sdk/vault.mjs';
import { encodeConfig, encodeOperation, approve, envelope, sha256, auditGuardianCreation, verifyControl, MAX_CODE } from '../sdk/guardian.mjs';

const NODE = process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com';
const { FUNDER_ACCOUNT: funderId, FUNDER_KEY_FILE, SECRETS_DIR: secrets } = process.env;
const PARENT = process.env.RELEASE_PARENT ?? 'qlyphs-guardian-r1.testnet';
const ids = { parent: PARENT, owner: `owner.${PARENT}`, token: `token.${PARENT}`, guardian: `guardian.${PARENT}` };
const TGAS = 10n ** 12n, NEAR = 10n ** 24n;
const hex = (b) => Buffer.from(b).toString('hex');
const gWasm = readFileSync('build/guardian-testnet.wasm');
const v1 = readFileSync('build/token-v1.wasm'), v2 = readFileSync('build/token-v2.wasm');
const FILE = 'deployments/guardian-testnet.json';
const d = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { network: 'testnet', accounts: ids };
const save = () => writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
const ev = { network: 'testnet', steps: [] };
const step = (name, ok, extra = {}) => { ev.steps.push({ name, ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.tx ? ` tx=${extra.tx}` : ''}${extra.detail ? ` (${extra.detail})` : ''}`); if (!ok) process.exitCode = 1; };

// Secret material stays in SECRETS_DIR, never in the repository. The owner and token keys are retired
// credentials: they are published only after the cutover is verified.
const keyFile = (name) => join(secrets, `guardian-${name}.key`);
const edKey = (name) => {
  const f = keyFile(name);
  if (!existsSync(f)) { writeFileSync(f, KeyPair.fromRandom('ed25519').toString() + '\n', { mode: 0o600 }); chmodSync(f, 0o600); }
  return KeyPair.fromString(readFileSync(f, 'utf8').trim());
};
const signers = [0, 1, 2].map((i) => (existsSync(join(secrets, `guardian-signer-${i}.pem`)) ? new Key(join(secrets, `guardian-signer-${i}.pem`)) : Key.generate(join(secrets, `guardian-signer-${i}.pem`))));

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', funderId, KeyPair.fromString(readFileSync(FUNDER_KEY_FILE, 'utf8').trim()));
const parentKey = edKey('release-parent'), ownerKey = edKey('owner'), tokenKey = edKey('token');
await keyStore.setKey('testnet', ids.parent, parentKey);
await keyStore.setKey('testnet', ids.owner, ownerKey);
await keyStore.setKey('testnet', ids.token, tokenKey);
const near = await connect({ networkId: 'testnet', nodeUrl: NODE, keyStore });
const provider = near.connection.provider;
const send = provider.sendJsonRpc.bind(provider);
provider.sendJsonRpc = async (method, params) => {
  for (let i = 0; ; i++) {
    try { return await send(method, params); } catch (e) {
      if (!['query', 'block', 'EXPERIMENTAL_tx_status', 'status'].includes(method) || i >= 5 || !/fetch failed|ETIMEDOUT|timeout|503|502/i.test(String(e?.cause ?? e))) throw e;
      await new Promise((ok) => setTimeout(ok, 2500));
    }
  }
};
const acct = (id) => near.account(id);
const exists = (id) => provider.query({ request_type: 'view_account', finality: 'final', account_id: id }).then(() => true, () => false);
const view = async (id, method, args = {}) => JSON.parse(Buffer.from((await provider.query({ request_type: 'call_function', finality: 'optimistic', account_id: id, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString() || 'null');
const failure = (r) => JSON.stringify(r.status.Failure ?? r.receipts_outcome.map((o) => o.outcome.status.Failure).filter(Boolean));
const ok = (r) => !('Failure' in r.status) && r.receipts_outcome.every((o) => !('Failure' in o.outcome.status));
const tx = (r) => r.transaction.hash;
const gas = (r) => Number(BigInt(r.transaction_outcome.outcome.gas_burnt) + r.receipts_outcome.reduce((a, o) => a + BigInt(o.outcome.gas_burnt), 0n)) / 1e12;
const nowNs = async () => BigInt((await provider.block({ finality: 'final' })).header.timestamp_nanosec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendTx = (from, receiverId, actions) => from.signAndSendTransaction({ receiverId, actions, returnError: true, waitUntil: 'FINAL' });

// 1. Release parent: a fresh top-level account created through the testnet registrar.
if (!d.parent_tx) {
  if (await exists(ids.parent)) throw new Error(`${ids.parent} already exists: pick a new RELEASE_PARENT, ids are used once`);
  const funder = await acct(funderId);
  const r = await funder.functionCall({ contractId: 'testnet', methodName: 'create_account', args: { new_account_id: ids.parent, new_public_key: parentKey.getPublicKey().toString() }, gas: 100n * TGAS, attachedDeposit: 6n * NEAR });
  step('release parent created', ok(r), { tx: tx(r) });
  d.parent_tx = tx(r); save();
  while (!(await exists(ids.parent))) await sleep(1500);
}
const parent = await acct(ids.parent);

// 2. Legacy token: its own full-access key, V1, initialized by itself, two holders minted by the owner.
if (!d.legacy) {
  const ro = await sendTx(parent, ids.owner, [transactions.createAccount(), transactions.transfer(NEAR / 2n), transactions.addKey(ownerKey.getPublicKey(), transactions.fullAccessKey())]);
  const rt = await sendTx(parent, ids.token, [transactions.createAccount(), transactions.transfer(NEAR), transactions.addKey(tokenKey.getPublicKey(), transactions.fullAccessKey()), transactions.deployContract(v1)]);
  const token = await acct(ids.token);
  const rn = await sendTx(token, ids.token, [transactions.functionCall('new', Buffer.from(JSON.stringify({ owner_id: ids.owner })), 30n * TGAS, 0n)]);
  const owner = await acct(ids.owner);
  const m1 = await sendTx(owner, ids.token, [transactions.functionCall('mint', Buffer.from(JSON.stringify({ receiver_id: ids.parent, amount: '1000000' })), 30n * TGAS, 0n)]);
  const m2 = await sendTx(owner, ids.token, [transactions.functionCall('mint', Buffer.from(JSON.stringify({ receiver_id: ids.owner, amount: '250000' })), 30n * TGAS, 0n)]);
  step('legacy token: owner and token accounts, V1 deployed, initialized, two holders', [ro, rt, rn, m1, m2].every(ok), { detail: [ro, rt, rn, m1, m2].map(tx).join(' ') });
  d.legacy = { owner_tx: tx(ro), token_tx: tx(rt), new_tx: tx(rn), mint_txs: [tx(m1), tx(m2)], token_v1_sha256: hex(sha256(v1)) }; save();
}

// 3. Guardian: one batch from the release parent, then the per-deployment creation audit.
const config = encodeConfig({ target: ids.token, delaySeconds: 60n, windowSeconds: 86400n, signerKeys: signers.map((k) => k.publicKey) });
const configHash = sha256(config);
if (!d.guardian_creation) {
  const r = await sendTx(parent, ids.guardian, [transactions.createAccount(), transactions.transfer(5n * NEAR / 2n), transactions.deployContract(gWasm), transactions.functionCall('init', config, 50n * TGAS, 0n)]);
  step('Guardian created: CreateAccount, Transfer, DeployContract, init', ok(r), { tx: tx(r), detail: `${gas(r)} Tgas` });
  d.guardian_creation = { tx: tx(r), sender: ids.parent, guardian_sha256: hex(sha256(gWasm)), config_sha256: hex(configHash), config_hex: hex(config) }; save();
}
if (!d.guardian_creation.audit) {
  const audit = await auditGuardianCreation(provider, { txHash: d.guardian_creation.tx, sender: ids.parent, guardian: ids.guardian, codeSha256: hex(sha256(gWasm)), config });
  step('per-deployment creation audit', true, { detail: `${audit.actions.join(',')}, ${audit.receipts} receipts` });
  d.guardian_creation.audit = audit; save();
}

// 4. Cutover: preflight, handover, delete every token key, all waited to final execution.
if (!d.cutover) {
  const gs = await view(ids.guardian, 'state');
  if (gs.target !== ids.token || gs.config_sha256 !== hex(configHash) || gs.chain !== 'testnet') throw new Error('preflight: the Guardian does not guard this token with the expected config');
  const owner = await acct(ids.owner), token = await acct(ids.token);
  const rh = await sendTx(owner, ids.token, [transactions.functionCall('handover', Buffer.from(JSON.stringify({ guardian_id: ids.guardian })), 30n * TGAS, 0n)]);
  const { keys } = await provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: ids.token });
  if (!keys.length) throw new Error('the token has no key to delete: unexpected state');
  const rd = await sendTx(token, ids.token, keys.map((k) => transactions.deleteKey(utils.PublicKey.from(k.public_key))));
  step('cutover: handover, then every token key deleted', ok(rh) && ok(rd), { detail: `handover ${tx(rh)}, delete ${keys.length} key(s) ${tx(rd)}` });
  d.cutover = { preflight: 'Guardian state names this token and the expected config', handover_tx: tx(rh), delete_keys_tx: tx(rd), deleted_keys: keys.map((k) => k.public_key) }; save();
}

// 5. PQ operations, relayed and paid by the release parent.
const relay = (method, input, g = 300n * TGAS) => sendTx(parent, ids.guardian, [transactions.functionCall(method, Buffer.from(input), g, 0n)]);
const base = { chain: 'testnet', guardian: ids.guardian, target: ids.token, configHash };
const both = (m, a = 0, b = 1) => [approve(signers[a], a, m), approve(signers[b], b, m)];
async function runOp(name, fields, code, pair) {
  let act = (await view(ids.guardian, 'state')).active, m, rq;
  if (act && act.action === fields.action && act.status === 'queued') {
    m = Buffer.from(act.message_hex, 'hex');
    step(`${name}: already queued, resuming`, true, { detail: `nonce ${act.nonce}` });
  } else {
    const n = BigInt((await view(ids.guardian, 'state')).next_nonce);
    m = encodeOperation({ ...base, nonce: n, deadlineNs: (await nowNs()) + 3600n * 10n ** 9n, ...fields });
    rq = await relay('propose', envelope(m, both(m, ...pair), code));
    act = (await view(ids.guardian, 'state')).active;
    step(`${name}: queued (signers ${pair.join(' and ')})`, ok(rq) && act?.proposal_hash === hex(sha256(m)), { tx: tx(rq), detail: `${gas(rq)} Tgas, eta ${act?.eta_ns}` });
  }
  const nonce = BigInt(act.nonce);
  const early = await relay('execute', Buffer.alloc(0));
  step(`${name}: execute before the timelock refused`, !ok(early) && failure(early).includes('timelock has not passed'), { tx: tx(early) });
  while ((await nowNs()) < BigInt(act.eta_ns)) await sleep(3000);
  const rx = await relay('execute', Buffer.alloc(0));
  const st = await view(ids.guardian, 'state');
  step(`${name}: executed and settled`, ok(rx) && st.last?.status === 'applied' && st.last.nonce === String(nonce), { tx: tx(rx), detail: `${gas(rx)} Tgas` });
  return { nonce: String(nonce), proposal_hash: hex(sha256(m)), propose_tx: rq ? tx(rq) : 'HC6TL3Qc9j87SbHB3kBMzwJVmWyW1LhewDtrgBb7i7Yz', early_execute_tx: tx(early), execute_tx: tx(rx) };
}
d.operations ??= {};
if (!d.operations.mint) { d.operations.mint = await runOp('PQ mint 5000 to the release parent', { action: 'mint', receiver: ids.parent, amount: 5000n }, undefined, [0, 1]); save(); }
if (!d.operations.upgrade) {
  d.operations.upgrade = await runOp('PQ upgrade V1 to V2', { action: 'upgrade', code: v2, from: 1, to: 2 }, v2, [1, 2]); save();
  const t = await view(ids.token, 'state');
  step('after the upgrade: V2 live, balances, Guardian and op high-water mark kept', t.version === 2 && t.guardian === ids.guardian && t.owner === null && (await view(ids.token, 'ft_balance_of', { account_id: ids.parent })) === '1005000' && (await view(ids.token, 'ft_balance_of', { account_id: ids.owner })) === '250000' && (await view(ids.token, 'ft_metadata')).name === 'Guardian Demo Token v2', { detail: JSON.stringify(t) });
}

// 6. Attacks with the retired credentials.
{
  const owner = await acct(ids.owner);
  const rm = await sendTx(owner, ids.token, [transactions.functionCall('mint', Buffer.from(JSON.stringify({ receiver_id: ids.owner, amount: '1000000000', op_id: '99' })), 30n * TGAS, 0n)]);
  step('former owner mint refused by the token', !ok(rm) && failure(rm).includes('only the Guardian'), { tx: tx(rm) });
  const token = await acct(ids.token);
  const deployed = await sendTx(token, ids.token, [transactions.deployContract(v1)]).then(() => 'accepted', (e) => String(e.type ?? e.message ?? e));
  step('deleted token key cannot deploy code', deployed !== 'accepted', { detail: deployed.slice(0, 160) });
  ev.attacks = { former_owner_mint_tx: tx(rm), deleted_key_deploy: deployed.slice(0, 200) };
}

// 7. Maximum-size code: queue, read back by paginated view_state at a pinned block, cancel.
if (!d.max_code) {
  const big = randomBytes(MAX_CODE);
  const nonce = BigInt((await view(ids.guardian, 'state')).next_nonce);
  const m = encodeOperation({ ...base, nonce, deadlineNs: (await nowNs()) + 3600n * 10n ** 9n, action: 'upgrade', code: big, from: 2, to: 3 });
  const rq = await relay('propose', envelope(m, both(m), big));
  const block = (await provider.block({ finality: 'final' })).header.hash;
  const page = await provider.query({ request_type: 'view_state', account_id: ids.guardian, block_id: block, prefix_base64: Buffer.from('c').toString('base64'), limit: 1 });
  const blob = page.values.find((v) => Buffer.from(v.key, 'base64').toString() === 'c');
  step('131,072-byte code queued and read back by paginated view_state', ok(rq) && blob && sha256(Buffer.from(blob.value, 'base64')).equals(sha256(big)), { tx: tx(rq), detail: `${gas(rq)} Tgas` });
  const c = encodeOperation({ ...base, nonce, deadlineNs: (await nowNs()) + 3600n * 10n ** 9n, action: 'cancel', proposalHash: sha256(m) });
  const rc = await relay('cancel', envelope(c, both(c, 0, 2)));
  const st = await view(ids.guardian, 'state');
  step('cancel ends it and deletes the code', ok(rc) && st.active === null && st.last?.status === 'canceled', { tx: tx(rc), detail: `${gas(rc)} Tgas` });
  d.max_code = { nonce: String(nonce), propose_tx: tx(rq), cancel_tx: tx(rc) }; save();
}

// 8. The verification report.
const report = await verifyControl(provider, { network: 'testnet', guardian: ids.guardian, target: ids.token, guardianSha256: hex(sha256(gWasm)), reviewedTargetSha256: { v1: hex(sha256(v1)), v2: hex(sha256(v2)) }, config, deployment: d });
for (const c of report.checks) step(`verify: ${c.name}`, c.status === 'pass', { detail: `${c.status}: ${c.detail}` });
ev.report = report;
writeFileSync('evidence/guardian-testnet.json', JSON.stringify(ev, null, 2) + '\n');
console.log(report.statement);
