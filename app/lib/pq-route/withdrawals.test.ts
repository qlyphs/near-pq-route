// One release on Quantus is counted for one withdrawal only, oldest first, across repeated balance reads.
// Run: node --test withdrawals.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markArrivals, type Withdrawal } from './withdrawals.ts';

const D = '0x' + 'ab'.repeat(32);
const w = (at: number, baseline: string | null, dest = D): Withdrawal => ({ account: `r${at}.x.testnet`, tx: `tx${at}`, amount: '100', dest, at, baseline });
const arrived = (l: Withdrawal[]) => l.filter((x) => x.arrivedAt).map((x) => x.at);

test('nothing arrives while the balance has not moved', () => {
  assert.deepEqual(arrived(markArrivals([w(1, '1000')], D, 1000n, 9)), []);
  assert.deepEqual(arrived(markArrivals([w(1, '1000')], D, 1099n, 9)), []);
});
test('one release marks only the oldest of two withdrawals, also on the next read', () => {
  let l = markArrivals([w(2, '1000'), w(1, '1000')], D, 1100n, 9);
  assert.deepEqual(arrived(l), [1]);
  l = markArrivals(l, D, 1100n, 10);
  assert.deepEqual(arrived(l), [1]);
  l = markArrivals(l, D, 1200n, 11);
  assert.deepEqual(arrived(l), [1, 2]);
});
test('two releases seen at once mark both', () => {
  assert.deepEqual(arrived(markArrivals([w(1, '1000'), w(2, '1000')], D, 1200n, 9)), [1, 2]);
});
test('a later baseline that already includes the first release stands', () => {
  let l = markArrivals([w(1, '1000'), w(2, '1100')], D, 1100n, 9);
  assert.deepEqual(arrived(l), [1]);
  l = markArrivals(l, D, 1200n, 10);
  assert.deepEqual(arrived(l), [1, 2]);
});
test('other destinations and unreadable baselines are left alone', () => {
  const other = '0x' + 'cd'.repeat(32);
  assert.deepEqual(arrived(markArrivals([w(1, '0', other), w(2, null)], D, 10n ** 9n, 9)), []);
});
