// An account opened in another wallet (Meteor) is known on NEAR only by its key's handle. The route commits to that
// handle, so it is the same bytes whether it is given the full key or the handle, and another key gives other bytes.
// Run: node --test meteor-route.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSigner, publicKeyToHandle } from '@fastnear/ml-dsa-65';
import { encodeRoute, keyHandle, postQuantumKey } from './route.ts';

const dep = 'ab'.repeat(32);

test('the full key and its NEAR handle give the same route', () => {
  const k1 = generateSigner(), k2 = generateSigner();
  try {
    const h1 = publicKeyToHandle(k1.publicKey as never);
    assert.equal(keyHandle(k1.publicKey), h1);
    assert.equal(keyHandle(h1), h1);
    const full = encodeRoute(dep, 'alice.testnet', true, '', k1.publicKey);
    assert.deepEqual(encodeRoute(dep, 'alice.testnet', true, '', h1), full);
    assert.notDeepEqual(encodeRoute(dep, 'alice.testnet', true, '', publicKeyToHandle(k2.publicKey as never)), full);
  } finally { k1.destroy(); k2.destroy(); }
});

test('anything but an ML-DSA-65 key or handle is refused', () => {
  for (const bad of ['ed25519:3Kq', 'ml-dsa-65-hash:abc', 'secp256k1:x', '', 'ml-dsa-65-hash:' + 'z'.repeat(44), 'ml-dsa-65-hash:' + '1'.repeat(43)]) assert.throws(() => keyHandle(bad));
});

// What the page offers for a Meteor account that cannot receive yet: add an ML-DSA-65 key in Meteor, or remove the
// classical keys left beside one. A post-quantum key is never offered for removal.
const PQ = 'ml-dsa-65-hash:' + '2'.repeat(43), ED = 'ed25519:' + '3'.repeat(43), ED2 = 'ed25519:' + '4'.repeat(43);
async function keysOf(list: { public_key: string; access_key: { permission: unknown } }[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: { keys: list, block_height: 7 } }))) as typeof fetch;
  try { return await postQuantumKey('alice.testnet'); } finally { globalThis.fetch = real; }
}
const full = (public_key: string) => ({ public_key, access_key: { permission: 'FullAccess' as unknown } });
const fnCall = (public_key: string) => ({ public_key, access_key: { permission: { FunctionCall: { receiver_id: 'x.testnet', method_names: [] } } as unknown } });

test('an account without an ML-DSA-65 key is told to add one', async () => {
  assert.deepEqual((await keysOf([full(ED)]) as { fix?: unknown }).fix, { kind: 'add' });
});
test('classical keys beside the one ML-DSA-65 key are offered for removal, and only they', async () => {
  const r = await keysOf([full(ED), full(PQ), fnCall(ED2)]) as { fix?: { kind: string; keys: string[] } };
  assert.deepEqual(r.fix, { kind: 'remove', keys: [ED, ED2] });
});
test('two ML-DSA-65 keys, or one without full access, get no automatic fix', async () => {
  assert.equal((await keysOf([full(PQ), full(PQ.replace(/2/g, '5'))]) as { fix?: unknown }).fix, undefined);
  assert.equal((await keysOf([fnCall(PQ)]) as { fix?: unknown }).fix, undefined);
});
test('exactly one ML-DSA-65 full-access key is accepted', async () => {
  const k = generateSigner();
  try {
    const h = publicKeyToHandle(k.publicKey as never);
    const r = await keysOf([full(h)]);
    assert.ok('handle' in r && r.handle === h && r.block === 7);
  } finally { k.destroy(); }
});
