// Minimal NEAR client for the demo Worker: JSON-RPC, borsh transaction encoding and ed25519 signing.
// Only the actions the demo sends (DeployContract, FunctionCall) are encoded.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
export function b58encode(b) {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = '1' + s; }
  return s;
}

/** A NEAR ed25519 key from its "ed25519:<base58 seed|public>" secret string. */
export function edKey(secret) {
  const raw = b58decode(secret.replace(/^ed25519:/, ''));
  const seed = raw.subarray(0, 32), pub = ed25519.getPublicKey(seed);
  return { seed, pub, publicKey: `ed25519:${b58encode(pub)}` };
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

export const functionCall = (method, args, gas, deposit = 0n) => ({ kind: 2, method, args: typeof args === 'string' ? new TextEncoder().encode(args) : Uint8Array.from(args), gas: BigInt(gas), deposit: BigInt(deposit) });
export const deployContract = (code) => ({ kind: 1, code: Uint8Array.from(code) });

function encodeTx({ signerId, pub, nonce, receiverId, blockHash, actions }) {
  const w = new Writer();
  w.str(signerId); w.u8(0); w.bytes(pub); w.u64(nonce); w.str(receiverId); w.bytes(blockHash);
  w.u32(actions.length);
  for (const a of actions) {
    w.u8(a.kind);
    if (a.kind === 1) w.vec(a.code);
    else if (a.kind === 2) { w.str(a.method); w.vec(a.args); w.u64(a.gas); w.u128(a.deposit); }
    else throw new Error('unsupported action');
  }
  return w.done();
}

export class Rpc {
  constructor(url) { this.url = url; }
  async call(method, params) {
    for (let i = 0; ; i++) {
      const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'g', method, params }) });
      const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
      if (j.error) {
        const msg = JSON.stringify(j.error);
        if (i < 3 && /TIMEOUT|HTTP 5\d\d|try again/i.test(msg) && method !== 'send_tx') { await new Promise((ok) => setTimeout(ok, 1500)); continue; }
        const e = new Error(j.error.data && typeof j.error.data === 'string' ? j.error.data : msg); e.rpc = j.error; throw e;
      }
      return j.result;
    }
  }
  query(params) { return this.call('query', params); }
  block(params) { return this.call('block', params); }
  sendJsonRpc(method, params) { return this.call(method, params); }
  async view(accountId, method, args = {}) {
    const r = await this.query({ request_type: 'call_function', finality: 'optimistic', account_id: accountId, method_name: method, args_base64: btoa(JSON.stringify(args)) });
    const text = new TextDecoder().decode(Uint8Array.from(r.result));
    return text ? JSON.parse(text) : null;
  }
  /** Signs and sends one transaction, waits for its execution; returns { hash, ok, failure, outcome }. */
  async send(signerId, key, receiverId, actions) {
    for (let attempt = 0; ; attempt++) {
      let ak;
      try { ak = await this.query({ request_type: 'view_access_key', finality: 'optimistic', account_id: signerId, public_key: key.publicKey }); }
      catch (e) { return { hash: null, ok: false, failure: `access key ${key.publicKey} on ${signerId}: ${e.message}`, outcome: null }; }
      // The RPC reports a missing key as a result with an error field, not as a JSON-RPC error.
      // A key that is gone still gets its transaction signed and sent, so the network itself refuses it.
      if (ak.error || ak.nonce === undefined) ak = { nonce: 0 };
      const block = await this.block({ finality: 'final' });
      const tx = encodeTx({ signerId, pub: key.pub, nonce: BigInt(ak.nonce) + 1n, receiverId, blockHash: b58decode(block.header.hash), actions });
      const hash = sha256(tx), sig = ed25519.sign(hash, key.seed);
      const signed = new Uint8Array(tx.length + 65); signed.set(tx); signed[tx.length] = 0; signed.set(sig, tx.length + 1);
      try {
        const out = await this.call('send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'EXECUTED_OPTIMISTIC' });
        const failures = [out.status, ...out.receipts_outcome.map((o) => o.outcome.status)].filter((s) => s && 'Failure' in s).map((s) => s.Failure);
        return { hash: b58encode(hash), ok: failures.length === 0, failure: failures.length ? JSON.stringify(failures[0]) : null, outcome: out };
      } catch (e) {
        if (attempt < 2 && /InvalidNonce/.test(e.message)) continue;
        return { hash: b58encode(hash), ok: false, failure: e.message, outcome: null };
      }
    }
  }
}
