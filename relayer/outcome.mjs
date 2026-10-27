// What happened to a relayed transaction, read from a final execution outcome.
import { RpcError } from './rpc.mjs';

export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const failed = (o) => o && 'Failure' in o.outcome.status;
const succeeded = (o) => o && ('SuccessValue' in o.outcome.status || 'SuccessReceiptId' in o.outcome.status);

// The payment the vault emits: a Transfer, or a FunctionCall ft_transfer, sent by the vault itself
// (gas refunds come from `system` and are ignored).
function isPayment(receipt, vault) {
  if (receipt.predecessor_id !== vault) return false;
  const actions = receipt.receipt?.Action?.actions ?? [];
  return actions.some((a) => a.Transfer || a.FunctionCall?.method_name === 'ft_transfer');
}

/**
 * Classifies a final `EXPERIMENTAL_tx_status` result:
 * - accepted: `execute` succeeded, so the nonce is spent, and the payment receipt has no outcome yet;
 * - delivered: the payment receipt (Transfer or ft_transfer) succeeded;
 * - failed: `execute` was refused, or the payment receipt failed (funds stay in the vault);
 * - unknown: anything missing or unexpected.
 */
export function classify(result) {
  const tx = result?.transaction;
  const outcomes = new Map((result?.receipts_outcome ?? []).map((o) => [o.id, o]));
  if (!tx || !result.transaction_outcome) return { status: 'unknown', detail: 'missing transaction outcome' };
  if (tx.actions?.length !== 1 || tx.actions[0]?.FunctionCall?.method_name !== 'execute') return { status: 'unknown', detail: 'not an execute transaction' };
  if (failed(result.transaction_outcome)) return { status: 'failed', detail: 'transaction refused' };
  const executeId = result.transaction_outcome.outcome.status.SuccessReceiptId;
  const execute = outcomes.get(executeId);
  if (!execute) return { status: 'unknown', detail: 'execute receipt not found' };
  if (failed(execute)) return { status: 'failed', detail: 'execute refused by the vault; nothing moved, nonce not spent' };
  if (!succeeded(execute)) return { status: 'unknown', detail: 'execute outcome not final' };

  const children = new Set(execute.outcome.receipt_ids);
  const payment = (result.receipts ?? []).find((r) => children.has(r.receipt_id) && isPayment(r, tx.receiver_id));
  if (!payment) return { status: 'accepted', detail: 'nonce spent; payment receipt not visible' };
  const delivery = outcomes.get(payment.receipt_id);
  if (failed(delivery)) return { status: 'failed', detail: 'payment receipt failed; funds stay in the vault, nonce spent' };
  if (succeeded(delivery)) return { status: 'delivered', detail: payment.receipt.Action.actions.some((a) => a.Transfer) ? 'NEAR transfer' : 'ft_transfer' };
  return { status: 'accepted', detail: 'nonce spent; payment pending' };
}

/**
 * Reads the outcome of `txHash` sent by `sender`. A timeout or an unknown answer is `unknown` (or
 * `submitted` if this relayer sent it and the node does not know it yet), never `failed`.
 */
export async function outcome(rpc, { txHash, sender, ours = false, timeoutMs = 30000 }) {
  let result;
  try {
    result = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' }, { timeout: timeoutMs });
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_TRANSACTION/.test(e.message) && ours) return { status: 'submitted', detail: 'not final yet' };
    return { status: 'unknown', detail: e instanceof RpcError ? e.message : 'no final outcome yet' };
  }
  return classify(result);
}
