// Signs and broadcasts the one transaction the relayer ever sends: `execute` on a vault, deposit 0.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KeyPair, transactions, utils } from 'near-api-js';
import { isValidationRejection } from './rpc.mjs';

const { base_encode: b58, base_decode: b58decode } = utils.serialize;

/** Loads the relayer's ed25519 key (`ed25519:<base58>`, one line). The key never leaves this module. */
export function loadRelayerKey(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text.startsWith('ed25519:')) throw new Error('RELAYER_KEY_FILE must hold one ed25519:<base58> secret key');
  return KeyPair.fromString(text);
}

/**
 * Returns { submit, rebroadcast }.
 *
 * `submit({ vault, args, gas }, onSigned)` signs `execute(args)` on `vault` with exactly `gas` and no
 * deposit, calls `onSigned({ transaction, signed })` with the hash and the base64 signed bytes BEFORE
 * anything is broadcast, then hands it to RPC (`send_tx`, wait_until NONE) and resolves to the hash once
 * the node accepted it. An error thrown after signing carries `transaction` and `signed`.
 *
 * `rebroadcast(signed)` sends the same signed bytes again: the same hash and access-key nonce, so the
 * network includes it at most once and no second gas-paying transaction is ever built for one attempt.
 * Both are serialized so access-key nonces are used in order.
 */
export function createSubmitter({ rpc, accountId, keyPair }) {
  const publicKey = keyPair.getPublicKey();
  let nonce = null;
  let queue = Promise.resolve();
  const serial = (job) => {
    const run = queue.then(job);
    queue = run.catch(() => {});
    return run;
  };

  async function chainNonce() {
    const ak = await rpc.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey.toString() });
    return BigInt(ak.nonce);
  }

  async function sendOne({ vault, args, gas }, onSigned) {
    const onChain = await chainNonce();
    nonce = nonce === null || onChain > nonce ? onChain : nonce;
    const { header } = await rpc.call('block', { finality: 'final' });
    const tx = transactions.createTransaction(accountId, publicKey, vault, nonce + 1n,
      [transactions.functionCall('execute', args, gas, 0n)], b58decode(header.hash));
    const hash = createHash('sha256').update(transactions.encodeTransaction(tx)).digest();
    const signedTx = new transactions.SignedTransaction({
      transaction: tx,
      signature: new transactions.Signature({ keyType: publicKey.keyType, data: keyPair.sign(hash).signature }),
    });
    const transaction = b58(hash);
    const signed = Buffer.from(signedTx.encode()).toString('base64');
    nonce += 1n;
    onSigned?.({ transaction, signed });
    try {
      await rpc.call('send_tx', { signed_tx_base64: signed, wait_until: 'NONE' });
    } catch (e) {
      // A validation refusal (bad nonce, low balance) is definitive: read the access-key nonce again.
      if (isValidationRejection(e)) nonce = null;
      e.transaction = transaction;
      e.signed = signed;
      throw e;
    }
    return transaction;
  }

  return {
    submit: (request, onSigned) => serial(() => sendOne(request, onSigned)),
    rebroadcast: (signed) => serial(() => rpc.call('send_tx', { signed_tx_base64: signed, wait_until: 'NONE' })),
  };
}
