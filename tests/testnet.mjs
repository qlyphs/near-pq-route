// Deploys build/pq87_near.wasm to a NEAR testnet sub-account, runs every vector and records gas in evidence/testnet.json.
// Usage: PARENT_ACCOUNT=<id> PARENT_KEY_FILE=<file> SPIKE_KEY_FILE=<file> node tests/testnet.mjs
import { connect, KeyPair, keyStores, utils } from 'near-api-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const NODE = process.env.NEAR_RPC ?? 'https://rpc.testnet.near.org';
const parentId = process.env.PARENT_ACCOUNT;
const spikeId = `pq87-spike.${parentId}`;
const MAX_GAS = 300n * 10n ** 12n;
const tera = (g) => Number(BigInt(g) * 1000n / 10n ** 12n) / 1000;

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', parentId, KeyPair.fromString(readFileSync(process.env.PARENT_KEY_FILE, 'utf8').trim()));
if (!existsSync(process.env.SPIKE_KEY_FILE)) {
  writeFileSync(process.env.SPIKE_KEY_FILE, KeyPair.fromRandom('ed25519').toString() + '\n', { mode: 0o600 });
}
const spikeKey = KeyPair.fromString(readFileSync(process.env.SPIKE_KEY_FILE, 'utf8').trim());
await keyStore.setKey('testnet', spikeId, spikeKey);
const near = await connect({ networkId: 'testnet', nodeUrl: NODE, keyStore });

const spike = await near.account(spikeId);
const exists = await spike.state().then(() => true, () => false);
if (!exists) {
  const parent = await near.account(parentId);
  await parent.createAccount(spikeId, spikeKey.getPublicKey(), utils.format.parseNearAmount('1'));
}
const deploy = await spike.deployContract(readFileSync('build/pq87_near.wasm'));

const { vectors } = JSON.parse(readFileSync('fixtures/vectors.json', 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const encode = (v) => {
  const ctx = hex(v.context);
  return Buffer.concat([hex(v.pk), hex(v.signature), Buffer.from([ctx.length]), ctx, hex(v.message)]);
};

const out = { network: 'testnet', contract: spikeId, deploy_tx: deploy.transaction.hash, vectors: [] };
let failures = 0;
for (const v of vectors) {
  const r = await spike.functionCall({ contractId: spikeId, methodName: 'verify', args: encode(v), gas: MAX_GAS });
  const value = r.status.SuccessValue;
  const got = value === undefined ? null : Buffer.from(value, 'base64').toString() === '1';
  const call = r.receipts_outcome[0].outcome.gas_burnt;
  const tx = r.transaction_outcome.outcome.gas_burnt + r.receipts_outcome.reduce((s, o) => s + o.outcome.gas_burnt, 0);
  const ok = got === v.valid;
  if (!ok) failures++;
  out.vectors.push({ name: v.name, expected: v.valid, got, ok, tx: r.transaction.hash, call_tgas: tera(call), tx_tgas: tera(tx), logs: r.receipts_outcome[0].outcome.logs });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${v.name.padEnd(32)} call=${tera(call)} Tgas tx=${r.transaction.hash}`);
}
writeFileSync('evidence/testnet.json', JSON.stringify(out, null, 2) + '\n');
console.log(`${failures} failures; contract ${spikeId}`);
process.exitCode = failures ? 1 : 0;
