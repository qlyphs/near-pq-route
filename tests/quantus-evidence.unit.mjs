// What verify-quantus.mjs accepts as a lock deposit or a release, on synthetic events: real transfers pass; bytes that
// only look like a transfer, an outer success over a failed inner call, a transfer under another extrinsic, a wrong
// amount, destination or approver set, and duplicated records all fail.
// Run: node --test tests/quantus-evidence.unit.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatched, firstDuplicate, lockDeposit, lockRelease, transferCall } from '../scripts/lib/quantus-evidence.mjs';

const LOCK = '0x' + 'da'.repeat(32), ALICE = '0x' + '0a'.repeat(32), DEST = '0x' + 'de'.repeat(32), OTHER = '0x' + '07'.repeat(32);
const S = ['0x' + '01'.repeat(32), '0x' + '02'.repeat(32), '0x' + '03'.repeat(32)];
const ok = { section: 'system', method: 'ExtrinsicSuccess', data: {} };
const failed = { section: 'system', method: 'ExtrinsicFailed', data: {} };
const transfer = (from, to, amount) => ({ section: 'balances', method: 'Transfer', data: { from, to, amount: String(amount) } });
const executed = (over = {}) => ({ section: 'multisig', method: 'ProposalExecuted', data: { multisig_address: LOCK, proposal_id: '11', proposer: S[0], call: transferCall(DEST, 1000n), approvers: [S[0], S[1]], result: { ok: null }, ...over } });
const release = { lock: LOCK, signers: S, threshold: 2, destination: DEST, planck: '1000', call: transferCall(DEST, 1000n) };

test('a real lock transfer counts', () => {
  assert.deepEqual(lockDeposit([transfer(ALICE, LOCK, 1000), ok], { lock: LOCK, planck: '1000' }), { ok: true, from: ALICE });
});

test('a remark carrying transfer bytes is not a deposit', () => {
  const remark = [{ section: 'system', method: 'Remarked', data: { sender: ALICE, hash: '0x' + '00'.repeat(32) } }, ok];
  assert.equal(lockDeposit(remark, { lock: LOCK, planck: '1000' }).ok, false);
});

test('a deposit of another amount, to another account, or that failed does not count', () => {
  assert.equal(lockDeposit([transfer(ALICE, LOCK, 999), ok], { lock: LOCK, planck: '1000' }).ok, false);
  assert.equal(lockDeposit([transfer(ALICE, OTHER, 1000), ok], { lock: LOCK, planck: '1000' }).ok, false);
  assert.equal(lockDeposit([transfer(ALICE, LOCK, 1000), failed], { lock: LOCK, planck: '1000' }).ok, false);
  assert.equal(lockDeposit([transfer(ALICE, LOCK, 1000)], { lock: LOCK, planck: '1000' }).ok, false);
});

test('a transfer under another extrinsic index is not this extrinsic\'s evidence', () => {
  // The caller passes only the events of ApplyExtrinsic(index); a matching transfer elsewhere never reaches here.
  assert.equal(lockDeposit([ok], { lock: LOCK, planck: '1000' }).ok, false);
  assert.equal(lockRelease([executed(), ok], release).ok, false);
});

test('a real release counts', () => {
  const r = lockRelease([executed(), transfer(LOCK, DEST, 1000), ok], release);
  assert.equal(r.ok, true);
  assert.equal(r.approvers.length, 2);
});

test('an outer success over a failed inner call is not a release', () => {
  const inner = executed({ result: { err: { module: { index: 5, error: '0x02000000' } } } });
  assert.equal(lockRelease([inner, ok], release).ok, false);
  assert.equal(lockRelease([inner, transfer(LOCK, DEST, 1000), ok], release).ok, false);
});

test('a release with another call, destination, amount, multisig or approver set does not count', () => {
  assert.equal(lockRelease([executed({ call: transferCall(OTHER, 1000n) }), transfer(LOCK, DEST, 1000), ok], release).ok, false);
  assert.equal(lockRelease([executed(), transfer(LOCK, OTHER, 1000), ok], release).ok, false);
  assert.equal(lockRelease([executed(), transfer(LOCK, DEST, 999), ok], release).ok, false);
  assert.equal(lockRelease([executed({ multisig_address: OTHER }), transfer(LOCK, DEST, 1000), ok], release).ok, false);
  assert.equal(lockRelease([executed({ approvers: [S[0], S[0]] }), transfer(LOCK, DEST, 1000), ok], release).ok, false);
  assert.equal(lockRelease([executed({ approvers: [S[0], OTHER] }), transfer(LOCK, DEST, 1000), ok], release).ok, false);
  assert.equal(lockRelease([executed(), transfer(LOCK, DEST, 1000), failed], release).ok, false);
});

test('dispatch needs exactly one success and no failure', () => {
  assert.equal(dispatched([ok]), true);
  assert.equal(dispatched([ok, ok]), false);
  assert.equal(dispatched([ok, failed]), false);
  assert.equal(dispatched([]), false);
});

test('duplicates are found', () => {
  assert.equal(firstDuplicate(['a', 'b', 'a']), 'a');
  assert.equal(firstDuplicate(['a', 'b']), null);
});

test('the transfer call matches the bytes a real lock transfer carries', () => {
  // Block 121498 #1 on the curve test chain: transfer_keep_alive(lock, 1 QTC).
  assert.equal(transferCall('0xda1f22169753932899a40df86f038aa32410cdb6e80ea8393813a5ba39308bf2', 1000000000000n),
    '0x020300da1f22169753932899a40df86f038aa32410cdb6e80ea8393813a5ba39308bf2070010a5d4e8');
});
