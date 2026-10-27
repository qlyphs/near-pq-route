// The relay decision: every check that runs before gas is spent, in order, then one submission.
import { executeArgs } from '../sdk/vault.mjs';
import { Ledger, messageId, slotId } from './ledger.mjs';
import { Busy } from './limits.mjs';
import { Refusal, parseRequest } from './message.mjs';
import { RpcError, TransportError, isValidationRejection } from './rpc.mjs';
import { verifyAuthorization } from './signature.mjs';

const TGAS = 10n ** 12n;
export const BASE_GAS_TGAS = 30n;

/** Gas the relayer attaches: 30 Tgas, plus the signed ft_transfer gas for a token payment. */
export const attachedGas = ({ action, ftGasTgas }) => (BASE_GAS_TGAS + (action === 1 ? BigInt(ftGasTgas) : 0n)) * TGAS;

/**
 * `deps`: deployment (pinned manifest); readVault and gasPrice (chain.mjs); submit and rebroadcast
 * (submitter.mjs); limiter, vaultQuota, ipQuota, cap (limits.mjs); costOf(req), the yoctoNEAR reserved
 * against the cap for one submission (cost.mjs); maxGasPriceYocto, the price that bound assumes; ledger.
 * `relay(body, ip)` resolves to { status, body } and never throws.
 */
export function createRelay(deps) {
  const { deployment, readVault, gasPrice, submit, rebroadcast, limiter, vaultQuota, ipQuota, cap, costOf, maxGasPriceYocto } = deps;
  const ledger = deps.ledger ?? new Ledger();

  // Everything read from the chain before a slot is claimed. Returns the finalized { nonce, height }.
  async function checked(req) {
    const vault = await readVault(req.vault);
    if (vault.nonce !== req.nonce) throw new Refusal(422, `nonce is not the vault's next nonce (${vault.nonce})`);
    if (!(req.issued <= vault.height && vault.height < req.expiry)) throw new Refusal(422, 'authorization expired or not yet valid');
    if (!verifyAuthorization(req.signature, req.message, vault.publicKey)) throw new Refusal(422, 'invalid signature');
    // The spend bound holds only while the price stays under the ceiling; keep 2x headroom (cost.mjs).
    if ((await gasPrice()) * 2n > maxGasPriceYocto) throw new Refusal(503, 'gas price too close to the relayer ceiling, retry later');
    return { nonce: vault.nonce, height: vault.height };
  }

  async function submitOnce(req, ip, slot, msg) {
    if (!vaultQuota.take(req.vault)) throw new Refusal(429, 'quota reached for this vault');
    if (!ipQuota.take(ip)) {
      vaultQuota.untake(req.vault);
      throw new Refusal(429, 'quota reached for this client');
    }
    if (!cap.reserve(costOf(req))) throw new Refusal(503, 'paused: spend cap reached');
    try {
      // The hash and the signed bytes are recorded before the broadcast, so no answer is ever lost.
      const tx = await submit({ vault: req.vault, args: executeArgs(req.signature, req.message), gas: attachedGas(req) },
        ({ transaction, signed }) => ledger.signed(msg, transaction, signed));
      ledger.settle(msg, 'submitted');
      return { status: 200, body: { transaction: tx } };
    } catch (e) {
      const signed = ledger.lookup(msg)?.tx;
      if (!signed) throw e; // nothing was signed: the caller frees the slot
      if (isValidationRejection(e)) {
        ledger.release(slot, msg);
        return { status: 502, body: { error: `rpc refused the transaction: ${e.message}` } };
      }
      // A timeout or any other answer: the node may have taken it. Keep the hash, the bytes and the slot.
      ledger.settle(msg, 'uncertain');
      return { status: 504, body: { error: 'no definitive answer from rpc; follow the transaction', transaction: signed } };
    }
  }

  // A repeat of a message whose broadcast had no definitive answer: the same signed bytes go out again.
  async function resend(entry, msg) {
    let settle;
    entry.pending = new Promise((ok) => { settle = ok; });
    let result;
    try {
      await limiter.run(() => rebroadcast(entry.signed));
      ledger.settle(msg, 'submitted');
      result = { status: 200, body: { transaction: entry.tx } };
    } catch (e) {
      // Even a refusal of a resend may mean it was already included: the state stays uncertain.
      ledger.settle(msg, 'uncertain');
      result = e instanceof Busy
        ? { status: 503, body: { error: 'busy, retry later', transaction: entry.tx } }
        : { status: 504, body: { error: 'no definitive answer from rpc; follow the transaction', transaction: entry.tx } };
    }
    settle(result);
    return result;
  }

  // An answer from the ledger alone, or null when the request needs the chain.
  function known(entry, msg) {
    if (!entry) return null;
    if (entry.pending) return entry.pending;
    if (entry.state === 'uncertain') return resend(entry, msg);
    if (entry.state === 'rejected') return null; // only the chain can say whether a resend is safe
    return { status: 200, body: { transaction: entry.tx } };
  }

  async function handle(body, ip) {
    const req = parseRequest(body, deployment);
    const msg = messageId(req.message);
    const slot = slotId(req.message);

    const seen = known(ledger.lookup(msg), msg);
    if (seen) return seen;
    // A repeat costs nothing and is still answered; new work stops once the cap is reached.
    if (cap.paused) throw new Refusal(503, 'paused: spend cap reached');

    const chain = await limiter.run(() => checked(req));

    // Claimed only after the signature verified, so an invalid request can never hold a slot.
    const again = known(ledger.lookup(msg), msg);
    if (again) return again;
    let settle;
    const pending = new Promise((ok) => { settle = ok; });
    if (!ledger.claim(slot, msg, { nonce: req.nonce, expiry: req.expiry, pending, chain })) {
      throw new Refusal(409, 'another message for this vault nonce was already submitted');
    }
    const result = await submitOnce(req, ip, slot, msg).catch((e) => {
      ledger.release(slot, msg);
      return toResponse(e);
    });
    const entry = ledger.lookup(msg);
    if (entry?.pending === pending) entry.pending = null;
    settle(result);
    return result;
  }

  return {
    ledger,
    async relay(body, ip) {
      try {
        return await handle(body, ip);
      } catch (e) {
        return toResponse(e);
      }
    },
  };
}

function toResponse(e) {
  if (e instanceof Refusal) return { status: e.status, body: { error: e.reason } };
  if (e instanceof Busy) return { status: 503, body: { error: 'busy, retry later' } };
  if (e instanceof TransportError || e instanceof RpcError) return { status: 502, body: { error: 'rpc unavailable' } };
  return { status: 500, body: { error: 'internal error' } };
}
