// Deploys the route on NEAR testnet: the upstream Intents verifier and the PQ bridge token, each created,
// funded, deployed and initialized in one batch by its parent (no access key ever added), and the relayer,
// an account whose only key is ML-DSA-65. Writes deployments/route-testnet.json. Idempotent per step.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { actions, sendTx } from '@fastnear/api';
import { signerFromPrivateKey } from '@fastnear/utils';
import { signerFromSeed } from '@fastnear/ml-dsa-65';
import { encodeConfig } from '../../sdk/bridge.mjs';

const home = process.env.HOME + '/.qlyphs/near-testnet/';
const classical = (n) => ({ id: `qlyphs-pqroute-${n}.testnet`, signer: signerFromPrivateKey(readFileSync(`${home}qlyphs-pqroute-${n}.key`, 'utf8').trim()) });
const A = classical('a'), B = classical('b'), C = classical('c');
const NEAR = (x) => (BigInt(Math.round(x * 1000)) * 10n ** 21n).toString();
const rpc = async (method, params) => (await (await fetch('https://rpc.testnet.near.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const exists = async (id) => !!(await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id })).result;
const send = (from, receiverId, acts) => sendTx({ signerId: from.id, signer: from.signer, receiverId, actions: acts, network: 'testnet', waitUntil: 'FINAL' });
const txHash = (r) => JSON.stringify(r).match(/"hash":"([^"]+)"/)?.[1];
// ROUTE_QUANTUS=curve: the bridge bound to the curve test chain (the Qlyphs app's Testnet); default: the devnet.
const curve = process.env.ROUTE_QUANTUS === 'curve';
const file = curve ? 'deployments/route-curve-testnet.json' : 'deployments/route-testnet.json';
const base = curve && existsSync('deployments/route-testnet.json') ? (({ verifier, relayer }) => ({ network: 'testnet', verifier, relayer }))(JSON.parse(readFileSync('deployments/route-testnet.json', 'utf8'))) : { network: 'testnet' };
const out = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : base;
const save = () => writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const verifierId = `intents.${B.id}`, bridgeId = curve ? `pqqtc.${A.id}` : `qtc.${A.id}`, relayId = `relay.${A.id}`;
const verifierWasm = readFileSync('third_party/near-intents/defuse-32cd1f97.wasm');
if (!(await exists(verifierId))) {
  const top = await send(C, B.id, [actions.transfer(NEAR(6))]);
  console.log('topped up', B.id, txHash(top));
  const r = await send(B, verifierId, [actions.createAccount(), actions.transfer(NEAR(14.5)),
    actions.deployContract({ codeBase64: verifierWasm.toString('base64') }),
    actions.functionCall({ methodName: 'new', args: { config: { wnear_id: 'wrap.testnet', fees: { fee: 0, fee_collector: verifierId }, roles: {} } }, gas: '100 Tgas', deposit: '0' })]);
  out.verifier = { account: verifierId, wasm_sha256: sha(verifierWasm), upstream: 'github.com/near/intents@32cd1f97', creation_tx: txHash(r) };
  save(); console.log('verifier', verifierId, out.verifier.creation_tx);
}
const bridgeWasm = readFileSync('build/bridge-testnet.wasm');
if (!(await exists(bridgeId))) {
  const att = JSON.parse(readFileSync(process.env.HOME + '/qlyphs-wqtc-attesters/deployment/attesters.json', 'utf8'));
  const lock = JSON.parse(readFileSync(process.env.HOME + `/qlyphs-wqtc-attesters/deployment/${curve ? 'lock-curve' : 'lock'}.json`, 'utf8'));
  const cfg = encodeConfig({ quantusGenesis: lock.genesis, keys: att.map((a) => Buffer.from(a.publicKey, 'hex')), verifier: verifierId });
  const r = await send(A, bridgeId, [actions.createAccount(), actions.transfer(NEAR(3)),
    actions.deployContract({ codeBase64: bridgeWasm.toString('base64') }),
    actions.functionCall({ methodName: 'new', argsBase64: cfg.toString('base64'), gas: '50 Tgas', deposit: '0' })]);
  out.bridge = { account: bridgeId, quantus_network: curve ? 'curve test chain (Qlyphs DevNet v3, the Qlyphs app Testnet)' : 'Quantus development network', wasm_sha256: sha(bridgeWasm), quantus_genesis: lock.genesis, quantus_lock: lock.address, attesters: att.map((a) => ({ address: a.address, key_sha256: a.keyHash })), creation_tx: txHash(r) };
  save(); console.log('bridge', bridgeId, out.bridge.creation_tx);
}
if (!(await exists(relayId))) {
  const seedFile = `${home}pqroute-relay.seed`;
  if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const relay = signerFromSeed(Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'hex'));
  const r = await send(A, relayId, [actions.createAccount(), actions.transfer(NEAR(2)), actions.addFullAccessKey({ publicKey: relay.publicKey })]);
  out.relayer = { account: relayId, key: 'ML-DSA-65 only', public_key_handle: relay.publicKeyHandle, creation_tx: txHash(r) };
  relay.destroy(); save(); console.log('relayer', relayId, out.relayer.creation_tx);
}
for (const id of [verifierId, bridgeId, relayId]) {
  const k = (await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id })).result.keys;
  console.log(id, 'keys:', k.map((x) => x.public_key.split(':')[0]).join(',') || 'none');
}
