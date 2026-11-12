// Payment requests and receipts for the post-quantum QTC route (qlyphs-pq87-near docs/ROUTE.md; same bytes as its sdk/route-crypto.mjs): one backup seed per wallet,
// ML-KEM-1024 + AES-256-GCM for every request, ML-DSA-87 for the recipient's signature on it, a fresh
// ML-DSA-65 NEAR account per payment that only the recipient can derive, and fixed-size encrypted receipts
// the wallet finds again from its seed alone. Pure functions; runs in Node and in browsers.
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { kmac256 } from '@noble/hashes/sha3-addons.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { decodePublicKey, signerFromSeed } from '@fastnear/ml-dsa-65';

export const VERSION = 1;
const enc = new TextEncoder(), dec = new TextDecoder();
const te = (s) => enc.encode(s);
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => { if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error('bad hex'); return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16)); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
/** Unambiguous encoding: each field length-prefixed. */
const fields = (...xs) => cat(...xs.map((x) => { const b = typeof x === 'string' ? te(x) : x; return cat(u32(b.length), b); }));
const kdf = (key, label, parts = [], len = 32) => kmac256(key, fields(...parts), { personalization: te(`qlyphs/route/v${VERSION}/${label}`), dkLen: len });
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Everything a wallet derives from its 32-byte backup seed. Nothing else needs to be stored. */
export function wallet(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('the backup seed is 32 bytes');
  const kem = ml_kem1024.keygen(kdf(seed, 'kem', [], 64));
  const id = ml_dsa87.keygen(kdf(seed, 'identity', [], 32));
  return { seed, kem, id, spendRoot: kdf(seed, 'spend'), scanRoot: kdf(seed, 'scan') };
}
/** The public card a payer needs: ML-KEM-1024 encapsulation key and ML-DSA-87 identity key. */
export const card = (w) => ({ v: VERSION, kem: hex(w.kem.publicKey), id: hex(w.id.publicKey) });
/** A short label for showing a card to a person. Never an identity check: compare whole cards with sameCard. */
export const cardFingerprint = (c) => hex(sha256(cat(unhex(c.kem), unhex(c.id)))).slice(0, 16);
export const sameCard = (a, b) => !!a && !!b && a.v === b.v && a.kem === b.kem && a.id === b.id;
/** A card's full SHA-256 (64 hex): what a payment link carries so the payer can pin the recipient without pasting the card. */
export const cardPin = (c) => hex(sha256(cat(te(`qlyphs/route/card/v${c.v}`), unhex(c.kem), unhex(c.id))));

/** Per request: the receipt key only, from (network, rid). Scanning uses this and never touches spending keys. */
export function receiptKeyFor(w, network, rid) {
  if (rid.length !== 32) throw new Error('rid is 32 bytes');
  return kdf(w.scanRoot, 'receipt', [network, rid]);
}
/** Per request: the ML-DSA-65 signer of its fresh NEAR account and the receipt key. Destroy the signer after use. */
export function paymentKeys(w, network, rid) {
  if (rid.length !== 32) throw new Error('rid is 32 bytes');
  return { signer: signerFromSeed(kdf(w.spendRoot, 'spend', [network, rid])), receiptKey: receiptKeyFor(w, network, rid) };
}
/** The fresh account's name: derived from its ML-DSA-65 public key, under the sponsor that creates it. */
export function accountFor(publicKey, sponsor) {
  const raw = typeof publicKey === 'string' ? te(publicKey) : publicKey;
  return `r${hex(sha256(raw)).slice(0, 20)}.${sponsor}`;
}

const RECEIPT_PLAIN = 224; // fixed: every receipt has the same size
export const RECEIPT_LEN = 32 + 12 + RECEIPT_PLAIN + 16;
/** rid | nonce | AES-256-GCM(receipt key, padded JSON). The rid is random and says nothing about the owner. */
export function sealReceipt(receiptKey, rid, body) {
  const json = te(JSON.stringify(body));
  if (json.length > RECEIPT_PLAIN - 2) throw new Error('receipt body too long');
  const plain = new Uint8Array(RECEIPT_PLAIN); plain.set([json.length & 255, json.length >> 8]); plain.set(json, 2);
  const nonce = random(12);
  return cat(rid, nonce, gcm(receiptKey, nonce, cat(te('qlyphs/route/receipt'), rid)).encrypt(plain));
}
/** Tries one public receipt with this wallet; returns { rid, body } or null. */
export function openReceipt(w, network, receipt) {
  if (receipt.length !== RECEIPT_LEN) return null;
  const rid = receipt.subarray(0, 32), nonce = receipt.subarray(32, 44);
  const receiptKey = receiptKeyFor(w, network, rid);
  try {
    const plain = gcm(receiptKey, nonce, cat(te('qlyphs/route/receipt'), rid)).decrypt(receipt.subarray(44));
    const n = plain[0] | plain[1] << 8;
    const body = JSON.parse(dec.decode(plain.subarray(2, 2 + n)));
    if (body?.v !== VERSION || body.network !== network) return null;
    return { rid: Uint8Array.from(rid), body };
  } catch { return null; }
}

/**
 * The recipient makes a payment request for one payer: a fresh account, its receipt, the amount, signed with
 * the recipient's ML-DSA-87 identity, then sealed to the payer's ML-KEM-1024 key. Returns the sealed bytes
 * and what the recipient keeps (nothing secret: the wallet re-derives it from the seed and the rid).
 */
export function createRequest(w, payerCard, { network, sponsor, amountPlanck, memo = '', expiresAt }) {
  const rid = random(32);
  const { signer, receiptKey } = paymentKeys(w, network, rid);
  try {
    const account = accountFor(signer.publicKey, sponsor);
    const receipt = sealReceipt(receiptKey, rid, { v: VERSION, network, account, amount: String(amountPlanck), memo });
    const request = { v: VERSION, network, account, accountKey: signer.publicKey, amount: String(amountPlanck), memo, expiresAt, receipt: hex(receipt), recipient: card(w) };
    const body = te(JSON.stringify(request));
    const sig = ml_dsa87.sign(body, w.id.secretKey, { context: te('qlyphs/route/request') });
    const { cipherText, sharedSecret } = ml_kem1024.encapsulate(unhex(payerCard.kem));
    const key = kdf(sharedSecret, 'request-key'), nonce = random(12);
    const aad = cat(te('QLYPREQ1'), sha256(unhex(payerCard.kem)));
    const sealed = cat(te('QLYPREQ1'), cipherText, nonce, gcm(key, nonce, aad).encrypt(cat(u32(body.length), body, sig)));
    return { sealed, rid, account };
  } finally { signer.destroy(); }
}

const U128_MAX = (1n << 128n) - 1n;
/** The largest sealed request anyone needs (a request is about 18 KB); larger ones are refused before decrypting. */
export const MAX_REQUEST = 32 * 1024;
/**
 * The payer opens a request with its own wallet. `recipient` is the recipient's whole card, obtained by the payer
 * on its own (never taken from the request): the signature is checked against that pinned card. `network` and
 * `sponsor` are what the payer expects. Throws on anything wrong.
 */
/** Decrypts a sealed request for this payer; nothing in it is trusted until openRequest has checked it. */
function unseal(payer, sealed) {
  const magic = te('QLYPREQ1');
  if (sealed.length > MAX_REQUEST) throw new Error('payment request too large');
  if (sealed.length < 8 + 1568 + 12 + 16 || dec.decode(sealed.subarray(0, 8)) !== 'QLYPREQ1') throw new Error('not a payment request');
  const ct = sealed.subarray(8, 8 + 1568), nonce = sealed.subarray(8 + 1568, 8 + 1568 + 12);
  const key = kdf(ml_kem1024.decapsulate(ct, payer.kem.secretKey), 'request-key');
  const plain = gcm(key, nonce, cat(magic, sha256(payer.kem.publicKey))).decrypt(sealed.subarray(8 + 1568 + 12));
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
  if (n > plain.length - 4) throw new Error('not a payment request');
  const body = plain.subarray(4, 4 + n), sig = plain.subarray(4 + n);
  return { body, sig, request: JSON.parse(dec.decode(body)) };
}

/**
 * Opens a request whose recipient is pinned by the card's full hash (cardPin), as carried by the payment link,
 * instead of by a pasted card. The card named inside the request must hash to the pin; then every check of
 * openRequest applies, the recipient's ML-DSA-87 signature included. The request service cannot substitute
 * a request from another recipient, because it never sees the pin (it travels in the link's fragment).
 */
export function openRequestPinned(payer, sealed, { pin, network, sponsor, now = Date.now() } = {}) {
  if (!/^[0-9a-f]{64}$/.test(pin ?? '')) throw new Error('the link carries no recipient pin');
  const { request } = unseal(payer, sealed);
  const c = request?.recipient;
  if (!c || typeof c.kem !== 'string' || typeof c.id !== 'string' || !/^[0-9a-f]+$/.test(c.kem + c.id)) throw new Error('the request names no recipient card');
  if (cardPin(c) !== pin) throw new Error('the request is from someone else');
  return openRequest(payer, sealed, { recipient: { v: c.v, kem: c.kem, id: c.id }, network, sponsor, now });
}

export function openRequest(payer, sealed, { recipient, network, sponsor, now = Date.now() } = {}) {
  if (!recipient?.kem || !recipient?.id) throw new Error('pin the recipient\'s card before opening a request');
  if (!network || !sponsor) throw new Error('give the expected network and sponsor');
  const { body, sig, request } = unseal(payer, sealed);
  if (!sameCard(request.recipient, recipient)) throw new Error('the request is from someone else');
  if (!ml_dsa87.verify(sig, body, unhex(recipient.id), { context: te('qlyphs/route/request') })) throw new Error('the recipient signature does not verify');
  if (request.v !== VERSION || request.network !== network) throw new Error('the request is for another network or version');
  if (typeof request.expiresAt !== 'number' || !Number.isFinite(request.expiresAt) || now > request.expiresAt) throw new Error('the request has expired or has no expiry');
  if (!/^[1-9][0-9]{0,38}$/.test(request.amount) || BigInt(request.amount) > U128_MAX) throw new Error('bad amount');
  if (typeof request.accountKey !== 'string' || decodePublicKey(request.accountKey).length !== 1952) throw new Error('bad account key');
  if (request.account !== accountFor(request.accountKey, sponsor)) throw new Error('the account does not match its key and sponsor');
  if (unhex(request.receipt).length !== RECEIPT_LEN) throw new Error('bad receipt size');
  return request;
}

/**
 * Restore: from the seed alone, find this wallet's requests among everyone's public receipts. A receipt only says a
 * request was made; whether it was paid, and where the tokens are, comes from the chain. Each rid is kept once, and
 * its account is derived again and must match the receipt.
 */
export function findPayments(w, network, receipts, sponsor) {
  if (!sponsor) throw new Error('give the sponsor the accounts were opened under');
  const out = [], seen = new Set();
  for (const r of receipts) {
    const hit = openReceipt(w, network, r);
    if (!hit) continue;
    const id = hex(hit.rid);
    if (seen.has(id)) continue;
    const { signer } = paymentKeys(w, network, hit.rid);
    try { if (accountFor(signer.publicKey, sponsor) !== hit.body.account) continue; } finally { signer.destroy(); }
    seen.add(id);
    out.push({ ...hit, receipt: r });
  }
  return out;
}
