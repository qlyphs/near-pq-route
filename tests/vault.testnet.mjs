// Testnet run: keyless factory (audited), vault created by the factory, preflight, NEAR and wNEAR payments, refusals.
// Writes deployments/testnet.json (the pinned release) and evidence/vault-testnet.json.
// Usage: PARENT_ACCOUNT=<id> PARENT_KEY_FILE=<file> RELAYER_ACCOUNT=<id> RELAYER_KEY_FILE=<file>
//        OWNER_KEY_FILE=<ML-DSA-87 pem, created if absent> [FACTORY_NAME=pq87-vaults] node tests/vault.testnet.mjs
import { connect, KeyPair, keyStores, transactions } from 'near-api-js';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Key, auditFactoryCreation, checkVault, encodeMessage, executeArgs, vaultAddress } from '../sdk/vault.mjs';

const NODE = process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com';
const { PARENT_ACCOUNT: parentId, RELAYER_ACCOUNT: relayerId } = process.env;
// A new factory code needs a new, never-used account id (FACTORY_NAME); a pinned release keeps its own.
const factoryId = `${process.env.FACTORY_NAME ?? 'pq87-vaults'}.${parentId}`;
const TOKEN = 'wrap.testnet';
const TGAS = 10n ** 12n, NEAR = 10n ** 24n;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const vaultWasm = readFileSync('build/vault-testnet.wasm');
const factoryWasm = readFileSync('build/factory-testnet.wasm');

const keyStore = new keyStores.InMemoryKeyStore();
for (const [id, file] of [[parentId, process.env.PARENT_KEY_FILE], [relayerId, process.env.RELAYER_KEY_FILE]]) {
  await keyStore.setKey('testnet', id, KeyPair.fromString(readFileSync(file, 'utf8').trim()));
}
const near = await connect({ networkId: 'testnet', nodeUrl: NODE, keyStore });
const provider = near.connection.provider;
// Public testnet RPCs time out now and then; retry reads only (a signed transaction is never resent here).
const send = provider.sendJsonRpc.bind(provider);
provider.sendJsonRpc = async (method, params) => {
  for (let i = 0; ; i++) {
    try { return await send(method, params); } catch (e) {
      if (!['query', 'block'].includes(method) || i >= 4 || !/fetch failed|ETIMEDOUT/.test(String(e?.cause ?? e))) throw e;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
};
const parent = await near.account(parentId);
const relayer = await near.account(relayerId);
const owner = existsSync(process.env.OWNER_KEY_FILE) ? new Key(process.env.OWNER_KEY_FILE) : Key.generate(process.env.OWNER_KEY_FILE);
const vaultId = vaultAddress(owner.publicKey, factoryId);
const scratch = mkdtempSync(join(tmpdir(), 'qvault-near-'));
const stranger = Key.generate(join(scratch, 'stranger.pem'));

const out = { network: 'testnet', factory: factoryId, vault: vaultId, steps: [] };
const step = (name, ok, extra = {}) => { out.steps.push({ name, ok, ...extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.tx ? ` tx=${extra.tx}` : ''}${extra.detail ? ` (${extra.detail})` : ''}`); };
const failure = (r) => JSON.stringify(r.status.Failure ?? r.receipts_outcome.map((o) => o.outcome.status.Failure).filter(Boolean));
const callTgas = (r) => Number(r.receipts_outcome[0].outcome.gas_burnt) / 1e12;
const view = async (contract, method, args = {}) => {
  const r = await provider.query({ request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString() || 'null');
};
const height = async () => BigInt((await provider.block({ finality: 'final' })).header.height);

const exists = (id) => provider.query({ request_type: 'view_account', finality: 'final', account_id: id }).then(() => true, () => false);
const untilFinal = async (id) => { while (!(await exists(id))) await new Promise((ok) => setTimeout(ok, 1000)); };

// 1. Factory: one batch of CreateAccount, Transfer, DeployContract, then the one-time release audit.
let deployment = existsSync('deployments/testnet.json') ? JSON.parse(readFileSync('deployments/testnet.json', 'utf8')) : null;
if (!deployment) {
  const r = await parent.signAndSendTransaction({ receiverId: factoryId, actions: [
    transactions.createAccount(), transactions.transfer(NEAR / 2n), transactions.deployContract(factoryWasm)] });
  await untilFinal(factoryId);
  deployment = { network: 'testnet', factory: factoryId, factory_sha256: sha(factoryWasm), vault_sha256: sha(vaultWasm),
    factory_creation: { tx: r.transaction.hash, sender: parentId, block_height: (await provider.txStatus(r.transaction.hash, parentId, 'FINAL').then((t) => provider.block({ blockId: t.transaction_outcome.block_hash }))).header.height } };
  writeFileSync('deployments/testnet.json', JSON.stringify(deployment, null, 2) + '\n');
}
const audit = await auditFactoryCreation(provider, { txHash: deployment.factory_creation.tx, sender: deployment.factory_creation.sender, factory: factoryId });
step('factory creation audit: CreateAccount, Transfer, DeployContract only', true, { tx: deployment.factory_creation.tx, detail: `${audit.receipts} receipts` });

// 2. Vault created by the factory, funded with the attached deposit.
if (!(await exists(vaultId))) {
  const r = await parent.functionCall({ contractId: factoryId, methodName: 'create', args: owner.publicKey, gas: 200n * TGAS, attachedDeposit: NEAR / 2n });
  await untilFinal(vaultId);
  step('factory creates the vault at the key-derived address', !r.status.Failure, { tx: r.transaction.hash });
}

// 3. What a wallet checks before signing.
const pre = await checkVault(provider, deployment, { vault: vaultId, publicKey: owner.publicKey });
step('wallet preflight: pinned factory, registry record, code, zero keys, exact storage', true, { detail: `nonce ${pre.nonce} at block ${pre.block}` });

const exec = (sig, msg) => relayer.signAndSendTransaction({ receiverId: vaultId, actions: [
  transactions.functionCall('execute', executeArgs(sig, msg), 100n * TGAS, 0n)], returnError: true });
const message = async (over) => {
  const now = await height();
  const { nonce } = await checkVault(provider, deployment, { vault: vaultId, publicKey: owner.publicKey });
  return encodeMessage({ chain: 'testnet', vault: vaultId, kind: 'near', receiver: parentId, amount: NEAR / 10n, nonce, issued: now, expiry: now + 600n, ...over });
};

// 4. NEAR payment, relayed by an unrelated account.
{
  const before = BigInt((await parent.state()).amount);
  const m = await message({});
  const sig = owner.sign(m);
  const r = await exec(sig, m);
  const after = BigInt((await parent.state()).amount);
  step('NEAR payment of 0.1 NEAR to the signed receiver', !r.status.Failure && after - before === NEAR / 10n, { tx: r.transaction.hash, detail: `${callTgas(r)} Tgas` });
  const replay = await exec(sig, m);
  step('replay refused on-chain', failure(replay).includes('stale or reused nonce'), { tx: replay.transaction.hash });
  const fresh = await message({});
  const t = Buffer.from(fresh); t[212 + 15] = 1;
  const tampered = await exec(owner.sign(fresh), t);
  step('tampered amount refused on-chain', failure(tampered).includes('invalid signature'), { tx: tampered.transaction.hash });
  const m2 = await message({});
  const foreign = await exec(stranger.sign(m2), m2);
  step('foreign ML-DSA-87 key refused on-chain', failure(foreign).includes('invalid signature'), { tx: foreign.transaction.hash });
}

// 5. NEP-141: fund the vault with wNEAR, then pay 0.05 wNEAR out of it.
{
  const deposit = 1250000000000000000000n; // NEP-145 registration on wrap.testnet
  const call = (method, args, amount) => relayer.functionCall({ contractId: TOKEN, methodName: method, args, gas: 30n * TGAS, attachedDeposit: amount });
  for (const id of [relayerId, vaultId]) {
    if (!(await view(TOKEN, 'storage_balance_of', { account_id: id }))) await call('storage_deposit', { account_id: id, registration_only: true }, deposit);
  }
  if (BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vaultId })) < NEAR / 20n) {
    await call('near_deposit', {}, NEAR / 10n);
    await call('ft_transfer', { receiver_id: vaultId, amount: (NEAR / 10n).toString() }, 1n);
  }
  const vaultBefore = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vaultId }));
  const relayerBefore = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: relayerId }));
  const m = await message({ kind: 'ft', token: TOKEN, receiver: relayerId, amount: NEAR / 20n, ftGasTgas: 30 });
  const r = await exec(owner.sign(m), m);
  const vaultAfter = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: vaultId }));
  const relayerAfter = BigInt(await view(TOKEN, 'ft_balance_of', { account_id: relayerId }));
  step('wNEAR (NEP-141) payment of 0.05 out of the vault', !r.status.Failure && vaultBefore - vaultAfter === NEAR / 20n && relayerAfter - relayerBefore === NEAR / 20n,
    { tx: r.transaction.hash, detail: `${callTgas(r)} Tgas, vault wNEAR ${vaultAfter}` });
}

const fails = out.steps.filter((s) => !s.ok).length;
writeFileSync('evidence/vault-testnet.json', JSON.stringify(out, null, 2) + '\n');
console.log(`${out.steps.length - fails}/${out.steps.length} passed; vault ${vaultId}`);
rmSync(scratch, { recursive: true, force: true });
process.exitCode = fails ? 1 : 0;
