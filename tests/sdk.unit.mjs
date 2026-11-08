// Unit checks of sdk/guardian.mjs against a controlled RPC: the report never passes on missing, malformed or
// mismatched evidence, the creation and cutover audits require complete final execution, and the client
// encoders refuse malformed input. Writes evidence/sdk-unit.json.
import { writeFileSync } from 'node:fs';
import { encodeConfig, encodeOperation, decodeOperation, envelope, verifyControl, auditGuardianCreation, sha256, PK_LEN, SIG_LEN } from '../sdk/guardian.mjs';

const results = [];
let failures = 0;
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const throws = (name, fn, reason) => { try { fn(); record(name, false, 'did not throw'); } catch (e) { record(name, String(e.message).includes(reason), e.message); } };
const rejects = async (name, p, reason) => { try { await p; record(name, false, 'did not throw'); } catch (e) { record(name, String(e.message).includes(reason), e.message); } };

const BLOCK = 'PinnedBlockHash1111111111111111111111111111';
const keys = [1, 2, 3].map((i) => Buffer.alloc(PK_LEN, i));
const config = encodeConfig({ target: 'token.release.testnet', delaySeconds: 60n, windowSeconds: 86400n, signerKeys: keys });
const guardianCode = Buffer.from('guardian code'), v1 = Buffer.from('token v1'), v2 = Buffer.from('token v2');
const hex = (b) => sha256(b).toString('hex');
const expected = { network: 'testnet', guardian: 'guardian.release.testnet', target: 'token.release.testnet', guardianSha256: hex(guardianCode), reviewedTargetSha256: { v1: hex(v1), v2: hex(v2) }, config,
  deployment: { network: 'testnet', accounts: { parent: 'release.testnet', owner: 'owner.release.testnet', token: 'token.release.testnet', guardian: 'guardian.release.testnet' },
    guardian_creation: { tx: 'CreateTx' }, cutover: { handover_tx: 'HandoverTx', delete_keys_tx: 'DeleteTx', deleted_keys: ['ed25519:OldKey'] } } };

const ok = { SuccessValue: '' };
const outcome = (id, block = 'B1', status = ok, receipt_ids = []) => ({ id, block_hash: block, outcome: { status, receipt_ids } });
function txs(over = {}) {
  const create = { final_execution_status: 'FINAL', status: ok, transaction: { hash: 'CreateTx', signer_id: 'release.testnet', receiver_id: 'guardian.release.testnet', actions: ['CreateAccount', { Transfer: { deposit: '1' } }, { DeployContract: { code: sha256(guardianCode).toString('base64') } }, { FunctionCall: { method_name: 'init', args: config.toString('base64'), deposit: '0' } }] },
    transaction_outcome: outcome('t1', 'B1', { SuccessReceiptId: 'r1' }, ['r1']), receipts_outcome: [outcome('r1', 'B2')] };
  const handover = { final_execution_status: 'FINAL', status: ok, transaction: { hash: 'HandoverTx', signer_id: 'owner.release.testnet', receiver_id: 'token.release.testnet', actions: [{ FunctionCall: { method_name: 'handover', args: Buffer.from(JSON.stringify({ guardian_id: 'guardian.release.testnet' })).toString('base64'), deposit: '0' } }] },
    transaction_outcome: outcome('t2', 'B3', { SuccessReceiptId: 'r2' }, ['r2']), receipts_outcome: [outcome('r2', 'B3')] };
  const del = { final_execution_status: 'FINAL', status: ok, transaction: { hash: 'DeleteTx', signer_id: 'token.release.testnet', receiver_id: 'token.release.testnet', actions: [{ DeleteKey: { public_key: 'ed25519:OldKey' } }] },
    transaction_outcome: outcome('t3', 'B4', { SuccessReceiptId: 'r3' }, ['r3']), receipts_outcome: [outcome('r3', 'B4')] };
  return { CreateTx: create, HandoverTx: handover, DeleteTx: del, ...over };
}
const heights = { B1: 10, B2: 11, B3: 20, B4: 21, [BLOCK]: 100 };
const gState = () => ({ version: 'qlyphs/near-guardian/v1', chain: 'testnet', target: 'token.release.testnet', config_sha256: hex(config), delay_seconds: 60, window_seconds: 86400,
  signer_key_sha256: keys.map((k) => hex(k)), next_nonce: '2', active: null, last: null });
const tState = () => ({ version: 2, owner: null, guardian: 'guardian.release.testnet', next_op: '2', total_supply: '10' });

function provider({ state = {}, query = {}, tx = txs(), blockOf = () => BLOCK } = {}) {
  return {
    block: async (p) => (p.finality ? { header: { hash: BLOCK, height: 100 } } : { header: { hash: p.block_id, height: heights[p.block_id] ?? 0 } }),
    sendJsonRpc: async (method, params) => { if (method === 'block') return { header: { hash: params.block_id, height: heights[params.block_id] ?? 0 } }; const r = tx[params.tx_hash]; if (!r) throw new Error(`unknown transaction ${params.tx_hash}`); return structuredClone(r); },
    query: async (p) => {
      const base = { block_hash: blockOf(p), block_height: 100 };
      if (p.request_type === 'view_access_key_list') return { ...base, keys: [], ...(query.keys?.[p.account_id] ?? {}) };
      if (p.request_type === 'view_account') return { ...base, amount: '1', code_hash: 'x' };
      if (p.request_type === 'view_code') return { ...base, code_base64: (p.account_id === expected.guardian ? guardianCode : v2).toString('base64') };
      if (p.request_type === 'view_state') return { ...base, values: [{ key: Buffer.from('C').toString('base64'), value: config.toString('base64') }] };
      if (p.request_type === 'call_function') {
        const v = p.account_id === expected.guardian ? ('guardian' in state ? state.guardian : gState()) : ('target' in state ? state.target : tState());
        return { ...base, result: [...Buffer.from(JSON.stringify(v))], logs: [] };
      }
      throw new Error('unexpected query');
    },
  };
}

const r0 = await verifyControl(provider(), expected);
record('baseline: every required check passes', r0.ok && r0.checks.length === 9 && r0.checks.every((c) => c.status === 'pass'), r0.checks.filter((c) => c.status !== 'pass').map((c) => `${c.name}: ${c.detail}`).join('; '));
const status = (r, name) => r.checks.find((c) => c.name === name)?.status;
{
  const r = await verifyControl(provider({ state: { guardian: null, target: null } }), expected);
  record('null Guardian and target state: unverified, report not ok', !r.ok && r.checks.length === 9 && status(r, 'Guardian state agrees') === 'unverified' && status(r, 'Target is guarded by this Guardian, no owner') === 'unverified');
}
{
  const r = await verifyControl(provider({ blockOf: () => 'AnotherBlock' }), expected);
  record('answers for another block: unverified', !r.ok && r.checks.filter((c) => c.status === 'unverified').length >= 7);
}
{
  const r = await verifyControl(provider({ query: { keys: { [expected.target]: { next: 'more' } } } }), expected);
  record('empty key list with a continuation marker: unverified', !r.ok && status(r, 'Target has no access keys') === 'unverified');
}
{
  const r = await verifyControl(provider({ query: { keys: { [expected.guardian]: { keys: [{ public_key: 'ed25519:Planted' }] } } } }), expected);
  record('one key on the Guardian: fail', !r.ok && status(r, 'Guardian has no access keys') === 'fail');
}
{
  const r = await verifyControl(provider({ state: { target: { ...tState(), next_op: 2 } } }), expected);
  record('target state with a numeric next_op: fail', !r.ok && status(r, 'Target is guarded by this Guardian, no owner') === 'fail');
}
{
  const r = await verifyControl(provider({ state: { target: { ...tState(), version: 1 } } }), expected);
  record('target version disagrees with its code hash: fail', !r.ok && status(r, 'Target is guarded by this Guardian, no owner') === 'fail');
}
{
  const fake = { ...expected, deployment: { ...expected.deployment, guardian_creation: { tx: 'NoSuchTx', audit: { actions: ['looks fine'] } }, cutover: { handover_tx: 'Nope', delete_keys_tx: 'Nope2', deleted_keys: [] } } };
  const r = await verifyControl(provider(), fake);
  record('placeholder provenance and unknown transactions: unverified', !r.ok && status(r, 'Creation audited on chain') === 'unverified' && status(r, 'Cutover audited on chain') === 'unverified');
}
{
  const r = await verifyControl(provider(), { ...expected, deployment: { ...expected.deployment, network: 'mainnet' } });
  record('a manifest for another network: unverified', !r.ok && status(r, 'Creation audited on chain') === 'unverified');
}
{
  const t = txs(); t.CreateTx.final_execution_status = 'INCLUDED'; t.CreateTx.status = { Started: null }; t.CreateTx.receipts_outcome = [];
  await rejects('creation audit refuses a pending creation', auditGuardianCreation(provider({ tx: t }), { txHash: 'CreateTx', sender: 'release.testnet', guardian: expected.guardian, codeSha256: expected.guardianSha256, config }), 'not final');
}
{
  const t = txs(); t.CreateTx.receipts_outcome = [];
  await rejects('creation audit refuses a missing creation receipt', auditGuardianCreation(provider({ tx: t }), { txHash: 'CreateTx', sender: 'release.testnet', guardian: expected.guardian, codeSha256: expected.guardianSha256, config }), 'missing');
}
{
  const t = txs(); t.CreateTx.transaction.signer_id = 'someone.testnet';
  await rejects('creation audit refuses another signer', auditGuardianCreation(provider({ tx: t }), { txHash: 'CreateTx', sender: 'release.testnet', guardian: expected.guardian, codeSha256: expected.guardianSha256, config }), 'not the expected transaction');
}
{
  const t = txs(); t.DeleteTx.transaction_outcome.block_hash = 'B1';
  const r = await verifyControl(provider({ tx: t }), expected);
  record('keys deleted before the handover: unverified', !r.ok && status(r, 'Cutover audited on chain') === 'unverified');
}
{
  const t = txs(); t.HandoverTx.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ guardian_id: 'other.testnet' })).toString('base64');
  const r = await verifyControl(provider({ tx: t }), expected);
  record('handover to another Guardian: unverified', !r.ok && status(r, 'Cutover audited on chain') === 'unverified');
}

// Client encoders.
const base = { chain: 'testnet', guardian: 'guardian.release.testnet', target: 'token.release.testnet', configHash: sha256(config), nonce: 1n, deadlineNs: 10n ** 18n };
const mint = encodeOperation({ ...base, action: 'mint', receiver: 'alice.testnet', amount: 5n });
record('decode round-trips a mint', decodeOperation(mint).receiver === 'alice.testnet' && decodeOperation(mint).amount === 5n);
throws('decode refuses a nonzero reserved byte', () => { const m = Buffer.from(mint); m[300] = 1; decodeOperation(m); }, 'reserved');
throws('decode refuses an unknown action', () => { const m = Buffer.from(mint); m[186] = 9; decodeOperation(m); }, 'unknown action');
throws('decode refuses a non-canonical receiver', () => { const m = Buffer.from(mint); m[195 + 1 + 63] = 0x61; decodeOperation(m); }, 'account id');
throws('decode refuses a zero mint amount', () => { const m = Buffer.from(mint); m.fill(0, 260, 276); decodeOperation(m); }, 'amount');
throws('envelope refuses duplicate signer indices', () => envelope(mint, [{ index: 1, signature: Buffer.alloc(SIG_LEN) }, { index: 1, signature: Buffer.alloc(SIG_LEN) }]), 'distinct');
throws('envelope refuses a short operation', () => envelope(mint.subarray(0, 300), [{ index: 0, signature: Buffer.alloc(SIG_LEN) }, { index: 1, signature: Buffer.alloc(SIG_LEN) }]), '320');
throws('envelope refuses code on a mint', () => envelope(mint, [{ index: 0, signature: Buffer.alloc(SIG_LEN) }, { index: 1, signature: Buffer.alloc(SIG_LEN) }], Buffer.from('x')), 'code');
const up = encodeOperation({ ...base, action: 'upgrade', code: Buffer.from('abc'), from: 1, to: 2 });
throws('envelope refuses code that does not match the upgrade', () => envelope(up, [{ index: 0, signature: Buffer.alloc(SIG_LEN) }, { index: 1, signature: Buffer.alloc(SIG_LEN) }], Buffer.from('abd')), 'code');

writeFileSync('evidence/sdk-unit.json', JSON.stringify({ suite: 'sdk.unit', results }, null, 2) + '\n');
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
