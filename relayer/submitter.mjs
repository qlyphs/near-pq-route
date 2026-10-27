// Signs and broadcasts the one transaction the relayer ever sends: `execute` on a vault, deposit 0.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KeyPair, transactions, utils } from 'near-api-js';
import { RpcError } from './rpc.mjs';

const { base_encode: b58, base_decode: b58decode } = utils.serialize;

/** Loads the relayer's ed25519 key (`ed25519:<base58>`, one line). The key never leaves this module. */
export function loadRelayerKey(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text.startsWith('ed25519:')) throw new Error('RELAYER_KEY_FILE must hold one ed25519:<base58> secret key');
  return KeyPair.fromString(text);
}

/**
 * Returns `submit({ vault, args, gas })`, which signs `execute(args)` on `vault` with exactly `gas` and no
 * deposit, hands it to RPC (`send_tx`, wait_until NONE) and resolves to the transaction hash once the node
 * accepted it. Submissions are serialized so access-key nonces never collide.
 */
export function createSubmitter({ rpc, accountId, keyPair }) {
  const publicKey = keyPair.getPublicKey();
  let nonce = null;
  let queue = Promise.resolve();

  async function chainNonce() {
    const ak = await rpc.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey.toString() });
    return BigInt(ak.nonce);
  }

  async function sendOne({ vault, args, gas }) {
    const onChain = await chainNonce();
    nonce = nonce === null || onChain > nonce ? onChain : nonce;
    const { header } = await rpc.call('block', { finality: 'final' });
    const tx = transactions.createTransaction(accountId, publicKey, vault, nonce + 1n,
      [transactions.functionCall('execute', args, gas, 0n)], b58decode(header.hash));
    const hash = createHash('sha256').update(transactions.encodeTransaction(tx)).digest();
    const signed = new transactions.SignedTransaction({
      transaction: tx,
      signature: new transactions.Signature({ keyType: publicKey.keyType, data: keyPair.sign(hash).signature }),
    });
    const txHash = b58(hash);
    nonce += 1n;
    try {
      await rpc.call('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'NONE' });
    } catch (e) {
      // A node refusal (bad nonce, low balance) is definitive; forget the local nonce and read it again.
      if (e instanceof RpcError) nonce = null;
      e.transaction = txHash;
      throw e;
    }
    return txHash;
  }

  return function submit(request) {
    const run = queue.then(() => sendOne(request));
    queue = run.catch(() => {});
    return run;
  };
}
