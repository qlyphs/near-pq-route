// The hard spend bound: the relayer account itself may hold only a small, spendable amount of NEAR.
import { TransportError } from './rpc.mjs';

/**
 * What the relayer account could spend at a final block, in yoctoNEAR: its balance minus the part its
 * storage keeps (storage_usage × storage_amount_per_byte, less what `locked` already covers). Nothing the
 * relayer does can cost more than this, whatever the gas price, as long as nobody tops the account up.
 */
export async function spendableBalance(rpc, { account, storageAmountPerByte }) {
  let view;
  try {
    view = await rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: account });
  } catch (e) {
    throw new Error(`relayer account ${account} unreadable: ${e instanceof TransportError ? 'no answer' : e.message}`);
  }
  const num = (x, name) => {
    if (!/^\d+$/.test(String(x ?? ''))) throw new Error(`relayer account ${account}: ${name} malformed`);
    return BigInt(x);
  };
  const amount = num(view?.amount, 'amount');
  const locked = num(view?.locked, 'locked');
  const storage = num(view?.storage_usage, 'storage_usage') * storageAmountPerByte;
  const kept = storage > locked ? storage - locked : 0n;
  return amount > kept ? amount - kept : 0n;
}

/**
 * Refuses (throws) when the relayer account could spend more than `maxSpendable`: the account's balance
 * is the budget that holds, so it must be funded minimally and never topped up automatically.
 */
export async function checkRelayerAccount(rpc, { account, storageAmountPerByte, maxSpendable }) {
  const spendable = await spendableBalance(rpc, { account, storageAmountPerByte });
  if (spendable > maxSpendable) {
    throw new Error(`relayer account ${account} can spend ${spendable} yocto, above RELAYER_MAX_ACCOUNT_SPENDABLE (${maxSpendable}); `
      + 'move the excess out: the account balance is the hard budget');
  }
  return spendable;
}
