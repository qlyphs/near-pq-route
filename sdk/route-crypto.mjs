// Payment requests and receipts for the post-quantum QTC route (docs/ROUTE.md): one backup seed per wallet,
// ML-KEM-1024 + AES-256-GCM for every request, ML-DSA-87 for the recipient's signature on it, a fresh
// ML-DSA-65 NEAR account per payment that only the recipient can derive, and fixed-size encrypted receipts
// the wallet finds again from its seed alone. Pure functions; runs in Node and in browsers.
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { kmac256 } from '@noble/hashes/sha3-addons.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { signerFromSeed } from '@fastnear/ml-dsa-65';

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
export const cardFingerprint = (c) => hex(sha256(cat(unhex(c.kem), unhex(c.id)))).slice(0, 16);

/** Per payment: the ML-DSA-65 signer of a fresh NEAR account and the receipt key, both from (network, rid). */
export function paymentKeys(w, network, rid) {
  if (rid.length !== 32) throw new Error('rid is 32 bytes');
  const spendSeed = kdf(w.spendRoot, 'spend', [network, rid]);
  const receiptKey = kdf(w.scanRoot, 'receipt', [network, rid]);
  return { signer: signerFromSeed(spendSeed), receiptKey };
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
  const { receiptKey } = paymentKeys(w, network, rid);
  try {
    const plain = gcm(receiptKey, nonce, cat(te('qlyphs/route/receipt'), rid)).decrypt(receipt.subarray(44));
    const n = plain[0] | plain[1] << 8;
    return { rid: Uint8Array.from(rid), body: JSON.parse(dec.decode(plain.subarray(2, 2 + n))) };
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

/** The payer opens a request with its own wallet and checks the recipient's signature. Throws on anything wrong. */
export function openRequest(payer, sealed, { now = Date.now(), expectRecipient } = {}) {
  const magic = te('QLYPREQ1');
  if (sealed.length < 8 + 1568 + 12 + 16 || dec.decode(sealed.subarray(0, 8)) !== 'QLYPREQ1') throw new Error('not a payment request');
  const ct = sealed.subarray(8, 8 + 1568), nonce = sealed.subarray(8 + 1568, 8 + 1568 + 12);
  const key = kdf(ml_kem1024.decapsulate(ct, payer.kem.secretKey), 'request-key');
  const plain = gcm(key, nonce, cat(magic, sha256(payer.kem.publicKey))).decrypt(sealed.subarray(8 + 1568 + 12));
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
  const body = plain.subarray(4, 4 + n), sig = plain.subarray(4 + n);
  const request = JSON.parse(dec.decode(body));
  if (!ml_dsa87.verify(sig, body, unhex(request.recipient.id), { context: te('qlyphs/route/request') })) throw new Error('the recipient signature does not verify');
  if (expectRecipient && cardFingerprint(request.recipient) !== expectRecipient) throw new Error('the request is from someone else');
  if (request.expiresAt && now > request.expiresAt) throw new Error('the request has expired');
  if (unhex(request.receipt).length !== RECEIPT_LEN) throw new Error('bad receipt size');
  if (!/^r[0-9a-f]{20}\./.test(request.account) || request.account !== accountFor(request.accountKey, request.account.slice(22))) throw new Error('the account does not match its key');
  return request;
}

/** Restore: from the seed alone, find this wallet's payments among everyone's public receipts. */
export function findPayments(w, network, receipts) {
  const out = [];
  for (const r of receipts) {
    const hit = openReceipt(w, network, r);
    if (hit) out.push({ ...hit, receipt: r });
  }
  return out;
}
