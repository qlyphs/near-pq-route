// Chain reads the relayer makes before spending gas: the vault's key, nonce and final height, and the gas price.
import { checkVault } from '../sdk/vault.mjs';
import { Refusal } from './message.mjs';
import { RpcError, TransportError } from './rpc.mjs';

/**
 * Returns `readVault(vault)`, which reads the vault's stored key and then runs the wallet preflight
 * (`checkVault`) with it at a final block: pinned factory and code, registry record, no access keys,
 * storage exactly that key and a usable nonce. Resolves to { publicKey, nonce, height } of that block.
 */
export function createChain({ rpc, deployment }) {
  async function readVault(vault) {
    let publicKey;
    try {
      const { values } = await rpc.provider.query({ request_type: 'view_state', finality: 'final', account_id: vault, prefix_base64: Buffer.from('k').toString('base64') });
      const k = values.find((v) => Buffer.from(v.key, 'base64').toString('latin1') === 'k');
      if (!k) throw new Refusal(422, 'vault has no key');
      publicKey = Buffer.from(k.value, 'base64');
    } catch (e) {
      if (e instanceof RpcError) throw new Refusal(422, 'vault not found');
      throw e;
    }
    let pre;
    try {
      pre = await checkVault(rpc.provider, deployment, { vault, publicKey });
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new Refusal(422, `vault check failed: ${e.message}`);
    }
    const { header } = await rpc.provider.block({ block_id: pre.block });
    return { publicKey, nonce: pre.nonce, height: BigInt(header.height) };
  }
  /** The gas price of the latest block, yoctoNEAR per gas unit. */
  async function gasPrice() {
    const { gas_price: price } = await rpc.call('gas_price', [null]);
    if (!/^\d+$/.test(String(price))) throw new TransportError('gas_price: malformed answer');
    return BigInt(price);
  }
  return { readVault, gasPrice };
}
