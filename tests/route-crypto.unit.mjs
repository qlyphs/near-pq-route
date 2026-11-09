// Unit tests for sdk/route-crypto.mjs: request sealing and opening, signature and recipient checks, tampering,
// fixed-size receipts, restore from the seed alone, and that the payer cannot derive the spending key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wallet, card, cardPin, cardFingerprint, createRequest, openRequest as open0, openRequestPinned, findPayments, paymentKeys, accountFor, unhex, RECEIPT_LEN } from '../sdk/route-crypto.mjs';

const seed = (b) => new Uint8Array(32).fill(b);
const alice = wallet(seed(1)), bob = wallet(seed(2)), eve = wallet(seed(3));
const openRequest = (payer, sealed, o = {}) => open0(payer, sealed, { recipient: card(alice), network: 'testnet', sponsor: SPONSOR, ...o });
const SPONSOR = 'qlyphs-pqroute-c.testnet';
const opts = { network: 'testnet', sponsor: 'qlyphs-pqroute-c.testnet', amountPlanck: 5_000_000_000_000n, memo: 'invoice 42', expiresAt: Date.now() + 3600e3 };

test('a wallet is fully determined by its seed', () => {
  assert.deepEqual(card(wallet(seed(1))), card(alice));
  assert.notDeepEqual(card(alice), card(bob));
});

test('the payer opens a request sealed to it and sees the signed fields', () => {
  const { sealed, account } = createRequest(alice, card(bob), opts);
  const r = openRequest(bob, sealed);
  assert.equal(r.account, account);
  assert.equal(r.amount, '5000000000000');
  assert.equal(r.memo, 'invoice 42');
  assert.equal(unhex(r.receipt).length, RECEIPT_LEN);
});

test('nobody else can open it', () => {
  const { sealed } = createRequest(alice, card(bob), opts);
  assert.throws(() => openRequest(eve, sealed));
});

test('any changed byte is refused', () => {
  const { sealed } = createRequest(alice, card(bob), opts);
  for (const i of [10, 8 + 1568 + 3, sealed.length - 1]) { const t = Uint8Array.from(sealed); t[i] ^= 1; assert.throws(() => openRequest(bob, t)); }
});

test('a correctly sealed, self-signed request from someone else is refused', () => {
  const { sealed } = createRequest(eve, card(bob), opts);
  assert.throws(() => openRequest(bob, sealed), /someone else/);
});

test('opening without a pinned recipient card, network or sponsor is refused', () => {
  const { sealed } = createRequest(alice, card(bob), opts);
  assert.throws(() => open0(bob, sealed, { network: 'testnet', sponsor: SPONSOR }), /pin the recipient/);
  assert.throws(() => open0(bob, sealed, { recipient: card(alice) }), /expected network/);
  assert.throws(() => openRequest(bob, sealed, { network: 'mainnet' }), /another network/);
  assert.throws(() => openRequest(bob, sealed, { sponsor: 'other.testnet' }), /does not match its key and sponsor/);
});

test('an oversized request is refused before decrypting, and restore needs the sponsor', () => {
  assert.throws(() => openRequest(bob, new Uint8Array(40 * 1024)), /too large/);
  assert.throws(() => findPayments(alice, 'testnet', []), /sponsor/);
});

test('a request without an expiry is refused', () => {
  const { sealed } = createRequest(alice, card(bob), { ...opts, expiresAt: undefined });
  assert.throws(() => openRequest(bob, sealed), /expired or has no expiry/);
});

test('an expired request is refused', () => {
  const { sealed } = createRequest(alice, card(bob), { ...opts, expiresAt: Date.now() - 1 });
  assert.throws(() => openRequest(bob, sealed), /expired/);
});

test('every request gets a fresh account', () => {
  const a = createRequest(alice, card(bob), opts).account, b = createRequest(alice, card(bob), opts).account;
  assert.notEqual(a, b);
});

test('restore: the seed alone finds the payments among everyone else\'s receipts', () => {
  const mine = [createRequest(alice, card(bob), opts), createRequest(alice, card(eve), opts)];
  const others = [createRequest(bob, card(alice), opts), createRequest(eve, card(alice), opts)];
  const opener = (x) => (x === mine[0] ? [bob, card(alice)] : x === mine[1] ? [eve, card(alice)] : x === others[0] ? [alice, card(bob)] : [alice, card(eve)]);
  const pub = [...others, ...mine].map((x) => { const [p, rc] = opener(x); return unhex(openRequest(p, x.sealed, { recipient: rc }).receipt); });
  pub.push(pub.at(-1)); // a copied receipt is counted once
  const restored = wallet(seed(1));
  const found = findPayments(restored, 'testnet', pub, SPONSOR);
  assert.deepEqual(found.map((f) => f.body.account).sort(), mine.map((m) => m.account).sort());
  for (const f of found) {
    const { signer } = paymentKeys(restored, 'testnet', f.rid);
    assert.equal(accountFor(signer.publicKey, opts.sponsor), f.body.account);
    signer.destroy();
  }
  assert.equal(findPayments(eve, 'testnet', pub.slice(2), SPONSOR).length, 0);
  assert.equal(findPayments(restored, 'mainnet', pub, SPONSOR).length, 0);
});

test('the payer learns the account and its public key, not the key that spends it', () => {
  const { sealed, rid } = createRequest(alice, card(bob), opts);
  const r = openRequest(bob, sealed);
  const { signer } = paymentKeys(bob, 'testnet', rid);
  assert.notEqual(signer.publicKey, r.accountKey);
  signer.destroy();
});

test('another network derives other accounts', () => {
  const rid = new Uint8Array(32).fill(9);
  const a = paymentKeys(alice, 'testnet', rid).signer, b = paymentKeys(alice, 'mainnet', rid).signer;
  assert.notEqual(a.publicKey, b.publicKey); a.destroy(); b.destroy();
});

test('a payment link pins the recipient by the full hash of its card', () => {
  const { sealed, account } = createRequest(alice, card(bob), opts);
  const r = openRequestPinned(bob, sealed, { pin: cardPin(card(alice)), network: 'testnet', sponsor: SPONSOR });
  assert.equal(r.account, account);
  assert.equal(cardPin(card(alice)).length, 64);
  assert.notEqual(cardPin(card(alice)), cardPin(card(eve)));
  assert.ok(cardPin(card(alice)).length > cardFingerprint(card(alice)).length, 'the pin is the full hash, not the display label');
});

test('a request service that swaps in another recipient\'s request for the same payer is refused by the pin', () => {
  // Eve makes a valid request to Bob; the service hands it out under a link that pins Alice.
  const { sealed } = createRequest(eve, card(bob), opts);
  assert.throws(() => openRequestPinned(bob, sealed, { pin: cardPin(card(alice)), network: 'testnet', sponsor: SPONSOR }), /someone else/);
});

test('a link without a well-formed pin opens nothing', () => {
  const { sealed } = createRequest(alice, card(bob), opts);
  for (const pin of [undefined, '', cardFingerprint(card(alice)), 'zz'.repeat(32)]) {
    assert.throws(() => openRequestPinned(bob, sealed, { pin, network: 'testnet', sponsor: SPONSOR }), /pin/);
  }
});

test('the pinned open keeps every other check: expiry, network and signature', () => {
  const old = createRequest(alice, card(bob), { ...opts, expiresAt: Date.now() - 1 });
  assert.throws(() => openRequestPinned(bob, old.sealed, { pin: cardPin(card(alice)), network: 'testnet', sponsor: SPONSOR }), /expired/);
  const { sealed } = createRequest(alice, card(bob), opts);
  assert.throws(() => openRequestPinned(bob, sealed, { pin: cardPin(card(alice)), network: 'mainnet', sponsor: SPONSOR }), /network/);
});
