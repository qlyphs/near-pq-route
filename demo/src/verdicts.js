// Classifies the demo's retired-key experiments. Only the specific expected defense counts as blocked; a timeout,
// an unfunded or deleted sender, a wrong nonce or any other rejection is unverified, never a pass.
export const BLOCKED = 'blocked_as_expected';
export const SUCCEEDED = 'unexpected_success';
export const UNVERIFIED = 'unverified';

const failureOf = (s) => (s && typeof s === 'object' && 'Failure' in s ? s.Failure : null);

/** The former owner's mint: final execution evidence of this exact call, refused by the token for the Guardian rule. */
export function ownerMintVerdict(r, { owner, token }) {
  if (!r) return { verdict: UNVERIFIED, stage: 'request', reason: 'no answer' };
  if (r.ok) return { verdict: SUCCEEDED, stage: 'execution', reason: 'the mint went through' };
  const o = r.outcome;
  if (!o) return { verdict: UNVERIFIED, stage: 'submission', reason: r.failure ?? 'not submitted' };
  if (o.final_execution_status && o.final_execution_status !== 'FINAL') return { verdict: UNVERIFIED, stage: 'execution', reason: `execution not final (${o.final_execution_status})` };
  const t = o.transaction ?? {};
  const call = t.actions?.[0]?.FunctionCall;
  if (t.signer_id !== owner || t.receiver_id !== token || t.actions?.length !== 1 || call?.method_name !== 'mint') return { verdict: UNVERIFIED, stage: 'execution', reason: 'not the expected mint call' };
  const refusal = (o.receipts_outcome ?? []).find((x) => x.outcome?.executor_id === token && /only the Guardian can do this/.test(JSON.stringify(failureOf(x.outcome.status) ?? '')));
  if (refusal) return { verdict: BLOCKED, stage: 'execution', reason: 'only the Guardian can do this', receipt: refusal.id };
  return { verdict: UNVERIFIED, stage: 'execution', reason: r.failure ?? 'refused for another reason' };
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
