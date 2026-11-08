// Client side of Qlyphs Guardian (docs/GUARDIAN.md): config bytes, the 320-byte signed operation, the approval envelope.
import { createHash } from 'node:crypto';

export const PK_LEN = 2592;
export const SIG_LEN = 4627;
// NEAR account id grammar, checked before encoding (a lookalike Unicode id is refused, not changed).
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;
export const isAccountId = (id) => typeof id === 'string' && ACCOUNT_ID.test(id);

export const GUARDIAN_CONTEXT = Buffer.from('qlyphs/near-guardian/v1');
export const OP_LEN = 320;
export const CONFIG_LEN = 65 + 8 + 8 + 3 * PK_LEN; // 7,857
export const ENVELOPE_LEN = OP_LEN + 2 * (1 + SIG_LEN); // 9,576
export const MAX_CODE = 131072;
export const ACTION = { mint: 1, upgrade: 2, cancel: 3 };
const NS = 1_000_000_000n;
const U64 = (1n << 64n) - 1n;

export const sha256 = (b) => createHash('sha256').update(b).digest();

function idField(out, at, id) {
  if (!isAccountId(id)) throw new Error(`not a NEAR account id: ${JSON.stringify(id)}`);
  out[at] = id.length;
  out.write(id, at + 1, 'ascii');
}
function u64(out, at, x, what) {
  if (typeof x !== 'bigint' || x < 0n || x > U64) throw new Error(`${what} is a u64 bigint`);
  out.writeBigUInt64LE(x, at);
}

/** Guardian config: target id, delay and dispatch window in seconds (bigint), three ML-DSA-87 public keys. */
export function encodeConfig({ target, delaySeconds, windowSeconds, signerKeys }) {
  if (!Array.isArray(signerKeys) || signerKeys.length !== 3) throw new Error('exactly three signer keys');
  const c = Buffer.alloc(CONFIG_LEN);
  idField(c, 0, target);
  u64(c, 65, delaySeconds, 'delay');
  u64(c, 73, windowSeconds, 'window');
  signerKeys.forEach((k, i) => {
    const b = Buffer.from(k);
    if (b.length !== PK_LEN) throw new Error('signer keys are 2592-byte ML-DSA-87 public keys');
    b.copy(c, 81 + i * PK_LEN);
  });
  const hex = new Set(signerKeys.map((k) => Buffer.from(k).toString('hex')));
  if (hex.size !== 3) throw new Error('signer keys must be distinct');
  return c;
}

/**
 * The 320-byte operation. deadlineNs is a block timestamp in nanoseconds (bigint).
 * mint: { receiver, amount }; upgrade: { code, from, to }; cancel: { proposalHash }.
 */
export function encodeOperation({ chain, guardian, target, configHash, nonce, action, deadlineNs, ...p }) {
  const m = Buffer.alloc(OP_LEN);
  m.write('QLYPGRD1', 0, 'ascii');
  if (!/^[a-z]{1,8}$/.test(chain)) throw new Error('chain tag is 1 to 8 lowercase letters');
  m.write(chain, 8, 'ascii');
  idField(m, 16, guardian);
  idField(m, 81, target);
  if (Buffer.from(configHash).length !== 32) throw new Error('config hash is 32 bytes');
  Buffer.from(configHash).copy(m, 146);
  u64(m, 178, nonce, 'nonce');
  if (!ACTION[action]) throw new Error('action is mint, upgrade or cancel');
  m[186] = ACTION[action];
  u64(m, 187, deadlineNs, 'deadline');
  if (action === 'mint') {
    idField(m, 195, p.receiver);
    if (typeof p.amount !== 'bigint' || p.amount <= 0n || p.amount >= 1n << 128n) throw new Error('amount is a positive u128 bigint');
    m.writeBigUInt64LE(p.amount & U64, 260);
    m.writeBigUInt64LE(p.amount >> 64n, 268);
  } else if (action === 'upgrade') {
    const code = Buffer.from(p.code);
    if (code.length < 1 || code.length > MAX_CODE) throw new Error(`code is 1 to ${MAX_CODE} bytes`);
    sha256(code).copy(m, 195);
    m.writeUInt32LE(code.length, 227);
    m.writeUInt32LE(p.from, 231);
    m.writeUInt32LE(p.to, 235);
  } else {
    if (Buffer.from(p.proposalHash).length !== 32) throw new Error('proposal hash is 32 bytes');
    Buffer.from(p.proposalHash).copy(m, 195);
  }
  return m;
}

/** Decodes a 320-byte operation for display; the wallet shows exactly this, never separate metadata. */
export function decodeOperation(m) {
  m = Buffer.from(m);
  if (m.length !== OP_LEN || m.toString('latin1', 0, 8) !== 'QLYPGRD1') throw new Error('not a Guardian operation');
  const id = (at) => m.toString('ascii', at + 1, at + 1 + m[at]);
  const action = Object.keys(ACTION).find((k) => ACTION[k] === m[186]);
  const op = {
    chain: m.toString('ascii', 8, 16).replace(/\0+$/, ''), guardian: id(16), target: id(81),
    configHash: m.subarray(146, 178).toString('hex'), nonce: m.readBigUInt64LE(178), action, deadlineNs: m.readBigUInt64LE(187),
    proposalHash: sha256(m).toString('hex'),
  };
  if (action === 'mint') Object.assign(op, { receiver: id(195), amount: m.readBigUInt64LE(260) + (m.readBigUInt64LE(268) << 64n) });
  if (action === 'upgrade') Object.assign(op, { codeSha256: m.subarray(195, 227).toString('hex'), codeLength: m.readUInt32LE(227), from: m.readUInt32LE(231), to: m.readUInt32LE(235) });
  if (action === 'cancel') op.cancels = m.subarray(195, 227).toString('hex');
  return op;
}

/** One approval: signer index (0..2) and its signature over the operation. key has sign(message, context):
 * a vault.mjs Key (OpenSSL) in tests, a seed-derived signer in the demo. */
export const approve = (key, index, op) => ({ index, signature: key.sign(op, GUARDIAN_CONTEXT) });

/** propose/cancel input: operation ‖ two approvals ‖ (upgrade only) the code. */
export function envelope(op, approvals, code) {
  if (approvals.length !== 2) throw new Error('exactly two approvals');
  const parts = [Buffer.from(op)];
  for (const { index, signature } of approvals) {
    if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error('signer index is 0..2');
    if (Buffer.from(signature).length !== SIG_LEN) throw new Error('signature is 4627 bytes');
    parts.push(Buffer.from([index]), Buffer.from(signature));
  }
  if (code) parts.push(Buffer.from(code));
  return new Uint8Array(Buffer.concat(parts));
}

/** Upgrade input the Guardian sends to the target: op id ‖ from ‖ to ‖ code (also built on-chain). */
export function targetUpgradeArgs(opId, from, to, code) {
  const b = Buffer.alloc(16 + code.length);
  b.writeBigUInt64LE(BigInt(opId), 0); b.writeUInt32LE(from, 8); b.writeUInt32LE(to, 12); Buffer.from(code).copy(b, 16);
  return b;
}

export const secondsToNs = (s) => BigInt(s) * NS;

const kindOf = (a) => (typeof a === 'string' ? a : Object.keys(a)[0]);
const succeeded = (s) => 'SuccessValue' in s || 'SuccessReceiptId' in s;

/**
 * Per-deployment audit of the Guardian's creation transaction: exactly CreateAccount, Transfer,
 * DeployContract (the pinned code) and FunctionCall init with the exact config bytes, every receipt of it
 * completed successfully. It says nothing about an earlier incarnation of the account id: that is the
 * deployment assumption recorded with the result (docs/GUARDIAN.md, Trust boundary).
 */
export async function auditGuardianCreation(provider, { txHash, sender, guardian, codeSha256, config }) {
  const r = await provider.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' });
  if (r.transaction.receiver_id !== guardian) throw new Error('transaction does not target the Guardian');
  const acts = r.transaction.actions;
  const kinds = acts.map(kindOf);
  if (kinds.join(',') !== 'CreateAccount,Transfer,DeployContract,FunctionCall') throw new Error(`Guardian creation actions: ${kinds.join(',')}`);
  if (Buffer.from(acts[2].DeployContract.code, 'base64').toString('hex') !== codeSha256) throw new Error('deployed code is not the pinned Guardian build');
  const fc = acts[3].FunctionCall;
  if (fc.method_name !== 'init' || !Buffer.from(fc.args, 'base64').equals(Buffer.from(config)) || BigInt(fc.deposit) !== 0n) throw new Error('init call is not the expected config');
  for (const o of [r.transaction_outcome, ...r.receipts_outcome]) if (!succeeded(o.outcome.status)) throw new Error(`receipt ${o.id} did not succeed`);
  return { tx: txHash, actions: kinds, receipts: r.receipts_outcome.length, block_hash: r.transaction_outcome.block_hash };
}

/**
 * The "Verify control" report. Every query runs at one finalized block. Each check is pass, fail or
 * unverified (the evidence could not be read); a missing answer is never treated as a pass.
 * expected: { network, guardian, target, guardianSha256, reviewedTargetSha256: {v1, v2}, config, deployment }.
 */
export async function verifyControl(provider, expected) {
  const final = await provider.block({ finality: 'final' });
  const block = final.header.hash;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const q = (request) => provider.query({ ...request, block_id: block });
  const tryq = async (name, fn) => { try { return await fn(); } catch (e) { add(name, 'unverified', String(e.message ?? e).slice(0, 200)); return undefined; } };
  const codeSha = async (id) => {
    const a = await q({ request_type: 'view_account', account_id: id });
    if (a.global_contract_hash || a.global_contract_account_id) throw new Error('uses a global contract reference');
    const c = await q({ request_type: 'view_code', account_id: id });
    return sha256(Buffer.from(c.code_base64, 'base64')).toString('hex');
  };
  const keys = async (id) => {
    const r = await q({ request_type: 'view_access_key_list', account_id: id });
    if (!Array.isArray(r.keys)) throw new Error('no key list in the answer');
    return r.keys;
  };
  const call = async (id, method) => JSON.parse(Buffer.from((await q({ request_type: 'call_function', account_id: id, method_name: method, args_base64: '' })).result).toString());

  for (const [label, id] of [['Guardian', expected.guardian], ['Target', expected.target]]) {
    const k = await tryq(`${label} has no access keys`, () => keys(id));
    if (k) add(`${label} has no access keys`, k.length === 0 ? 'pass' : 'fail', k.length ? `${k.length} key(s): ${k.map((x) => x.public_key).join(', ')}` : '0 keys');
  }
  const gsha = await tryq('Guardian runs the reproducible build', () => codeSha(expected.guardian));
  if (gsha) add('Guardian runs the reproducible build', gsha === expected.guardianSha256 ? 'pass' : 'fail', gsha);
  const tsha = await tryq('Target runs a reviewed build', () => codeSha(expected.target));
  if (tsha) {
    const which = Object.entries(expected.reviewedTargetSha256).find(([, h]) => h === tsha)?.[0];
    add('Target runs a reviewed build', which ? 'pass' : 'fail', which ? `${which} ${tsha}` : `unreviewed code ${tsha}`);
  }
  const page = await tryq('Guardian config bytes match', () => q({ request_type: 'view_state', account_id: expected.guardian, prefix_base64: Buffer.from('C').toString('base64'), limit: 1 }));
  if (page) {
    const v = page.values?.find((x) => Buffer.from(x.key, 'base64').toString() === 'C');
    add('Guardian config bytes match', v && Buffer.from(v.value, 'base64').equals(Buffer.from(expected.config)) ? 'pass' : 'fail', `config sha256 ${sha256(expected.config).toString('hex')}`);
  }
  const gs = await tryq('Guardian state agrees', () => call(expected.guardian, 'state'));
  if (gs) add('Guardian state agrees', gs.chain === expected.network && gs.target === expected.target && gs.config_sha256 === sha256(expected.config).toString('hex') ? 'pass' : 'fail',
    `2 of 3 signers, delay ${gs.delay_seconds} s, window ${gs.window_seconds} s, next nonce ${gs.next_nonce}, active ${gs.active ? `${gs.active.action} #${gs.active.nonce} ${gs.active.status}` : 'none'}`);
  const ts = await tryq('Target is guarded by this Guardian, no owner', () => call(expected.target, 'state'));
  if (ts) add('Target is guarded by this Guardian, no owner', ts.guardian === expected.guardian && ts.owner === null ? 'pass' : 'fail', `version ${ts.version}, next op ${ts.next_op}, supply ${ts.total_supply}`);
  const d = expected.deployment;
  add('Recorded creation audit', d?.guardian_creation?.audit ? 'pass' : 'unverified', d?.guardian_creation ? `tx ${d.guardian_creation.tx}` : 'no record');
  add('Recorded cutover', d?.cutover?.delete_keys_tx ? 'pass' : 'unverified', d?.cutover ? `handover ${d.cutover.handover_tx}, delete keys ${d.cutover.delete_keys_tx}` : 'no record');
  const ok = checks.every((c) => c.status === 'pass');
  return { block: { hash: block, height: final.header.height }, ok, checks,
    statement: ok ? `At finalized block ${final.header.height} these accounts had no access keys and ran these reviewed builds with this configuration, under the recorded deployment and cutover assumptions.` : 'Not verified: see the failing or unverified checks.' };
}
