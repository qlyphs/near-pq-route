// Signs and broadcasts the one transaction the relayer ever sends: `execute` on a vault, deposit 0.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KeyPair, transactions, utils } from 'near-api-js';
import { priceSafeBlocks } from './cost.mjs';
import { TransportError, isValidationRejection } from './rpc.mjs';

const { base_encode: b58, base_decode: b58decode } = utils.serialize;

/** Loads the relayer's ed25519 key (`ed25519:<base58>`, one line). The key never leaves this module. */
export function loadRelayerKey(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text.startsWith('ed25519:')) throw new Error('RELAYER_KEY_FILE must hold one ed25519:<base58> secret key');
  return KeyPair.fromString(text);
}

/** Blocks kept between the last re-broadcast and the end of the price window, for the time to inclusion. */
export const INCLUSION_MARGIN_BLOCKS = 10n;

/** Nothing was signed: the block to sign against is priced above half the ceiling. Retry later. */
export class PriceTooHigh extends Error {}
/** Nothing was sent: the signed transaction's block is too old for its price to be known under the ceiling. */
export class StaleReference extends Error {}

const header = async (rpc) => {
  const { header: h } = await rpc.call('block', { finality: 'final' });
  if (typeof h?.hash !== 'string' || !/^\d+$/.test(String(h.height)) || !/^\d+$/.test(String(h.gas_price))) throw new TransportError('block: malformed header');
  return { hash: h.hash, height: BigInt(h.height), price: BigInt(h.gas_price) };
};

/**
 * Returns { submit, rebroadcast }. `maxGasPriceYocto` is the price the spend bound assumes and
 * `priceStep` the protocol's largest gas price change per block (cost.mjs).
 *
 * `submit({ vault, args, gas }, onSigned)` reads the final block it will sign against and throws
 * PriceTooHigh, signing nothing, if that block's gas price is above half the ceiling: this check runs
 * after the wait in the serial queue, so no earlier read can be stale. It then signs `execute(args)` on
 * `vault` with exactly `gas` and no deposit, calls `onSigned({ transaction, signed, rebroadcastUntil })`
 * with the hash, the base64 signed bytes and the last final height at which the bytes may be sent again,
 * BEFORE anything is broadcast, then hands it to RPC (`send_tx`, wait_until NONE) and resolves to the hash once
 * the node accepted it. An error thrown after signing carries `transaction` and `signed`.
 *
 * `rebroadcast(signed, rebroadcastUntil)` sends the same signed bytes again: the same hash and access-key
 * nonce, so the network includes it at most once and no second gas-paying transaction is ever built for
 * one attempt. Past `rebroadcastUntil` it throws StaleReference and sends nothing: a copy included later
 * could pay a price above the ceiling. `rebroadcastUntil` is the signing block's height plus the blocks
 * its price needs to climb past the ceiling at the fastest protocol rate, less INCLUSION_MARGIN_BLOCKS.
 * Both are serialized so access-key nonces are used in order.
 */
export function createSubmitter({ rpc, accountId, keyPair, maxGasPriceYocto, priceStep }) {
  if (typeof maxGasPriceYocto !== 'bigint' || !priceStep) throw new Error('submitter needs the gas price ceiling and the protocol price step');
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
    const ref = await header(rpc);
    if (ref.price * 2n > maxGasPriceYocto) throw new PriceTooHigh('gas price of the reference block too close to the relayer ceiling');
    const rebroadcastUntil = ref.height + priceSafeBlocks(ref.price, maxGasPriceYocto, priceStep) - INCLUSION_MARGIN_BLOCKS;
    const tx = transactions.createTransaction(accountId, publicKey, vault, nonce + 1n,
      [transactions.functionCall('execute', args, gas, 0n)], b58decode(ref.hash));
    const hash = createHash('sha256').update(transactions.encodeTransaction(tx)).digest();
    const signedTx = new transactions.SignedTransaction({
      transaction: tx,
      signature: new transactions.Signature({ keyType: publicKey.keyType, data: keyPair.sign(hash).signature }),
    });
    const transaction = b58(hash);
    const signed = Buffer.from(signedTx.encode()).toString('base64');
    nonce += 1n;
    onSigned?.({ transaction, signed, rebroadcastUntil });
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
    rebroadcast: (signed, rebroadcastUntil) => serial(async () => {
      if (typeof rebroadcastUntil !== 'bigint') throw new StaleReference('no price window recorded for these bytes');
      if ((await header(rpc)).height > rebroadcastUntil) throw new StaleReference('reference block too old to re-broadcast under the gas price ceiling');
      return rpc.call('send_tx', { signed_tx_base64: signed, wait_until: 'NONE' });
    }),
  };
}
