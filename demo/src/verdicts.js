// Classifies the demo's retired-key experiments. Only the specific expected defense counts as blocked; a timeout,
// an unfunded or deleted sender, a wrong nonce or any other rejection is unverified, never a pass.
export const BLOCKED = 'blocked_as_expected';
export const SUCCEEDED = 'unexpected_success';
export const UNVERIFIED = 'unverified';

const failureOf = (s) => (s && typeof s === 'object' && 'Failure' in s ? s.Failure : null);

/** The former owner's mint: FINAL execution evidence of this exact transaction (hash, signer, receiver, one mint
 * call with the experiment's arguments), whose action receipt was executed by the token and failed with the typed
 * panic "only the Guardian can do this". expected: { owner, token, args } where args is the exact JSON sent. */
export function ownerMintVerdict(r, { owner, token, args }) {
  if (!r) return { verdict: UNVERIFIED, stage: 'request', reason: 'no answer' };
  if (r.ok) return { verdict: SUCCEEDED, stage: 'execution', reason: 'the mint went through' };
  const o = r.outcome;
  if (!o) return { verdict: UNVERIFIED, stage: 'submission', reason: r.failure ?? 'not submitted' };
  if (o.final_execution_status !== 'FINAL') return { verdict: UNVERIFIED, stage: 'execution', reason: 'final execution evidence missing or not final' };
  const t = o.transaction ?? {};
  if (!r.hash || t.hash !== r.hash) return { verdict: UNVERIFIED, stage: 'execution', reason: 'evidence is for another transaction' };
  const call = t.actions?.length === 1 ? t.actions[0]?.FunctionCall : null;
  let sent = null;
  try { sent = call ? Buffer.from(call.args, 'base64').toString() : null; } catch { sent = null; }
  if (t.signer_id !== owner || t.receiver_id !== token || call?.method_name !== 'mint' || sent !== args) return { verdict: UNVERIFIED, stage: 'execution', reason: 'not the expected mint call' };
  const id = o.transaction_outcome?.outcome?.status?.SuccessReceiptId;
  const receipt = id ? (o.receipts_outcome ?? []).find((x) => x.id === id) : null;
  if (!receipt || receipt.outcome?.executor_id !== token) return { verdict: UNVERIFIED, stage: 'execution', reason: 'action receipt missing or run by another account' };
  const panic = receipt.outcome.status?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (panic === 'Smart contract panicked: only the Guardian can do this') return { verdict: BLOCKED, stage: 'execution', reason: 'only the Guardian can do this', receipt: id };
  return { verdict: UNVERIFIED, stage: 'execution', reason: typeof panic === 'string' ? panic : r.failure ?? 'refused for another reason' };
}

/** The deleted deployment key: the network's typed refusal, AccessKeyNotFound for exactly this account and key. */
export function deletedKeyVerdict(r, { token, publicKey }) {
  if (!r) return { verdict: UNVERIFIED, stage: 'request', reason: 'no answer' };
  if (r.ok) return { verdict: SUCCEEDED, stage: 'execution', reason: 'the deployment went through' };
  const nf = r.rpcError?.data?.TxExecutionError?.InvalidTxError?.InvalidAccessKeyError?.AccessKeyNotFound;
  if (nf && nf.account_id === token && nf.public_key === publicKey) return { verdict: BLOCKED, stage: 'submission', reason: 'InvalidAccessKeyError: AccessKeyNotFound' };
  return { verdict: UNVERIFIED, stage: r.outcome ? 'execution' : 'submission', reason: r.failure ?? 'refused for another reason' };
}

/** A base-unit amount as a decimal token amount with the metadata's decimals (exact, no floating point). */
export function formatUnits(raw, decimals) {
  const v = BigInt(raw), d = 10n ** BigInt(decimals), whole = v / d, frac = (v % d).toString().padStart(Number(decimals), '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
