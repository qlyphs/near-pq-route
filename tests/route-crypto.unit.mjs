// Unit tests for sdk/route-crypto.mjs: request sealing and opening, signature and recipient checks, tampering,
// fixed-size receipts, restore from the seed alone, and that the payer cannot derive the spending key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wallet, card, cardFingerprint, createRequest, openRequest, findPayments, paymentKeys, accountFor, unhex, RECEIPT_LEN } from '../sdk/route-crypto.mjs';

const seed = (b) => new Uint8Array(32).fill(b);
const alice = wallet(seed(1)), bob = wallet(seed(2)), eve = wallet(seed(3));
const opts = { network: 'testnet', sponsor: 'qlyphs-pqroute-c.testnet', amountPlanck: 5_000_000_000_000n, memo: 'invoice 42', expiresAt: Date.now() + 3600e3 };

test('a wallet is fully determined by its seed', () => {
  assert.deepEqual(card(wallet(seed(1))), card(alice));
  assert.notDeepEqual(card(alice), card(bob));
});

test('the payer opens a request sealed to it and sees the signed fields', () => {
  const { sealed, account } = createRequest(alice, card(bob), opts);
  const r = openRequest(bob, sealed, { expectRecipient: cardFingerprint(card(alice)) });
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

test('a request signed by someone else is refused when the recipient is pinned', () => {
  const { sealed } = createRequest(eve, card(bob), opts);
  assert.throws(() => openRequest(bob, sealed, { expectRecipient: cardFingerprint(card(alice)) }), /someone else/);
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
  const pub = [...others, ...mine].map((x) => unhex(openRequest(x === mine[1] ? eve : x === others[0] || x === others[1] ? alice : bob, x.sealed).receipt));
  const restored = wallet(seed(1));
  const found = findPayments(restored, 'testnet', pub);
  assert.deepEqual(found.map((f) => f.body.account).sort(), mine.map((m) => m.account).sort());
  for (const f of found) {
    const { signer } = paymentKeys(restored, 'testnet', f.rid);
    assert.equal(accountFor(signer.publicKey, opts.sponsor), f.body.account);
    signer.destroy();
  }
  assert.equal(findPayments(eve, 'testnet', pub.slice(2)).length, 0);
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
