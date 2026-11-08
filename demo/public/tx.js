// Browser side of the wallet flow: borsh-encodes a NEAR transaction (one FunctionCall) and builds the
// MyNearWallet URLs. The visitor's wallet signs; this page never holds a key.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
class Writer {
  parts = [];
  u8(x) { this.parts.push(Uint8Array.of(x)); }
  u32(x) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); this.parts.push(b); }
  u64(x) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(x), true); this.parts.push(b); }
  u128(x) { x = BigInt(x); this.u64(x & 0xffffffffffffffffn); this.u64(x >> 64n); }
  bytes(b) { this.parts.push(Uint8Array.from(b)); }
  vec(b) { this.u32(b.length); this.bytes(b); }
  str(s) { this.vec(new TextEncoder().encode(s)); }
  done() { const n = this.parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}
/** Borsh Transaction with FunctionCall actions: { signerId, publicKey 'ed25519:…', nonce, receiverId, blockHash (base58), actions: [{ method, args: Uint8Array, gas, deposit }] }. */
export function encodeTx({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const pub = b58decode(publicKey.replace(/^ed25519:/, ''));
  if (pub.length !== 32) throw new Error('an ed25519 public key is 32 bytes');
  const w = new Writer();
  w.str(signerId); w.u8(0); w.bytes(pub); w.u64(nonce); w.str(receiverId); w.bytes(b58decode(blockHash));
  w.u32(actions.length);
  for (const a of actions) { w.u8(2); w.str(a.method); w.vec(a.args); w.u64(a.gas); w.u128(a.deposit ?? 0n); }
  return w.done();
}
export function toBase64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const WALLET = 'https://testnet.mynearwallet.com';
/** The wallet's login page; it comes back to successUrl with account_id, public_key and all_keys. */
export function loginUrl(successUrl, failureUrl = successUrl) {
  const u = new URL('/login/', WALLET); u.searchParams.set('success_url', successUrl); u.searchParams.set('failure_url', failureUrl); return u.toString();
}
/** The wallet's sign page for one or more encoded transactions; it comes back to callbackUrl with transactionHashes, or errorCode and errorMessage. */
export function signUrl(encodedTxs, callbackUrl, meta) {
  const u = new URL('/sign', WALLET);
  u.searchParams.set('transactions', encodedTxs.map(toBase64).join(','));
  u.searchParams.set('callbackUrl', callbackUrl);
  if (meta) u.searchParams.set('meta', meta);
  return u.toString();
}
