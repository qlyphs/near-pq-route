// Testnet run of the relayer against the pinned deployment: a wallet-style (noble) signed payment relayed,
// followed to delivery; a repeat answered with the same hash; a tampered signature refused with no transaction.
// Writes evidence/relayer-testnet.json.
// Usage: RELAYER_ACCOUNT=<id> RELAYER_KEY_FILE=<ed25519 key file> OWNER_KEY_FILE=<ML-DSA-87 pem> node tests/relayer.testnet.mjs
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { CONTEXT, Key, checkVault, encodeMessage, vaultAddress } from '../sdk/vault.mjs';
import { createRpc } from '../relayer/rpc.mjs';
import { startFromEnv } from '../relayer/server.mjs';
import { loadRelayerKey } from '../relayer/submitter.mjs';
import { nobleKeyFromPem } from './ml-dsa-seed.mjs';

const NEAR = 10n ** 24n;
const AMOUNT = NEAR / 100n;
const deployment = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
const relayerId = process.env.RELAYER_ACCOUNT;
const rpc = createRpc(process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const out = { network: deployment.network, factory: deployment.factory, relayer: relayerId, steps: [] };
const step = (name, ok, extra = {}) => { out.steps.push({ name, ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.tx ? ` tx=${extra.tx}` : ''}${extra.detail ? ` (${extra.detail})` : ''}`); };

// The wallet signs with noble from the seed; the OpenSSL key file only proves it is the same key.
const owner = nobleKeyFromPem(process.env.OWNER_KEY_FILE);
if (!Buffer.from(owner.publicKey).equals(new Key(process.env.OWNER_KEY_FILE).publicKey)) throw new Error('noble and OpenSSL disagree on the owner key');
const vault = vaultAddress(owner.publicKey, deployment.factory);
out.vault = vault;
const sign = (m) => Buffer.from(ml_dsa87.sign(m, owner.secretKey, { context: CONTEXT }));

const relayerPk = loadRelayerKey(process.env.RELAYER_KEY_FILE).getPublicKey().toString();
const accessNonce = async () => BigInt((await rpc.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: relayerId, public_key: relayerPk })).nonce);
const vaultNonce = async () => (await checkVault(rpc.provider, deployment, { vault, publicKey: owner.publicKey })).nonce;

const { server, address } = await startFromEnv({ ...process.env, PORT: '0' });
const base = `http://127.0.0.1:${address.port}`;
const post = async (body) => { const r = await fetch(`${base}/execute`, { method: 'POST', body }); return { status: r.status, body: await r.json() }; };

try {
  // 1. Sign as the wallet does: preflight, then a message for the current nonce and window.
  const nonce = await vaultNonce();
  const height = BigInt((await rpc.call('block', { finality: 'final' })).header.height);
  const message = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: relayerId, amount: AMOUNT, nonce, issued: height, expiry: height + 600n });
  const body = Buffer.concat([sign(message), message]);
  step('wallet preflight and noble ML-DSA-87 signature', true, { detail: `vault nonce ${nonce}, final height ${height}` });

  // 2. Relay it and follow the outcome to delivery.
  const sent = await post(body);
  const tx = sent.body.transaction;
  step('relayer accepts and returns a transaction hash', sent.status === 200 && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx ?? ''), { tx, detail: `HTTP ${sent.status}` });
  const seen = [];
  let status;
  for (let i = 0; i < 30; i++) {
    status = await (await fetch(`${base}/outcome/${tx}`)).json();
    if (seen.at(-1) !== status.status) seen.push(status.status);
    if (status.status === 'delivered' || status.status === 'failed') break;
    await sleep(2000);
  }
  step('outcome followed to delivered', status.status === 'delivered', { tx, detail: seen.join(' -> ') });
  const final = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: tx, sender_account_id: relayerId, wait_until: 'FINAL' });
  const transfer = final.receipts.find((r) => r.predecessor_id === vault)?.receipt.Action.actions[0].Transfer;
  const attached = final.transaction.actions[0].FunctionCall;
  step('on-chain: execute with 30 Tgas and no deposit, then 0.01 NEAR from the vault to the signed receiver',
    BigInt(attached.gas) === 30n * 10n ** 12n && attached.deposit === '0' && transfer?.deposit === AMOUNT.toString() && final.transaction.receiver_id === vault,
    { tx, detail: `gas ${attached.gas}, deposit ${attached.deposit}, transfer ${transfer?.deposit}` });

  // 3. The same body again, then a new signature of the same message: same hash, no second payment.
  const keysBefore = await accessNonce();
  const repeat = await post(body);
  const resigned = await post(Buffer.concat([sign(message), message]));
  await sleep(4000);
  const nonceAfter = await vaultNonce();
  const keysAfter = await accessNonce();
  step('repeat returns the same hash, nothing resubmitted',
    repeat.status === 200 && repeat.body.transaction === tx && resigned.body.transaction === tx && nonceAfter === nonce + 1n && keysAfter === keysBefore,
    { tx, detail: `vault nonce ${nonce} -> ${nonceAfter}, relayer access-key nonce ${keysBefore} -> ${keysAfter}` });

  // 4. A tampered signature for the next nonce: refused before any transaction.
  const h2 = BigInt((await rpc.call('block', { finality: 'final' })).header.height);
  const next = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: relayerId, amount: AMOUNT, nonce: nonceAfter, issued: h2, expiry: h2 + 600n });
  const bad = sign(next);
  bad[100] ^= 1;
  const refused = await post(Buffer.concat([bad, next]));
  await sleep(4000);
  const keysLast = await accessNonce();
  const nonceLast = await vaultNonce();
  step('tampered signature refused, no transaction sent',
    refused.status === 422 && refused.body.error === 'invalid signature' && !refused.body.transaction && keysLast === keysAfter && nonceLast === nonceAfter,
    { detail: `HTTP ${refused.status} ${refused.body.error}; relayer access-key nonce ${keysAfter} -> ${keysLast}` });

  const health = await (await fetch(`${base}/health`)).json();
  out.spent_budget_yocto = health.spent_yocto;
  out.cap_yocto = health.cap_yocto;
} finally {
  server.closeAllConnections();
  server.close();
}

const fails = out.steps.filter((s) => !s.ok).length;
writeFileSync(new URL('../evidence/relayer-testnet.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`${out.steps.length - fails}/${out.steps.length} passed`);
process.exitCode = fails ? 1 : 0;
