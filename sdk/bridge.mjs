// Client side of the Qlyphs PQ bridge (docs/BRIDGE.md): the 288-byte attestation two of three ML-DSA-87
// attesters sign for one Quantus deposit, and the mint input the NEAR contract checks.
import { createHash } from 'node:crypto';

export const BRIDGE_CONTEXT = 'qlyphs/near-bridge/v1';
export const ATTESTATION_LEN = 288;
export const SIG_LEN = 4627;
export const MAX_RECEIPT = 2048;
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;
const U128 = (1n << 128n) - 1n;
export const sha256 = (b) => createHash('sha256').update(b).digest();

function hex32(x, what) {
  const b = Buffer.isBuffer(x) ? x : Buffer.from(String(x).replace(/^0x/, ''), 'hex');
  if (b.length !== 32) throw new Error(`${what} is 32 bytes`);
  return b;
}
function id(out, at, v, what) {
  if (!ACCOUNT_ID.test(v)) throw new Error(`${what} is not a NEAR account id`);
  out[at] = v.length; out.write(v, at + 1, 'ascii');
}

/** { chain, bridge, quantusGenesis, depositId, amount (bigint, raw units), receiver, receipt?, intents? }.
 * intents: true mints into the bridge's configured NEAR Intents verifier for the receiver. */
export function encodeAttestation({ chain, bridge, quantusGenesis, depositId, amount, receiver, receipt, intents = false }) {
  const m = Buffer.alloc(ATTESTATION_LEN);
  m.write('QLYPBRG1', 0, 'ascii');
  if (!chain || chain.length > 8) throw new Error('chain tag is 1 to 8 characters');
  m.write(chain, 8, 'ascii');
  id(m, 16, bridge, 'bridge');
  hex32(quantusGenesis, 'Quantus genesis').copy(m, 81);
  hex32(depositId, 'deposit id').copy(m, 113);
  if (typeof amount !== 'bigint' || amount <= 0n || amount > U128) throw new Error('amount is a positive u128 bigint');
  m.writeBigUInt64LE(amount & ((1n << 64n) - 1n), 145); m.writeBigUInt64LE(amount >> 64n, 153);
  id(m, 161, receiver, 'receiver');
  if (receipt?.length) { if (receipt.length > MAX_RECEIPT) throw new Error('receipt too long'); sha256(receipt).copy(m, 226); }
  m[258] = intents ? 1 : 0;
  return m;
}

/** Mint input: attestation | i | sig | j | sig | receipt length u16 | receipt. */
export function encodeMint(attestation, [a, b], receipt = Buffer.alloc(0)) {
  const len = Buffer.alloc(2); len.writeUInt16LE(receipt.length);
  return Buffer.concat([attestation, Buffer.from([a.index]), Buffer.from(a.signature), Buffer.from([b.index]), Buffer.from(b.signature), len, receipt]);
}
export const attest = (key, index, attestation) => ({ index, signature: key.sign(attestation, Buffer.from(BRIDGE_CONTEXT)) });

/** new() input: Quantus genesis | three ML-DSA-87 public keys | verifier id length | verifier id. */
export function encodeConfig({ quantusGenesis, keys, verifier }) {
  if (keys.length !== 3 || keys.some((k) => k.length !== 2592)) throw new Error('three ML-DSA-87 public keys');
  if (!ACCOUNT_ID.test(verifier)) throw new Error('verifier is not a NEAR account id');
  return Buffer.concat([hex32(quantusGenesis, 'Quantus genesis'), ...keys.map((k) => Buffer.from(k)), Buffer.from([verifier.length]), Buffer.from(verifier, 'ascii')]);
}
