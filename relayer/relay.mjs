// The relay decision: every check that runs before gas is spent, in order, then one submission.
import { executeArgs } from '../sdk/vault.mjs';
import { Ledger, messageId, slotId } from './ledger.mjs';
import { Busy } from './limits.mjs';
import { Refusal, parseRequest } from './message.mjs';
import { RpcError, TransportError } from './rpc.mjs';
import { verifyAuthorization } from './signature.mjs';

const TGAS = 10n ** 12n;
export const BASE_GAS_TGAS = 30n;

/** Gas the relayer attaches: 30 Tgas, plus the signed ft_transfer gas for a token payment. */
export const attachedGas = ({ action, ftGasTgas }) => (BASE_GAS_TGAS + (action === 1 ? BigInt(ftGasTgas) : 0n)) * TGAS;

/**
 * `deps`: deployment (pinned manifest), readVault (chain.mjs), submit (submitter.mjs), limiter, vaultQuota,
 * ipQuota, cap (limits.mjs), gasPriceYocto (prepaid price per gas unit used for the cap), ledger.
 * `relay(body, ip)` resolves to { status, body } and never throws.
 */
export function createRelay(deps) {
  const { deployment, readVault, submit, limiter, vaultQuota, ipQuota, cap, gasPriceYocto } = deps;
  const ledger = deps.ledger ?? new Ledger();

  async function checked(req) {
    const vault = await readVault(req.vault);
    if (vault.nonce !== req.nonce) throw new Refusal(422, `nonce is not the vault's next nonce (${vault.nonce})`);
    if (!(req.issued <= vault.height && vault.height < req.expiry)) throw new Refusal(422, 'authorization expired or not yet valid');
    if (!verifyAuthorization(req.signature, req.message, vault.publicKey)) throw new Refusal(422, 'invalid signature');
  }

  async function submitOnce(req, ip, slot, msg) {
    if (!vaultQuota.take(req.vault)) throw new Refusal(429, 'quota reached for this vault');
    if (!ipQuota.take(ip)) {
      vaultQuota.untake(req.vault);
      throw new Refusal(429, 'quota reached for this client');
    }
    const gas = attachedGas(req);
    if (!cap.reserve(gas * gasPriceYocto)) throw new Refusal(503, 'paused: spend cap reached');
    try {
      const tx = await submit({ vault: req.vault, args: executeArgs(req.signature, req.message), gas });
      ledger.submitted(slot, msg, tx);
      return { status: 200, body: { transaction: tx } };
    } catch (e) {
      if (e instanceof RpcError) {
        ledger.release(slot, msg);
        return { status: 502, body: { error: `rpc refused the transaction: ${e.message}` } };
      }
      // The node may have taken it: keep the hash so a repeat never pays twice for one message.
      if (e?.transaction) {
        ledger.submitted(slot, msg, e.transaction);
        return { status: 504, body: { error: 'no answer from rpc; follow the transaction', transaction: e.transaction } };
      }
      throw e;
    }
  }

  async function handle(body, ip) {
    const req = parseRequest(body, deployment);
    const msg = messageId(req.message);
    const slot = slotId(req.message);

    const seen = ledger.lookup(msg);
    if (seen?.tx) return { status: 200, body: { transaction: seen.tx } };
    if (seen?.pending) return seen.pending;
    // A repeat costs nothing and is still answered; new work stops once the cap is reached.
    if (cap.paused) throw new Refusal(503, 'paused: spend cap reached');

    await limiter.run(() => checked(req));

    // Claimed only after the signature verified, so an invalid request can never hold a slot.
    const again = ledger.lookup(msg);
    if (again?.tx) return { status: 200, body: { transaction: again.tx } };
    if (again?.pending) return again.pending;
    let settle;
    const pending = new Promise((ok) => { settle = ok; });
    if (!ledger.claim(slot, msg, pending)) throw new Refusal(409, 'another message for this vault nonce was already submitted');
    const result = await submitOnce(req, ip, slot, msg).catch((e) => {
      ledger.release(slot, msg);
      return toResponse(e);
    });
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
