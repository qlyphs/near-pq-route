// Client side of Qlyphs Guardian (docs/GUARDIAN.md): config bytes, the 320-byte signed operation, the approval envelope.
import { createHash } from 'node:crypto';
import { isAccountId, PK_LEN, SIG_LEN } from './vault.mjs';

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

/** One approval: signer index (0..2) and its signature over the operation. key is a vault.mjs Key. */
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
