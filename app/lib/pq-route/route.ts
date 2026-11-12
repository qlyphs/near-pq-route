/** The post-quantum QTC route on test networks: where it lives, the bytes the payer's wallet signs, and the reads. */
import { encodeSiteSessionChallenge } from '@qlyphs/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { publicKeyToHandle } from '@fastnear/ml-dsa-65';
import * as rc from './crypto.js';

/** Test networks only: the curve test chain (this app's Testnet) and NEAR testnet. */
export const ROUTE = {
  network: 'testnet',
  quantusGenesis: '0x06fb13f7086158562fac1b684da75feb627261a277b63e44043f2997d0b24693',
  /** The 2-of-3 Quantus multisig holding locked QTC, and its account id. */
  lock: 'qzpPEKhGncdyaUgZSxY1zMq3VvB5ng5LmZBP4arD83PFp46jE',
  lockAccountId: '0xda1f22169753932899a40df86f038aa32410cdb6e80ea8393813a5ba39308bf2',
  bridge: 'qtc-pq.qlyphs-pqroute-a.testnet',
  verifier: 'intents.qlyphs-pqroute-b.testnet',
  sponsor: 'qlyphs-pqroute-c.testnet',
  worker: 'https://qlyphs-pq-route.qlyphs.workers.dev',
  nearRpc: 'https://rpc.testnet.fastnear.com',
  nearExplorer: 'https://testnet.nearblocks.io',
  audience: 'qlyphs-pq-route',
  action: 'near-route',
  /** Quantus blocks the attesters wait for before signing (their WQTC_CONFIRMATIONS). Shown on screen only. */
  confirmations: 8,
} as const;
export const tokenId = `nep141:${ROUTE.bridge}`;
export const isRouteNetwork = (genesis: string | null | undefined) => genesis?.toLowerCase() === ROUTE.quantusGenesis;

const te = new TextEncoder();
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function putId(out: Uint8Array, at: number, id: string) {
  if (!/^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/.test(id)) throw new Error(`not a NEAR account id: ${id}`);
  out[at] = id.length;
  out.set(te.encode(id), at + 1);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = '1' + s; }
  return s;
}

/** The handle NEAR lists an ML-DSA-65 key under. The route commits to it, never to the full key, so the full key
 * ("ml-dsa-65:…", a fresh account of this browser) and the handle ("ml-dsa-65-hash:…", an account held in another
 * wallet, which NEAR shows only by handle) name the same key. A handle must decode to exactly 32 bytes and is
 * re-encoded canonically. Throws on anything else. */
export function keyHandle(accountKey: string): string {
  if (/^ml-dsa-65:[1-9A-HJ-NP-Za-km-z]+$/.test(accountKey)) return publicKeyToHandle(accountKey as never);
  const m = /^ml-dsa-65-hash:([1-9A-HJ-NP-Za-km-z]+)$/.exec(accountKey);
  const raw = m ? b58decode(m[1]!) : null;
  if (!raw || raw.length !== 32) throw new Error('not an ML-DSA-65 key');
  return `ml-dsa-65-hash:${b58encode(raw)}`;
}

/** The 240-byte route the attesters rebuild (qlyphs-pq87-near docs/ROUTE.md): it names the receiver and its only key. */
export function encodeRoute(depositId: string, receiver: string, intents: boolean, receiptHex: string, accountKey: string, bridge: string = ROUTE.bridge): Uint8Array {
  const m = new Uint8Array(240);
  m.set(te.encode('QLYPRTE2'), 0);
  m.set(rc.unhex(depositId.replace(/^0x/, '')), 8);
  putId(m, 40, bridge);
  putId(m, 105, receiver);
  m[170] = intents ? 1 : 0;
  const receipt = rc.unhex(receiptHex);
  if (receipt.length) m.set(sha256(receipt), 171);
  m.set(sha256(te.encode(keyHandle(accountKey))), 203);
  return m;
}

/** Deposit id = SHA-256(block hash ‖ extrinsic index u32 LE), as the attesters and the bridge compute it. */
export function depositId(blockHash: string, index: number): string {
  const b = new Uint8Array(36);
  b.set(rc.unhex(blockHash.replace(/^0x/, '')), 0);
  new DataView(b.buffer).setUint32(32, index, true);
  return toHex(sha256(b));
}

/**
 * The site session challenge whose nonce is SHA-256 of the route: when the payer's Qlyphs wallet signs it
 * with the key that made the deposit, that signature authorizes exactly this route and nothing else.
 */
export function routeChallenge(account: string, origin: string, route: Uint8Array, at: { quantusGenesis: string; lockAccountId: string } = ROUTE): string {
  const now = Date.now();
  return toHex(encodeSiteSessionChallenge({
    genesis: at.quantusGenesis, service: at.lockAccountId, account, audience: ROUTE.audience, origin,
    nonce: '0x' + toHex(sha256(route)), issuedAt: now, expiresAt: now + 10 * 60_000, actions: [ROUTE.action],
  }));
}

/** A view call on NEAR testnet at the final block. */
export async function nearView<T>(account: string, method: string, args: unknown = {}): Promise<T> {
  const res = await fetch(ROUTE.nearRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) } }) });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(`NEAR testnet: ${JSON.stringify(j.error ?? j.result.error).slice(0, 200)}`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(j.result.result)));
}
export async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(ROUTE.nearRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: id } }) });
  return !!(await res.json()).result;
}

/** Every public receipt, in pages of 8: the same reads for every visitor, so a read reveals nobody. */
export async function allReceipts(): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let from = 0; ; from += 8) {
    const page = await nearView<string[]>(ROUTE.bridge, 'receipts', { from: String(from), limit: '8' });
    out.push(...page.map((h) => rc.unhex(h)));
    if (page.length < 8) return out;
  }
}

async function rpcCall(method: string, params: unknown) {
  const res = await fetch(ROUTE.nearRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  return { result: j.result, error: j.error ? JSON.stringify(j.error) : null };
}
/**
 * Whether the receiver may be paid, read at one finalized block so the conditions hold together: it exists, its
 * only key is exactly `accountKey` (full access), it has no contract, and NEAR Intents holds no signing key for it
 * and authenticates it as the calling account. The same check the attesters repeat before signing. Returns the
 * reason it may not, or null.
 */
export async function receiverProblem(account: string, accountKey: string): Promise<string | null> {
  const block = (await rpcCall('block', { finality: 'final' })).result?.header?.hash;
  if (!block) throw new Error('NEAR testnet: no final block');
  const acct = await rpcCall('query', { request_type: 'view_account', block_id: block, account_id: account });
  if (!acct.result) { if (/UNKNOWN_ACCOUNT|does not exist/.test(acct.error ?? '')) return 'the recipient\'s account does not exist yet'; throw new Error('NEAR testnet: account read failed'); }
  const a = acct.result;
  if (a.code_hash !== '11111111111111111111111111111111' || a.global_contract_hash || a.global_contract_account_id) return 'the recipient\'s account has contract code';
  const keys = (await rpcCall('query', { request_type: 'view_access_key_list', block_id: block, account_id: account })).result?.keys;
  if (!Array.isArray(keys) || keys.length !== 1 || keys[0].public_key !== keyHandle(accountKey) || keys[0].access_key.permission !== 'FullAccess') return 'the recipient\'s account has other keys than the requested one';
  const view = async (method: string) => {
    const r = await rpcCall('query', { request_type: 'call_function', block_id: block, account_id: ROUTE.verifier, method_name: method, args_base64: btoa(JSON.stringify({ account_id: account })) });
    if (!r.result) throw new Error('NEAR testnet: Intents read failed');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result.result)));
  };
  const pks = await view('public_keys_of');
  if (!Array.isArray(pks) || pks.length !== 0) return 'NEAR Intents holds another signing key for the recipient';
  if ((await view('is_auth_by_predecessor_id_enabled')) !== true) return 'NEAR Intents does not authenticate the recipient by its own account';
  return null;
}
/**
 * An existing NEAR account the route may deliver to, such as one held in Meteor: its keys must be exactly one
 * full-access ML-DSA-65 key and nothing else (the configuration this demo supports). Returns that key's handle and the
 * finalized block it was read at (a snapshot: the holder can change keys later), or what stands in the way and, when
 * the holder can fix it, how: add an ML-DSA-65 key in their wallet, or remove the classical keys that remain.
 */
export type KeyFix = { kind: 'add' } | { kind: 'remove'; keys: string[] };
export async function postQuantumKey(account: string): Promise<{ handle: string; block: number } | { problem: string; fix?: KeyFix }> {
  const r = await rpcCall('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account });
  if (!r.result) { if (/UNKNOWN_ACCOUNT|does not exist/.test(r.error ?? '')) return { problem: `${account} does not exist on NEAR testnet` }; throw new Error('NEAR testnet: the account\'s keys could not be read'); }
  const keys: { public_key: string; access_key: { permission: unknown } }[] = Array.isArray(r.result.keys) ? r.result.keys : [];
  const isPq = (k: { public_key: string }) => k.public_key.startsWith('ml-dsa-65-hash:');
  const pq = keys.filter(isPq);
  // The supported configuration, said as a policy: not every other configuration is equally unsafe.
  const rule = 'This demo requires exactly one ML-DSA-65 full-access key and no additional access keys. This account does not meet that requirement';
  if (!pq.length) return { problem: `${rule}: it has no ML-DSA-65 key yet.`, fix: { kind: 'add' } };
  if (pq.length !== 1 || pq[0]!.access_key.permission !== 'FullAccess') return { problem: `${rule}: it should hold exactly one ML-DSA-65 key, with full access.` };
  const others = keys.filter((k) => !isPq(k)).map((k) => k.public_key);
  if (others.length) {
    const removable = others.every((k) => /^(ed25519|secp256k1):/.test(k));
    const full = keys.some((k) => !isPq(k) && k.access_key.permission === 'FullAccess');
    const what = full ? 'it still has a classical full-access key, which could move the QTC' : `it still has ${others.length === 1 ? 'another key' : `${others.length} other keys`}`;
    return { problem: `${rule}: ${what}.`, ...(removable ? { fix: { kind: 'remove' as const, keys: others } } : {}) };
  }
  return { handle: keyHandle(pq[0]!.public_key), block: Number(r.result.block_height) };
}
export const directBalance = (account: string) => nearView<string>(ROUTE.bridge, 'ft_balance_of', { account_id: account });

export interface BridgeState { supply: string; receipts: number; redemptions: number; attesters: string[]; quantus_genesis: string }
export const bridgeState = () => nearView<BridgeState>(ROUTE.bridge, 'state');
export const intentsBalance = (account: string) => nearView<string>(ROUTE.verifier, 'mt_balance_of', { account_id: account, token_id: tokenId });
export const depositMinted = (id: string) => nearView<boolean>(ROUTE.bridge, 'deposit', { deposit_id: id });

async function worker<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(ROUTE.worker + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Route service: ${body.error ?? res.status}`);
  return body as T;
}
export const postRequest = (sealed: Uint8Array) => worker<{ id: string }>('/requests', { method: 'POST', body: sealed as BodyInit });
export async function getRequest(id: string): Promise<Uint8Array> {
  const res = await fetch(`${ROUTE.worker}/requests/${id}`);
  if (!res.ok) throw new Error('Route service: this request is unknown or has expired');
  return new Uint8Array(await res.arrayBuffer());
}
export async function mintPointer(depositId: string): Promise<{ tx: string; signer: string } | null> {
  const res = await fetch(`${ROUTE.worker}/mints/${depositId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Route service: mint record unavailable');
  return res.json();
}
/** A NEAR testnet transaction at FINAL, read from the RPC (not from the route service). */
export async function nearTx(hash: string, signer: string): Promise<unknown> {
  const res = await fetch(ROUTE.nearRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' } }) });
  const j = await res.json();
  if (!j.result) throw new Error('NEAR testnet: transaction not readable yet');
  return j.result;
}
export const postClaim = (claim: unknown) => worker<{ queued: true }>('/claims', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) });
export const sponsorAccount = (publicKey: string) => worker<{ accountId: string; tx: string; failure?: string }>('/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey }) });

/** This browser's route wallet: a 32-byte seed in local storage; the backup is the seed itself. */
const KEY = 'qlyphs:pq-route:seed';
export function loadSeed(): Uint8Array | null {
  const h = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  return h && /^[0-9a-f]{64}$/.test(h) ? rc.unhex(h) : null;
}
export function saveSeed(seed: Uint8Array) { localStorage.setItem(KEY, toHex(seed)); }
export function newSeed(): Uint8Array { const s = crypto.getRandomValues(new Uint8Array(32)); saveSeed(s); return s; }
export const seedHex = toHex;

/** A card as one copyable line: "qpq1:" + base64url(JSON). */
export const encodeCard = (c: rc.Card) => 'qpq1:' + btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function decodeCard(s: string): rc.Card {
  const t = s.trim();
  if (!t.startsWith('qpq1:')) throw new Error('Not a route card: it starts with qpq1:');
  const c = JSON.parse(atob(t.slice(5).replace(/-/g, '+').replace(/_/g, '/')));
  if (!/^[0-9a-f]+$/.test(c.kem) || !/^[0-9a-f]+$/.test(c.id) || c.kem.length !== 3136 || c.id.length !== 5184) throw new Error('This card is damaged');
  return c;
}

/**
 * A pay link: the payer's ML-KEM-1024 encapsulation key in the link's fragment, which is all a requester needs to
 * encrypt a request for them. A wrong key only makes a request its payer cannot open: where the QTC goes is pinned
 * by the payment link the requester sends back, never by this one.
 */
export const payerFragment = (c: rc.Card) => btoa(String.fromCharCode(...rc.unhex(c.kem))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** The payer named by a pay link, or by a whole route card ("qpq1:…"). Throws when the text is neither. */
export function decodePayer(text: string): rc.Card {
  const t = text.trim();
  if (t.startsWith('qpq1:')) return decodeCard(t);
  const m = t.match(/[#&]to=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Paste the pay link they sent you');
  let kem: Uint8Array;
  try { kem = Uint8Array.from(atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); } catch { throw new Error('This pay link is damaged'); }
  if (kem.length !== 1568) throw new Error('This pay link is damaged: copy it again');
  return { v: rc.VERSION, kem: toHex(kem), id: '' };
}
/** A short label for a payer's key, for two people to compare. Never an identity check. */
export function keyLabel(c: rc.Card): string {
  const h = toHex(sha256(rc.unhex(c.kem))).slice(0, 8);
  return `${h.slice(0, 4)} ${h.slice(4)}`;
}
export { rc };
