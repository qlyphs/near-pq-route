// A pay link carries the payer's ML-KEM-1024 key only, and a request sealed to it opens for that payer alone.
// Run: node --test pay-link.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePayer, keyLabel, payerFragment, rc } from './route.ts';

const wallet = (n: number) => rc.wallet(new Uint8Array(32).fill(n));
const O = { network: 'testnet', sponsor: 's.testnet' };

test('a pay link round-trips the payer key and fits a chat message', () => {
  const payer = wallet(1), link = `https://app.example/bridge/quantum#to=${payerFragment(rc.card(payer))}`;
  assert.ok(link.length < 2200);
  const card = decodePayer(link);
  assert.equal(card.kem, rc.card(payer).kem);
  assert.equal(keyLabel(card), keyLabel(rc.card(payer)));
});
test('a request sealed from a pay link opens for the payer, pinned to the requester, and for nobody else', () => {
  const payer = wallet(1), asker = wallet(2), other = wallet(3);
  const { sealed } = rc.createRequest(asker, decodePayer(`x#to=${payerFragment(rc.card(payer))}`), { ...O, amountPlanck: 10n ** 12n, memo: 'hi', expiresAt: Date.now() + 60_000 });
  const r = rc.openRequestPinned(payer, sealed, { pin: rc.cardPin(rc.card(asker)), ...O });
  assert.equal(r.amount, String(10n ** 12n));
  assert.equal(r.memo, 'hi');
  assert.throws(() => rc.openRequestPinned(other, sealed, { pin: rc.cardPin(rc.card(asker)), ...O }));
  assert.throws(() => rc.openRequestPinned(payer, sealed, { pin: rc.cardPin(rc.card(other)), ...O }));
});
test('damaged or foreign text is refused', () => {
  assert.throws(() => decodePayer('https://app.example/bridge/quantum'), /pay link/);
  assert.throws(() => decodePayer('x#to=AAAA'), /damaged/);
});
