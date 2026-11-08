// The PQ bridge against the unmodified upstream NEAR Intents verifier (third_party/near-intents): an attested
// deposit minted straight into the verifier, the holder's balance inside Intents, and a withdrawal to a Quantus
// account through ft_withdraw + WITHDRAW_TO. Writes evidence/intents-sandbox.json.
import { Worker } from 'near-workspaces';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Key } from '../sdk/vault.mjs';
import { encodeAttestation, encodeMint, encodeConfig, attest, sha256 } from '../sdk/bridge.mjs';

const TGAS = 10n ** 12n, NEAR = 10n ** 24n;
const results = []; let failures = 0;
function record(name, ok, detail = '') { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); }
const failureText = (r) => JSON.stringify(r.Failure ?? r.receiptFailures ?? r.result?.status ?? '');

const dir = mkdtempSync(join(tmpdir(), 'intents-keys-'));
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const verifierWasm = readFileSync('third_party/near-intents/defuse-32cd1f97.wasm');
  const bridgeWasm = readFileSync('build/bridge-sandbox.wasm');
  const keys = [0, 1, 2].map((i) => Key.generate(join(dir, `a${i}.pem`)));
  const genesis = randomBytes(32);

  const verifier = await root.createSubAccount('intents', { initialBalance: 30n * NEAR });
  await verifier.deploy(verifierWasm);
  await verifier.call(verifier, 'new', { config: { wnear_id: 'wrap.test.near', fees: { fee: 0, fee_collector: verifier.accountId }, roles: {} } }, { gas: 100n * TGAS });
  record('upstream verifier deployed and initialized with no roles', true, sha256(verifierWasm).toString('hex').slice(0, 16));

  const bridgeId = `qtc.${root.accountId}`;
  const cfg = encodeConfig({ quantusGenesis: genesis, keys: keys.map((k) => k.publicKey), verifier: verifier.accountId });
  const created = await root.batch(bridgeId).createAccount().transfer(5n * NEAR).deployContract(bridgeWasm)
    .functionCall('new', new Uint8Array(cfg), { gas: 50n * TGAS }).transact();
  record('bridge created, deployed and initialized in one batch, no key', created.succeeded && (await root.getAccount(bridgeId).viewAccessKeys(bridgeId)).keys.length === 0);
  const bridge = root.getAccount(bridgeId);

  const alice = await root.createSubAccount('alice', { initialBalance: 5n * NEAR });
  const relayer = await root.createSubAccount('relayer', { initialBalance: 20n * NEAR });
  const amount = 7_000_000_000_000n;
  const m = encodeAttestation({ chain: 'sandbox', bridge: bridgeId, quantusGenesis: genesis, depositId: randomBytes(32), amount, receiver: alice.accountId, intents: true });
  const r = await relayer.callRaw(bridgeId, 'mint', new Uint8Array(encodeMint(m, [attest(keys[0], 0, m), attest(keys[2], 2, m)])), { gas: 300n * TGAS });
  const tokenId = `nep141:${bridgeId}`;
  const inside = await verifier.view('mt_balance_of', { account_id: alice.accountId, token_id: tokenId });
  record('attested deposit lands inside Intents for the receiver', r.succeeded && inside === amount.toString(), r.succeeded ? `balance ${inside}` : failureText(r).slice(0, 300));
  record('the verifier holds the tokens on the bridge', (await bridge.view('ft_balance_of', { account_id: verifier.accountId })) === amount.toString());

  const qto = randomBytes(32).toString('hex');
  const w = await alice.callRaw(verifier, 'ft_withdraw', { token: bridgeId, receiver_id: bridgeId, amount: '3000000000000', memo: `WITHDRAW_TO:${qto}` }, { attachedDeposit: 1n, gas: 100n * TGAS });
  const rec = await bridge.view('redemption', { id: '0' });
  record('ft_withdraw with WITHDRAW_TO burns and records the Quantus destination', w.succeeded && rec?.quantus_to === qto && rec.amount === '3000000000000' && rec.account === verifier.accountId, w.succeeded ? '' : failureText(w).slice(0, 300));
  record('balances after withdrawal', (await verifier.view('mt_balance_of', { account_id: alice.accountId, token_id: tokenId })) === '4000000000000' && (await bridge.view('ft_total_supply')) === '4000000000000');
  const bad = await alice.callRaw(verifier, 'ft_withdraw', { token: bridgeId, receiver_id: bridgeId, amount: '1', memo: 'WITHDRAW_TO:nothex' }, { attachedDeposit: 1n, gas: 100n * TGAS });
  record('a malformed withdrawal is refunded inside Intents', (await verifier.view('mt_balance_of', { account_id: alice.accountId, token_id: tokenId })) === '4000000000000' && (await bridge.view('state')).redemptions === 1, bad.succeeded ? 'refunded' : failureText(bad).slice(0, 120));
  writeFileSync('evidence/intents-sandbox.json', JSON.stringify({ date: new Date().toISOString().slice(0, 10), verifier_sha256: sha256(verifierWasm).toString('hex'), bridge_sha256: sha256(bridgeWasm).toString('hex'), results }, null, 2) + '\n');
} finally {
  await worker.tearDown();
}
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
