// A conservative bound on what one `execute` transaction can charge the relayer account, from the live protocol config.
import { TransportError } from './rpc.mjs';

const big = (x, name) => {
  if (typeof x !== 'string' && typeof x !== 'number') throw new Error(`protocol config: ${name} missing`);
  const s = String(x);
  if (!/^\d+$/.test(s)) throw new Error(`protocol config: ${name} is not a non-negative integer`);
  return BigInt(s);
};
const fee = (f, name) => ({ send: big(f?.send_not_sir, `${name}.send_not_sir`), exec: big(f?.execution, `${name}.execution`) });

/**
 * Reads `EXPERIMENTAL_protocol_config` at a final block and keeps the fees one `execute` transaction
 * pays. Throws, so the relayer does not start, if the config cannot be read, belongs to another chain,
 * or prices receipts in a way this bound does not cover (a pessimistic inflation other than 1).
 */
export async function readProtocolCosts(rpc, { network }) {
  let c;
  try {
    c = await rpc.call('EXPERIMENTAL_protocol_config', { finality: 'final' });
  } catch (e) {
    throw new Error(`protocol config unavailable: ${e instanceof TransportError ? 'no answer' : e.message}`);
  }
  if (c?.chain_id !== network) throw new Error(`protocol config is for ${c?.chain_id}, not ${network}`);
  const rc = c.runtime_config;
  const t = rc?.transaction_costs;
  const ratio = t?.pessimistic_gas_price_inflation_ratio;
  if (!Array.isArray(ratio) || ratio.length !== 2 || String(ratio[0]) !== String(ratio[1])) {
    throw new Error('protocol config: pessimistic gas price inflation is not 1; the spend bound does not cover it');
  }
  return {
    protocolVersion: c.protocol_version,
    maxGasPrice: big(c.max_gas_price, 'max_gas_price'),
    minGasPurchasePrice: big(rc.min_gas_purchase_price, 'min_gas_purchase_price'),
    receipt: fee(t.action_receipt_creation_config, 'action_receipt_creation_config'),
    functionCall: fee(t.action_creation_config?.function_call_cost, 'function_call_cost'),
    perByte: fee(t.action_creation_config?.function_call_cost_per_byte, 'function_call_cost_per_byte'),
  };
}

/**
 * Upper bound, in yoctoNEAR, on the charge for one transaction holding a single FunctionCall of
 * `argsLen` argument bytes and `prepaidGas` gas, sent to another account, with no deposit.
 *
 * Why it bounds the real charge: on conversion nearcore (`tx_cost` in the runtime) takes from the signer
 * the send fees (new action receipt + function call + per byte of method name and args) at the block's
 * gas price, plus the receipt's gas (its execution fees + the prepaid gas) at the receipt purchase price,
 * which is the gas price raised to `min_gas_purchase_price` when lower (1e9 yocto/gas on testnet today,
 * the price earlier runs observed). With an inflation ratio of 1 nothing else multiplies it. So charging
 * every gas unit (send + execution + prepaid) at max(`maxGasPriceYocto`, min_gas_purchase_price) is at
 * least the real charge whenever the inclusion block's gas price is at most `maxGasPriceYocto`; the
 * relay refuses to sign when today's price leaves less than 2x headroom under it (prices move at most
 * 1 % per block, `gas_price_adjustment_rate` 1/100 on testnet, so doubling takes about 70 blocks). The
 * deposit is 0, and gas refunds are never credited back, so actual spend stays below the reservation.
 */
export function costBound(costs, { argsLen, prepaidGas, maxGasPriceYocto, method = 'execute' }) {
  const bytes = BigInt(method.length + argsLen);
  const send = costs.receipt.send + costs.functionCall.send + costs.perByte.send * bytes;
  const exec = costs.receipt.exec + costs.functionCall.exec + costs.perByte.exec * bytes;
  const price = maxGasPriceYocto > costs.minGasPurchasePrice ? maxGasPriceYocto : costs.minGasPurchasePrice;
  return (send + exec + prepaidGas) * price;
}
