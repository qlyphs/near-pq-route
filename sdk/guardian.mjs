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

const canonicalId = (m, at, what) => {
  const n = m[at], id = m.toString('latin1', at + 1, at + 1 + n);
  if (n > 64 || !isAccountId(id) || m.subarray(at + 1 + n, at + 65).some((x) => x !== 0)) throw new Error(`${what}: not a canonical account id field`);
  return id;
};

/** Decodes a 320-byte operation for display, refusing anything the Guardian would refuse on shape. The wallet
 * shows exactly this, never separate metadata. */
export function decodeOperation(m) {
  m = Buffer.from(m);
  if (m.length !== OP_LEN || m.toString('latin1', 0, 8) !== 'QLYPGRD1') throw new Error('not a Guardian operation');
  const action = Object.keys(ACTION).find((k) => ACTION[k] === m[186]);
  if (!action) throw new Error('unknown action');
  const chain = m.toString('latin1', 8, 16).replace(/\0+$/, '');
  if (!/^[a-z]{1,8}$/.test(chain) || m.subarray(8 + chain.length, 16).some((x) => x !== 0)) throw new Error('bad network tag');
  const op = {
    chain, guardian: canonicalId(m, 16, 'guardian'), target: canonicalId(m, 81, 'target'),
    configHash: m.subarray(146, 178).toString('hex'), nonce: m.readBigUInt64LE(178), action, deadlineNs: m.readBigUInt64LE(187),
    proposalHash: sha256(m).toString('hex'),
  };
  const reservedFrom = { mint: 276, upgrade: 239, cancel: 227 }[action];
  if (m.subarray(reservedFrom).some((x) => x !== 0)) throw new Error('reserved bytes must be zero');
  if (action === 'mint') {
    Object.assign(op, { receiver: canonicalId(m, 195, 'receiver'), amount: m.readBigUInt64LE(260) + (m.readBigUInt64LE(268) << 64n) });
    if (op.amount === 0n) throw new Error('mint amount must be positive');
  }
  if (action === 'upgrade') {
    Object.assign(op, { codeSha256: m.subarray(195, 227).toString('hex'), codeLength: m.readUInt32LE(227), from: m.readUInt32LE(231), to: m.readUInt32LE(235) });
    if (op.codeLength < 1 || op.codeLength > MAX_CODE) throw new Error('code length out of range');
  }
  if (action === 'cancel') op.cancels = m.subarray(195, 227).toString('hex');
  return op;
}

/** One approval: signer index (0..2) and its signature over the operation. key has sign(message, context):
 * a vault.mjs Key (OpenSSL) in tests, a seed-derived signer in the demo. */
export const approve = (key, index, op) => ({ index, signature: key.sign(op, GUARDIAN_CONTEXT) });

/** propose/cancel input: operation ‖ two approvals from distinct signers ‖ (upgrade only) the matching code. */
export function envelope(op, approvals, code) {
  if (Buffer.from(op).length !== OP_LEN) throw new Error('the operation is 320 bytes');
  const decoded = decodeOperation(op);
  if (approvals.length !== 2) throw new Error('exactly two approvals');
  if (approvals[0].index === approvals[1].index) throw new Error('two approvals from distinct signers');
  if (decoded.action === 'upgrade') {
    const c = Buffer.from(code ?? []);
    if (c.length !== decoded.codeLength || sha256(c).toString('hex') !== decoded.codeSha256) throw new Error('code does not match the approved upgrade');
  } else if (code !== undefined && Buffer.from(code).length) throw new Error('only an upgrade carries code');
  const parts = [Buffer.from(op)];
  for (const { index, signature } of approvals) {
    if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error('signer index is 0..2');
    if (Buffer.from(signature).length !== SIG_LEN) throw new Error('signature is 4627 bytes');
    parts.push(Buffer.from([index]), Buffer.from(signature));
  }
  if (decoded.action === 'upgrade') parts.push(Buffer.from(code));
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
const failed = (s) => !s || typeof s !== 'object' || 'Failure' in s || !('SuccessValue' in s || 'SuccessReceiptId' in s);

/**
 * Reads one transaction with complete, final execution evidence: the returned hash, signer and receiver are
 * the expected ones, final_execution_status is FINAL, the transaction result succeeded, every outcome
 * succeeded, and every receipt an outcome points to is present. Throws otherwise.
 */
export async function finalTx(provider, { txHash, sender, receiver }) {
  const r = await provider.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' });
  if (r.final_execution_status !== 'FINAL') throw new Error(`${txHash}: execution is not final (${r.final_execution_status})`);
  if (r.transaction?.hash !== txHash || r.transaction.signer_id !== sender || r.transaction.receiver_id !== receiver) throw new Error(`${txHash}: not the expected transaction`);
  if (!r.status || !('SuccessValue' in r.status)) throw new Error(`${txHash}: transaction result is not a success`);
  const outcomes = [r.transaction_outcome, ...r.receipts_outcome];
  const ids = new Set(r.receipts_outcome.map((o) => o.id));
  for (const o of outcomes) {
    if (failed(o.outcome.status)) throw new Error(`${txHash}: outcome ${o.id} did not succeed`);
    for (const id of [o.outcome.status.SuccessReceiptId, ...(o.outcome.receipt_ids ?? [])].filter(Boolean)) {
      if (!ids.has(id)) throw new Error(`${txHash}: receipt ${id} is missing from the final evidence`);
    }
  }
  if (r.receipts_outcome.length === 0) throw new Error(`${txHash}: no receipt outcome`);
  return r;
}

/**
 * Per-deployment audit of the Guardian's creation transaction: exactly CreateAccount, Transfer,
 * DeployContract (the pinned code) and FunctionCall init with the exact config bytes and no deposit, with
 * complete final execution. It says nothing about an earlier incarnation of the account id: that is the
 * deployment assumption recorded with the result (docs/GUARDIAN.md, Trust boundary).
 */
export async function auditGuardianCreation(provider, { txHash, sender, guardian, codeSha256, config }) {
  const r = await finalTx(provider, { txHash, sender, receiver: guardian });
  const acts = r.transaction.actions;
  const kinds = acts.map(kindOf);
  if (kinds.join(',') !== 'CreateAccount,Transfer,DeployContract,FunctionCall') throw new Error(`Guardian creation actions: ${kinds.join(',')}`);
  // In a transaction view, DeployContract.code is the SHA-256 of the code (32 bytes), not the code itself
  // (view_code returns the full code): compare it as a digest.
  const digest = Buffer.from(acts[2].DeployContract.code, 'base64');
  if (digest.length !== 32 || digest.toString('hex') !== codeSha256) throw new Error('deployed code is not the pinned Guardian build');
  const fc = acts[3].FunctionCall;
  if (fc.method_name !== 'init' || !Buffer.from(fc.args, 'base64').equals(Buffer.from(config)) || BigInt(fc.deposit) !== 0n) throw new Error('init call is not the expected config');
  return { tx: txHash, actions: kinds, receipts: r.receipts_outcome.length, block_hash: r.transaction_outcome.block_hash };
}

/** The cutover: the owner's handover naming this Guardian, then the token deleting the listed keys, both final. */
export async function auditCutover(provider, { owner, target, guardian, handoverTx, deleteKeysTx, deletedKeys }) {
  const h = await finalTx(provider, { txHash: handoverTx, sender: owner, receiver: target });
  const ha = h.transaction.actions;
  if (ha.length !== 1 || kindOf(ha[0]) !== 'FunctionCall' || ha[0].FunctionCall.method_name !== 'handover') throw new Error('handover transaction is not one handover call');
  const args = JSON.parse(Buffer.from(ha[0].FunctionCall.args, 'base64').toString());
  if (args.guardian_id !== guardian || Object.keys(args).length !== 1) throw new Error('handover names another Guardian');
  const d = await finalTx(provider, { txHash: deleteKeysTx, sender: target, receiver: target });
  const da = d.transaction.actions;
  if (!da.length || !da.every((a) => kindOf(a) === 'DeleteKey')) throw new Error('key deletion transaction holds other actions');
  const removed = da.map((a) => a.DeleteKey.public_key).sort();
  if (JSON.stringify(removed) !== JSON.stringify([...deletedKeys].sort())) throw new Error('key deletion removed other keys than recorded');
  const height = async (hash) => (await provider.block({ block_id: hash })).header.height;
  const [hh, dh] = await Promise.all([height(h.transaction_outcome.block_hash), height(d.transaction_outcome.block_hash)]);
  if (dh < hh) throw new Error('keys were deleted before the handover');
  const last = Math.max(...await Promise.all(d.receipts_outcome.map((o) => height(o.block_hash))));
  return { handover_tx: handoverTx, delete_keys_tx: deleteKeysTx, deleted_keys: removed, completed_at_height: last };
}

const REQUIRED = ['Guardian has no access keys', 'Target has no access keys', 'Guardian runs the reproducible build', 'Target runs a reviewed build',
  'Guardian config bytes match', 'Guardian state agrees', 'Target is guarded by this Guardian, no owner', 'Creation audited on chain', 'Cutover audited on chain'];

/**
 * The "Verify control" report. Every query runs at one finalized block and every answer must name that block.
 * Each of the fixed checks ends pass, fail or unverified (evidence missing, malformed or unreadable); the
 * report is ok only when every one passes. Creation and cutover are re-audited from their transactions.
 * expected: { network, guardian, target, guardianSha256, reviewedTargetSha256: {v1, v2}, config, deployment }.
 */
export async function verifyControl(provider, expected) {
  const final = await provider.block({ finality: 'final' });
  const block = final.header.hash;
  const results = new Map(REQUIRED.map((n) => [n, { name: n, status: 'unverified', detail: 'not checked' }]));
  const set = (name, status, detail) => results.set(name, { name, status, detail });
  const q = async (request) => {
    const r = await provider.query({ ...request, block_id: block });
    if (r.block_hash !== block) throw new Error(`answer is for block ${r.block_hash}, not the pinned ${block}`);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const attempt = async (name, fn) => { try { await fn(); } catch (e) { set(name, 'unverified', String(e.message ?? e).slice(0, 240)); } };
  const codeSha = async (id) => {
    const a = await q({ request_type: 'view_account', account_id: id });
    if (a.global_contract_hash || a.global_contract_account_id) throw new Error('uses a global contract reference');
    const c = await q({ request_type: 'view_code', account_id: id });
    return sha256(Buffer.from(c.code_base64, 'base64')).toString('hex');
  };
  const keys = async (id) => {
    const r = await q({ request_type: 'view_access_key_list', account_id: id });
    const extra = Object.keys(r).filter((k) => !['keys', 'block_hash', 'block_height'].includes(k));
    if (!Array.isArray(r.keys) || extra.length) throw new Error(`incomplete key list answer (${extra.join(',') || 'no keys array'})`);
    return r.keys;
  };
  const call = async (id, method) => {
    const v = JSON.parse(Buffer.from((await q({ request_type: 'call_function', account_id: id, method_name: method, args_base64: '' })).result).toString());
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${method} returned no object`);
    return v;
  };
  const cfg = Buffer.from(expected.config);
  const cfgHash = sha256(cfg).toString('hex');

  for (const [label, id] of [['Guardian', expected.guardian], ['Target', expected.target]]) {
    await attempt(`${label} has no access keys`, async () => {
      const k = await keys(id);
      set(`${label} has no access keys`, k.length === 0 ? 'pass' : 'fail', k.length ? `${k.length} key(s): ${k.map((x) => x.public_key).join(', ')}` : '0 keys');
    });
  }
  await attempt('Guardian runs the reproducible build', async () => {
    const h = await codeSha(expected.guardian);
    set('Guardian runs the reproducible build', h === expected.guardianSha256 ? 'pass' : 'fail', h);
  });
  let targetVersion;
  await attempt('Target runs a reviewed build', async () => {
    const h = await codeSha(expected.target);
    targetVersion = Object.entries(expected.reviewedTargetSha256).find(([, x]) => x === h)?.[0];
    set('Target runs a reviewed build', targetVersion ? 'pass' : 'fail', targetVersion ? `${targetVersion} ${h}` : `unreviewed code ${h}`);
  });
  await attempt('Guardian config bytes match', async () => {
    const page = await q({ request_type: 'view_state', account_id: expected.guardian, prefix_base64: Buffer.from('C').toString('base64'), limit: 1 });
    const v = page.values?.find((x) => Buffer.from(x.key, 'base64').toString() === 'C');
    if (!v) throw new Error('config entry not returned');
    set('Guardian config bytes match', Buffer.from(v.value, 'base64').equals(cfg) ? 'pass' : 'fail', `config sha256 ${cfgHash}`);
  });
  await attempt('Guardian state agrees', async () => {
    const g = await call(expected.guardian, 'state');
    const keyHashes = [0, 1, 2].map((i) => sha256(cfg.subarray(81 + i * PK_LEN, 81 + (i + 1) * PK_LEN)).toString('hex'));
    const good = g.chain === expected.network && g.target === expected.target && g.config_sha256 === cfgHash
      && g.delay_seconds === Number(cfg.readBigUInt64LE(65)) && g.window_seconds === Number(cfg.readBigUInt64LE(73))
      && Array.isArray(g.signer_key_sha256) && JSON.stringify(g.signer_key_sha256) === JSON.stringify(keyHashes)
      && typeof g.next_nonce === 'string' && /^\d+$/.test(g.next_nonce);
    set('Guardian state agrees', good ? 'pass' : 'fail',
      `2 of 3 signers, delay ${g.delay_seconds} s, window ${g.window_seconds} s, next nonce ${g.next_nonce}, active ${g.active ? `${g.active.action} #${g.active.nonce} ${g.active.status}` : 'none'}`);
  });
  await attempt('Target is guarded by this Guardian, no owner', async () => {
    const t = await call(expected.target, 'state');
    const good = t.guardian === expected.guardian && t.owner === null && typeof t.version === 'number' && typeof t.next_op === 'string'
      && typeof t.total_supply === 'string' && (!targetVersion || `v${t.version}` === targetVersion);
    set('Target is guarded by this Guardian, no owner', good ? 'pass' : 'fail', `version ${t.version}, next op ${t.next_op}, supply ${t.total_supply}`);
  });
  const d = expected.deployment ?? {};
  const bound = d.network === expected.network && d.accounts?.guardian === expected.guardian && d.accounts?.token === expected.target;
  await attempt('Creation audited on chain', async () => {
    if (!bound || !d.guardian_creation?.tx) throw new Error('no creation record for this deployment');
    const a = await auditGuardianCreation(provider, { txHash: d.guardian_creation.tx, sender: d.accounts.parent, guardian: expected.guardian, codeSha256: expected.guardianSha256, config: cfg });
    set('Creation audited on chain', 'pass', `tx ${a.tx}: ${a.actions.join(', ')}, exact config, final`);
  });
  await attempt('Cutover audited on chain', async () => {
    if (!bound || !d.cutover?.handover_tx) throw new Error('no cutover record for this deployment');
    const c = await auditCutover(provider, { owner: d.accounts.owner, target: expected.target, guardian: expected.guardian, handoverTx: d.cutover.handover_tx, deleteKeysTx: d.cutover.delete_keys_tx, deletedKeys: d.cutover.deleted_keys });
    if (final.header.height < c.completed_at_height) throw new Error(`report block ${final.header.height} is older than the cutover (${c.completed_at_height})`);
    set('Cutover audited on chain', 'pass', `handover ${c.handover_tx}, then ${c.deleted_keys.length} key(s) deleted in ${c.delete_keys_tx}`);
  });
  const checks = REQUIRED.map((n) => results.get(n));
  const ok = checks.every((c) => c.status === 'pass');
  return { block: { hash: block, height: final.header.height }, ok, checks,
    statement: ok ? `At finalized block ${final.header.height} these accounts had no access keys and ran these reviewed builds with this configuration, after the audited creation and cutover.` : 'Not verified: see the failing or unverified checks.' };
}
