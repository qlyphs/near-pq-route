// What counts as evidence on the Quantus side of the route, as pure functions over decoded chain data, so the rules
// can be tested without a network. Events are { section, method, data } with account ids as 0x hex, amounts as
// decimal strings, and each event already bound to one extrinsic (phase ApplyExtrinsic(index) of one block).

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The extrinsic dispatched successfully: exactly one ExtrinsicSuccess and no ExtrinsicFailed among its events. */
export function dispatched(events) {
  const ok = events.filter((e) => e.section === 'system' && e.method === 'ExtrinsicSuccess').length;
  const failed = events.some((e) => e.section === 'system' && e.method === 'ExtrinsicFailed');
  return ok === 1 && !failed;
}

/**
 * A lock deposit: the extrinsic succeeded and emitted a Balances.Transfer of exactly `planck` to the lock. Bytes
 * that merely look like a transfer (a remark, say) emit no Transfer event and do not count.
 */
export function lockDeposit(events, { lock, planck }) {
  if (!dispatched(events)) return { ok: false, why: 'the extrinsic did not dispatch successfully' };
  const t = events.filter((e) => e.section === 'balances' && e.method === 'Transfer' && same(e.data.to, lock) && String(e.data.amount) === String(planck));
  if (t.length !== 1) return { ok: false, why: `${t.length} transfers of ${planck} to the lock in this extrinsic` };
  return { ok: true, from: t[0].data.from };
}

/**
 * A release: the extrinsic succeeded, the lock's multisig executed a proposal whose inner call succeeded, approved
 * by at least `threshold` distinct signers of the lock, whose call is exactly the expected transfer, and a
 * Balances.Transfer of exactly `planck` from the lock to `destination` followed. An outer success with a failed
 * inner call does not count.
 */
export function lockRelease(events, { lock, signers, threshold, destination, planck, call }) {
  if (!dispatched(events)) return { ok: false, why: 'the extrinsic did not dispatch successfully' };
  const ex = events.filter((e) => e.section === 'multisig' && e.method === 'ProposalExecuted' && same(e.data.multisig_address, lock));
  if (ex.length !== 1) return { ok: false, why: `${ex.length} executed proposals of the lock in this extrinsic` };
  const p = ex[0].data;
  if (!p.result || !('ok' in p.result)) return { ok: false, why: `the inner call failed: ${JSON.stringify(p.result)}` };
  if (!same(p.call, call)) return { ok: false, why: 'the executed call is not the expected transfer' };
  const approvers = [...new Set((p.approvers ?? []).map((a) => String(a).toLowerCase()))];
  if (approvers.length < threshold || !approvers.every((a) => signers.some((s) => same(s, a)))) return { ok: false, why: `approvers ${approvers.length}, not ${threshold} distinct signers of the lock` };
  const t = events.filter((e) => e.section === 'balances' && e.method === 'Transfer' && same(e.data.from, lock) && same(e.data.to, destination) && String(e.data.amount) === String(planck));
  if (t.length !== 1) return { ok: false, why: `${t.length} transfers of ${planck} from the lock to the destination in this extrinsic` };
  return { ok: true, proposal: String(p.proposal_id), approvers };
}

/** The first value that appears twice in `values`, or null. */
export function firstDuplicate(values) {
  const seen = new Set();
  for (const v of values) { if (seen.has(v)) return v; seen.add(v); }
  return null;
}

/** SCALE compact encoding of an unsigned integer. */
export function compact(n) {
  n = BigInt(n);
  if (n < 1n << 6n) return Uint8Array.of(Number(n << 2n));
  if (n < 1n << 14n) { const v = Number((n << 2n) | 1n); return Uint8Array.of(v & 255, v >> 8); }
  if (n < 1n << 30n) { const v = Number((n << 2n) | 2n); return Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24); }
  const bytes = []; let m = n; while (m > 0n) { bytes.push(Number(m & 255n)); m >>= 8n; }
  return Uint8Array.of(((bytes.length - 4) << 2) | 3, ...bytes);
}
/** The call bytes of Balances.transfer_keep_alive(MultiAddress::Id(to), Compact(amount)) on this runtime (pallet 2, call 3). */
export function transferCall(toHex, planck) {
  const to = Buffer.from(toHex.replace(/^0x/, ''), 'hex');
  return '0x' + Buffer.from(Uint8Array.of(0x02, 0x03, 0x00, ...to, ...compact(planck))).toString('hex');
}
