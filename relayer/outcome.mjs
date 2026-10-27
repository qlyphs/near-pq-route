// What happened to a relayed transaction, read from a final execution outcome, and the bounded reader behind GET /outcome.
import { Busy } from './limits.mjs';
import { parseRequest } from './message.mjs';
import { RpcError } from './rpc.mjs';

export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const isObject = (x) => x !== null && typeof x === 'object';
const failed = (o) => isObject(o?.outcome?.status) && 'Failure' in o.outcome.status;
const succeeded = (o) => isObject(o?.outcome?.status) && ('SuccessValue' in o.outcome.status || 'SuccessReceiptId' in o.outcome.status);
// A refused attempt says nothing about the authorization: a replay of one already accepted by another
// transaction is refused too. Reporting it as failed would invite a second, real payment.
const rejectedAttempt = (detail) => ({ status: 'unknown', attemptRejected: true, detail });

/**
 * The id of the payment receipt `execute` emitted: among the receipts the execute outcome created, from
 * the vault, to the receiver (NEAR) or the token (ft), with exactly the signed action. Refund receipts
 * share executors with real ones, so nothing is matched by executor alone. Anything ambiguous is null.
 */
function paymentReceipt(result, req, execute) {
  const emitted = new Set(Array.isArray(execute.outcome.receipt_ids) ? execute.outcome.receipt_ids : []);
  const target = req.action === 0 ? req.receiver : req.token;
  const matches = (Array.isArray(result.receipts) ? result.receipts : []).filter((r) => {
    if (!emitted.has(r?.receipt_id) || r.predecessor_id !== req.vault || r.receiver_id !== target) return false;
    const actions = r.receipt?.Action?.actions;
    if (!Array.isArray(actions) || actions.length !== 1) return false;
    const a = actions[0];
    return req.action === 0
      ? a?.Transfer?.deposit === req.amount.toString()
      : a?.FunctionCall?.method_name === 'ft_transfer' && a.FunctionCall.deposit === '1';
  });
  return matches.length === 1 && typeof matches[0].receipt_id === 'string' ? matches[0].receipt_id : null;
}

/**
 * Classifies a final `EXPERIMENTAL_tx_status` result against the authorization the transaction carries:
 * - accepted: `execute` succeeded, so the nonce is spent, and the payment receipt has no outcome yet;
 * - delivered: the payment receipt (Transfer of the signed amount, or ft_transfer with 1 yocto) succeeded;
 * - failed: an ACCEPTED execute's payment receipt failed (funds stay in the vault, the nonce is spent);
 * - unknown: anything missing, ambiguous or unexpected. A refused transaction or `execute` is `unknown`
 *   with `attemptRejected: true`: it proves only that this attempt failed.
 */
export function classify(result, deployment) {
  const tx = result?.transaction;
  if (!isObject(tx) || !isObject(result.transaction_outcome)) return { status: 'unknown', detail: 'missing transaction outcome' };
  const call = Array.isArray(tx.actions) && tx.actions.length === 1 ? tx.actions[0]?.FunctionCall : null;
  if (call?.method_name !== 'execute') return { status: 'unknown', detail: 'not an execute transaction' };
  let req;
  try {
    req = parseRequest(Buffer.from(typeof call.args === 'string' ? call.args : '', 'base64'), deployment);
  } catch {
    return { status: 'unknown', detail: 'transaction does not carry a valid authorization' };
  }
  if (tx.receiver_id !== req.vault) return { status: 'unknown', detail: 'transaction is not sent to the signed vault' };
  if (failed(result.transaction_outcome)) return rejectedAttempt('transaction refused; this attempt moved nothing');

  // The transaction becomes exactly one receipt, the `execute` call: found by id, run by the vault.
  const outcomes = Array.isArray(result.receipts_outcome) ? result.receipts_outcome : [];
  const first = result.transaction_outcome.outcome?.receipt_ids;
  const executeId = Array.isArray(first) && first.length === 1 ? first[0] : undefined;
  const execute = outcomes.find((o) => o?.id === executeId && o.outcome?.executor_id === req.vault);
  if (!execute) return { status: 'unknown', detail: 'execute receipt not found' };
  if (failed(execute)) return rejectedAttempt('execute refused for this attempt; the authorization may be accepted elsewhere');
  if (!succeeded(execute)) return { status: 'unknown', detail: 'execute outcome not final' };

  const payment = paymentReceipt(result, req, execute);
  if (!payment) return { status: 'unknown', detail: 'nonce spent; payment receipt missing or ambiguous' };
  const delivery = outcomes.find((o) => o?.id === payment);
  if (failed(delivery)) return { status: 'failed', detail: 'payment receipt failed; funds stay in the vault, nonce spent' };
  if (succeeded(delivery)) return { status: 'delivered', detail: req.action === 0 ? 'NEAR transfer' : 'ft_transfer' };
  return { status: 'accepted', detail: 'nonce spent; payment pending' };
}

/**
 * Reads the outcome of `txHash` sent by `sender`. A timeout or an unknown answer is `unknown` (or
 * `submitted` if this relayer sent it and the node does not know it yet), never `failed`.
 */
export async function outcome(rpc, { txHash, sender, deployment, ours = false, timeoutMs = 30000 }) {
  let result;
  try {
    result = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' }, { timeout: timeoutMs });
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_TRANSACTION/.test(e.message) && ours) return { status: 'submitted', detail: 'not final yet' };
    return { status: 'unknown', detail: e instanceof RpcError ? e.message : 'no final outcome yet' };
  }
  return classify(result, deployment);
}

/**
 * GET /outcome behind the same kind of limits as /execute: a per-client and a global ingress budget,
 * a bounded queue of RPC reads, and a single read shared by concurrent requests for one transaction.
 * `read(txHash)` does the RPC read; `observe(txHash, result)` lets the ledger learn each answer.
 * The returned `outcomeOf(txHash, ip)` resolves to { status, body } and never throws.
 */
export function createOutcomeReader({ read, limiter, ipQuota, globalQuota, observe = () => {} }) {
  const inflight = new Map();
  return async function outcomeOf(txHash, ip) {
    if (!TX_HASH.test(txHash)) return { status: 400, body: { error: 'not a transaction hash' } };
    let shared = inflight.get(txHash);
    if (!shared) {
      // Only a request that starts an RPC read spends budget; joining a read in flight costs nothing.
      if (!ipQuota.take(ip)) return { status: 429, body: { error: 'outcome quota reached for this client' } };
      if (!globalQuota.take('outcome')) {
        ipQuota.untake(ip);
        return { status: 429, body: { error: 'outcome budget reached, retry later' } };
      }
      shared = limiter.run(() => read(txHash)).then((r) => { observe(txHash, r); return r; });
      inflight.set(txHash, shared);
      shared.then(() => inflight.delete(txHash), () => inflight.delete(txHash));
    }
    try {
      return { status: 200, body: { transaction: txHash, ...(await shared) } };
    } catch (e) {
      if (e instanceof Busy) return { status: 503, body: { error: 'busy, retry later' } };
      return { status: 502, body: { error: 'rpc unavailable' } };
    }
  };
}
