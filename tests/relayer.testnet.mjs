// Testnet run of the relayer against the pinned deployment: a wallet-style (noble) signed payment relayed,
// followed to delivery; a repeat answered with the same hash; the same signed bytes replayed as a second
// execute (around the relayer's dedupe), refused by the vault and reported unknown with attemptRejected,
// never failed; a tampered signature refused with no transaction; the measured charge under the spend bound;
// the gas price of the signing and inclusion blocks against the ceiling; a second relayer on the same state
// directory refused; the relayer account's spendable balance under RELAYER_MAX_ACCOUNT_SPENDABLE.
// Writes evidence/relayer-testnet.json.
// Usage: RELAYER_ACCOUNT=<id> RELAYER_KEY_FILE=<ed25519 key file> OWNER_KEY_FILE=<ML-DSA-87 pem> \
//   [RECEIVER=<id>] node tests/relayer.testnet.mjs
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT, Key, checkVault, encodeMessage, executeArgs, vaultAddress } from '../sdk/vault.mjs';
import { transactions, utils } from 'near-api-js';
import { readProtocolCosts } from '../relayer/cost.mjs';
import { messageId } from '../relayer/ledger.mjs';
import { createRpc } from '../relayer/rpc.mjs';
import { startFromEnv } from '../relayer/server.mjs';
import { createSubmitter, loadRelayerKey } from '../relayer/submitter.mjs';
import { nobleKeyFromPem } from './ml-dsa-seed.mjs';

const NEAR = 10n ** 24n;
const AMOUNT = NEAR / 100n;
const deployment = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
const relayerId = process.env.RELAYER_ACCOUNT;
// Paid to an account other than the relayer, so the relayer's balance shows only what it is charged.
const receiver = process.env.RECEIVER ?? relayerId.split('.').slice(1).join('.');
const rpc = createRpc(process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const out = { network: deployment.network, factory: deployment.factory, relayer: relayerId, steps: [] };
const step = (name, ok, extra = {}) => { out.steps.push({ name, ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.tx ? ` tx=${extra.tx}` : ''}${extra.detail ? ` (${extra.detail})` : ''}`); };

// The wallet signs with noble from the seed; the OpenSSL key file only proves it is the same key.
const owner = nobleKeyFromPem(process.env.OWNER_KEY_FILE);
if (!Buffer.from(owner.publicKey).equals(new Key(process.env.OWNER_KEY_FILE).publicKey)) throw new Error('noble and OpenSSL disagree on the owner key');
const vault = vaultAddress(owner.publicKey, deployment.factory);
out.vault = vault;
out.receiver = receiver;
const sign = (m) => Buffer.from(ml_dsa87.sign(m, owner.secretKey, { context: CONTEXT }));

const relayerPk = loadRelayerKey(process.env.RELAYER_KEY_FILE).getPublicKey().toString();
const accessNonce = async () => BigInt((await rpc.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: relayerId, public_key: relayerPk })).nonce);
const vaultNonce = async () => (await checkVault(rpc.provider, deployment, { vault, publicKey: owner.publicKey })).nonce;

const balanceAt = async (height) => BigInt((await rpc.call('query', { request_type: 'view_account', block_id: Number(height), account_id: relayerId })).amount);
const finalHeight = async () => BigInt((await rpc.call('block', { finality: 'final' })).header.height);

// A fresh state directory: the spend file starts empty for this run (and is removed after).
const stateDir = mkdtempSync(join(tmpdir(), 'qvault-relayer-state-'));
const { server, address, ledger } = await startFromEnv({ ...process.env, PORT: '0', RELAYER_STATE_DIR: stateDir });
out.relayer_account_limit_override = process.env.RELAYER_MAX_ACCOUNT_SPENDABLE ?? null;
const base = `http://127.0.0.1:${address.port}`;
const post = async (body, at = base) => { const r = await fetch(`${at}/execute`, { method: 'POST', body }); return { status: r.status, body: await r.json() }; };
const follow = async (tx, until) => {
  const seen = [];
  let status;
  for (let i = 0; i < 30; i++) {
    status = await (await fetch(`${base}/outcome/${tx}`)).json();
    if (seen.at(-1) !== status.status) seen.push(status.status);
    if (until(status)) break;
    await sleep(2000);
  }
  return { status, seen };
};
const others = [];

try {
  // 1. Sign as the wallet does: preflight, then a message for the current nonce and window.
  const nonce = await vaultNonce();
  const height = await finalHeight();
  const message = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver, amount: AMOUNT, nonce, issued: height, expiry: height + 600n });
  const body = Buffer.concat([sign(message), message]);
  step('wallet preflight and noble ML-DSA-87 signature', true, { detail: `vault nonce ${nonce}, final height ${height}` });

  // 2. Relay it and follow the outcome to delivery.
  const health0 = await (await fetch(`${base}/health`)).json();
  out.account = { spendable_at_start_yocto: health0.account_spendable_at_start_yocto, max_account_spendable_yocto: health0.max_account_spendable_yocto };
  step('the relayer started with its account under RELAYER_MAX_ACCOUNT_SPENDABLE',
    BigInt(health0.account_spendable_at_start_yocto) <= BigInt(health0.max_account_spendable_yocto),
    { detail: `spendable ${health0.account_spendable_at_start_yocto} <= limit ${health0.max_account_spendable_yocto} yocto${out.relayer_account_limit_override ? ' (limit set by env for this run)' : ' (default)'}` });
  const sameDir = await startFromEnv({ ...process.env, PORT: '0', RELAYER_STATE_DIR: stateDir }).then((s) => { others.push({ server: s.server, dir: null }); return null; }, (e) => e);
  step('a second relayer on the same state directory refuses to start', sameDir instanceof Error && /locked by running process/.test(sameDir.message),
    { detail: sameDir?.message ?? 'it started' });
  const h0 = await finalHeight();
  const balance0 = await balanceAt(h0);
  const sent = await post(body);
  const tx = sent.body.transaction;
  step('relayer accepts and returns a transaction hash', sent.status === 200 && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx ?? ''), { tx, detail: `HTTP ${sent.status}` });
  const { status, seen } = await follow(tx, (x) => x.status === 'delivered' || x.status === 'failed');
  step('outcome followed to delivered', status.status === 'delivered', { tx, detail: seen.join(' -> ') });
  const final = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: tx, sender_account_id: relayerId, wait_until: 'FINAL' });
  const transfer = final.receipts.find((r) => r.predecessor_id === vault)?.receipt.Action.actions[0].Transfer;
  const attached = final.transaction.actions[0].FunctionCall;
  const paid = final.receipts.find((r) => r.predecessor_id === vault);
  // The price of the block the transaction was signed against, and of the block it was included in.
  const priceOf = async (hash) => BigInt((await rpc.call('block', { block_id: hash })).header.gas_price);
  // The transaction view does not name its reference block; the signed bytes the relayer kept do.
  const entry = ledger.lookup(messageId(message));
  const refHash = utils.serialize.base_encode(Uint8Array.from(transactions.SignedTransaction.decode(Buffer.from(entry.signed, 'base64')).transaction.blockHash));
  const refHeight = BigInt((await rpc.call('block', { block_id: refHash })).header.height);
  const refPrice = await priceOf(refHash);
  const inclusionPrice = await priceOf(final.transaction_outcome.block_hash);
  const ceiling = BigInt(health0.max_gas_price_yocto);
  out.gas_price = { reference_block: refHash, reference_height: refHeight.toString(), rebroadcast_until_height: entry.rebroadcastUntil.toString(), reference_block_yocto: refPrice.toString(), inclusion_block_yocto: inclusionPrice.toString(), ceiling_yocto: ceiling.toString() };
  step('signing block priced at most half the ceiling, inclusion block at most the ceiling',
    refPrice * 2n <= ceiling && inclusionPrice <= ceiling && entry.rebroadcastUntil > refHeight,
    { tx, detail: `reference ${refPrice} at ${refHeight}, inclusion ${inclusionPrice}, ceiling ${ceiling} yocto/gas; re-broadcast allowed until ${entry.rebroadcastUntil}` });
  step('on-chain: execute with 30 Tgas and no deposit, then 0.01 NEAR from the vault to the signed receiver',
    BigInt(attached.gas) === 30n * 10n ** 12n && attached.deposit === '0' && transfer?.deposit === AMOUNT.toString() && paid?.receiver_id === receiver && final.transaction.receiver_id === vault,
    { tx, detail: `gas ${attached.gas}, deposit ${attached.deposit}, transfer ${transfer?.deposit} to ${paid?.receiver_id}` });

  // The largest drop of the relayer's balance in the blocks after the submission is the peak charge
  // (the tx cost is taken at conversion; refunds come back later). It must stay under the reservation.
  const settled = BigInt((await rpc.call('block', { block_id: final.receipts_outcome.at(-1).block_hash })).header.height) + 3n;
  while ((await finalHeight()) < settled) await sleep(1000);
  let low = balance0;
  for (let h = h0; h <= settled; h++) {
    try { const b = await balanceAt(h); if (b < low) low = b; } catch { /* a skipped height has no block */ }
  }
  const finalBalance = await balanceAt(settled);
  const bound = BigInt(health0.near_transfer_bound_yocto);
  out.spend = { protocol_version: health0.protocol_version, max_gas_price_yocto: health0.max_gas_price_yocto, reserved_per_near_transfer_yocto: bound.toString(),
    peak_charge_yocto: (balance0 - low).toString(), net_cost_after_refunds_yocto: (balance0 - finalBalance).toString(), heights: `${h0}..${settled}` };
  step('measured peak charge and net cost stay under the reserved bound', balance0 - low > 0n && balance0 - low <= bound && balance0 - finalBalance <= bound,
    { tx, detail: `peak ${balance0 - low}, net ${balance0 - finalBalance}, reserved ${bound} yocto` });

  // 3. The same body again, then a new signature of the same message: same hash, no second payment.
  const keysBefore = await accessNonce();
  // Steps 3 and 5 compare access-key nonces; step 4 sends one transaction on purpose, in between.
  const repeat = await post(body);
  const resigned = await post(Buffer.concat([sign(message), message]));
  await sleep(4000);
  const nonceAfter = await vaultNonce();
  const keysAfter = await accessNonce();
  step('repeat returns the same hash, nothing resubmitted',
    repeat.status === 200 && repeat.body.transaction === tx && resigned.body.transaction === tx && nonceAfter === nonce + 1n && keysAfter === keysBefore,
    { tx, detail: `vault nonce ${nonce} -> ${nonceAfter}, relayer access-key nonce ${keysBefore} -> ${keysAfter}` });

  // 4. R2-H1: the same signed bytes as a second execute, sent around the relayer's dedupe (straight from the
  // relayer account, as another relayer with a fresh state would). The vault refuses the replay: that
  // attempt is unknown with attemptRejected, never failed, while the first transaction stays delivered.
  const otherDir = mkdtempSync(join(tmpdir(), 'qvault-relayer-state-'));
  const other = await startFromEnv({ ...process.env, PORT: '0', RELAYER_STATE_DIR: otherDir });
  others.push({ server: other.server, dir: otherDir });
  const fresh = await post(body, `http://127.0.0.1:${other.address.port}`);
  step('a fresh relayer refuses the spent authorization at preflight, without a transaction',
    fresh.status === 422 && !fresh.body.transaction, { detail: `HTTP ${fresh.status} ${fresh.body.error}` });
  const { submit } = createSubmitter({ rpc, accountId: relayerId, keyPair: loadRelayerKey(process.env.RELAYER_KEY_FILE),
    maxGasPriceYocto: BigInt(health0.max_gas_price_yocto), priceStep: (await readProtocolCosts(rpc, deployment)).priceStep });
  const replayTx = await submit({ vault, args: executeArgs(body.subarray(0, 4627), body.subarray(4627)), gas: 30n * 10n ** 12n });
  const replayed = await follow(replayTx, (x) => x.attemptRejected === true || ['accepted', 'delivered', 'failed'].includes(x.status));
  const replayFinal = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: replayTx, sender_account_id: relayerId, wait_until: 'FINAL' });
  const executeFailure = replayFinal.receipts_outcome.find((o) => o.id === replayFinal.transaction_outcome.outcome.receipt_ids[0])?.outcome.status.Failure;
  const firstAgain = await (await fetch(`${base}/outcome/${tx}`)).json();
  const nonceReplay = await vaultNonce();
  out.replay = { tx: replayTx, relayer_outcome: replayed.status, vault_error: executeFailure ?? null, first_tx_outcome: firstAgain };
  step('replayed authorization: /outcome is unknown with attemptRejected, not failed; the first stays delivered',
    replayed.status.status === 'unknown' && replayed.status.attemptRejected === true && !!executeFailure && firstAgain.status === 'delivered' && nonceReplay === nonce + 1n,
    { tx: replayTx, detail: `replay ${replayed.seen.join(' -> ')} attemptRejected=${replayed.status.attemptRejected}; vault ${JSON.stringify(executeFailure)?.slice(0, 160)}; first ${firstAgain.status}; vault nonce ${nonceReplay}` });

  // 5. A tampered signature for the next nonce: refused before any transaction.
  const keysMid = await accessNonce();
  const h2 = await finalHeight();
  const next = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver, amount: AMOUNT, nonce: nonceAfter, issued: h2, expiry: h2 + 600n });
  const bad = sign(next);
  bad[100] ^= 1;
  const refused = await post(Buffer.concat([bad, next]));
  await sleep(4000);
  const keysLast = await accessNonce();
  const nonceLast = await vaultNonce();
  step('tampered signature refused, no transaction sent',
    refused.status === 422 && refused.body.error === 'invalid signature' && !refused.body.transaction && keysLast === keysMid && nonceLast === nonceAfter,
    { detail: `HTTP ${refused.status} ${refused.body.error}; relayer access-key nonce ${keysMid} -> ${keysLast}` });

  const health = await (await fetch(`${base}/health`)).json();
  const saved = JSON.parse(readFileSync(join(stateDir, `spend-testnet-${relayerId}.json`), 'utf8'));
  step('reserved spend is persisted to the state file', saved.reserved_yocto === health.spent_yocto && BigInt(saved.reserved_yocto) === BigInt(health0.near_transfer_bound_yocto),
    { detail: `state file ${saved.reserved_yocto} yocto, health ${health.spent_yocto}` });
  out.spent_budget_yocto = health.spent_yocto;
  out.cap_yocto = health.cap_yocto;
} finally {
  for (const { server: s, dir } of [{ server, dir: stateDir }, ...others]) {
    s.closeAllConnections();
    s.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const fails = out.steps.filter((s) => !s.ok).length;
writeFileSync(new URL('../evidence/relayer-testnet.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`${out.steps.length - fails}/${out.steps.length} passed`);
process.exitCode = fails ? 1 : 0;
