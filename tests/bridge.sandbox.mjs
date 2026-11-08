// Sandbox suite for the PQ bridge contract (contract/bridge.c): init rules, 2-of-3 ML-DSA-87 attested mint,
// one mint per deposit, every signed field bound, receipts, transfers, redeem. Writes evidence/bridge-sandbox.json.
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
async function refused(name, call, reason) {
  const r = await call();
  record(name, r.failed && failureText(r).includes(reason), r.failed ? (failureText(r).includes(reason) ? reason : failureText(r).slice(0, 200)) : 'was accepted');
}
const gasOf = (r) => Number(BigInt(r.result.transaction_outcome.outcome.gas_burnt) + r.result.receipts_outcome.reduce((a, x) => a + BigInt(x.outcome.gas_burnt), 0n)) / 1e12;

const dir = mkdtempSync(join(tmpdir(), 'bridge-keys-'));
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const wasm = readFileSync('build/bridge-sandbox.wasm');
  const keys = [0, 1, 2].map((i) => Key.generate(join(dir, `a${i}.pem`)));
  const outsider = Key.generate(join(dir, 'o.pem'));
  const genesis = randomBytes(32);
  const config = encodeConfig({ quantusGenesis: genesis, keys: keys.map((k) => k.publicKey), verifier: 'nocode.test.near' });
  const bridge = await root.createSubAccount('bridge', { initialBalance: 20n * NEAR });
  await bridge.deploy(wasm);
  const alice = await root.createSubAccount('alice', { initialBalance: 5n * NEAR });
  const bob = await root.createSubAccount('bob', { initialBalance: 5n * NEAR });
  const relayer = await root.createSubAccount('relayer', { initialBalance: 50n * NEAR });

  await refused('init only by the bridge account', () => alice.callRaw(bridge, 'new', new Uint8Array(config), { gas: 30n * TGAS }), 'only the bridge account');
  const dup = Buffer.from(config); keys[0].publicKey.copy(dup, 32 + 2592);
  await refused('init refuses duplicate attester keys', () => bridge.callRaw(bridge, 'new', new Uint8Array(dup), { gas: 30n * TGAS }), 'must differ');
  const init = await bridge.callRaw(bridge, 'new', new Uint8Array(config), { gas: 30n * TGAS });
  record('init with genesis and three keys', init.succeeded);
  await refused('init only once', () => bridge.callRaw(bridge, 'new', new Uint8Array(config), { gas: 30n * TGAS }), 'already initialized');
  const st = await bridge.view('state');
  record('state reports genesis and attester key hashes', st.quantus_genesis === genesis.toString('hex') && st.attesters[2] === sha256(keys[2].publicKey).toString('hex') && st.supply === '0');

  const base = { chain: 'sandbox', bridge: bridge.accountId, quantusGenesis: genesis };
  const att = (f) => encodeAttestation({ ...base, depositId: randomBytes(32), amount: 1000n, receiver: alice.accountId, ...f });
  const mint = (input) => relayer.callRaw(bridge, 'mint', new Uint8Array(input), { gas: 300n * TGAS });
  const both = (m, a = 0, b = 1) => [attest(keys[a], a, m), attest(keys[b], b, m)];

  // Refusals.
  { const m = att(); await refused('one attester twice is not a quorum', () => mint(encodeMint(m, [attest(keys[0], 0, m), attest(keys[0], 0, m)])), 'two different attesters'); }
  { const m = att(); await refused('an outsider key is not an attester', () => mint(encodeMint(m, [attest(keys[0], 0, m), attest(outsider, 1, m)])), 'invalid attestation signature'); }
  { const m = att(); await refused('index pointing at another attester', () => mint(encodeMint(m, [attest(keys[0], 0, m), { ...attest(keys[1], 1, m), index: 2 }])), 'invalid attestation signature'); }
  { const m = att(), s = both(m), t = Buffer.from(m); t[145] ^= 1; await refused('signatures do not transfer to a changed amount', () => mint(encodeMint(t, s)), 'invalid attestation signature'); }
  { const m = att(), s = both(m), t = Buffer.from(m); t[162] = 0x62; await refused('signatures do not transfer to a changed receiver', () => mint(encodeMint(t, s)), 'invalid attestation signature'); }
  { const m = att(), s = both(m), t = Buffer.from(m); t[113] ^= 1; await refused('signatures do not transfer to another deposit', () => mint(encodeMint(t, s)), 'invalid attestation signature'); }
  { const m = att({ chain: 'testnet' }); await refused('attestation for another network', () => mint(encodeMint(m, both(m))), 'another network'); }
  { const m = att({ bridge: 'other.test.near' }); await refused('attestation for another bridge', () => mint(encodeMint(m, both(m))), 'another bridge'); }
  { const m = att({ quantusGenesis: randomBytes(32) }); await refused('attestation for another Quantus chain', () => mint(encodeMint(m, both(m))), 'another Quantus chain'); }
  { const m = att(); m[287] = 1; await refused('nonzero reserved bytes', () => mint(encodeMint(m, both(m))), 'bad padding'); }
  { const r = randomBytes(100), m = att({ receipt: r }); await refused('receipt must match its commitment', () => mint(encodeMint(m, both(m), randomBytes(100))), 'receipt does not match'); }
  { const m = att(); await refused('truncated input', () => mint(encodeMint(m, both(m)).subarray(0, 600)), 'bad mint input'); }
  record('refusals minted nothing', (await bridge.view('ft_total_supply')) === '0');

  // Valid mint, once per deposit.
  const dep = randomBytes(32), receipt = randomBytes(1600);
  const m1 = att({ depositId: dep, amount: 5_000_000_000_000n, receipt });
  const r1 = await mint(encodeMint(m1, both(m1, 1, 2), receipt));
  record('2-of-3 attested deposit mints', r1.succeeded && (await bridge.view('ft_balance_of', { account_id: alice.accountId })) === '5000000000000', r1.succeeded ? `${gasOf(r1)} Tgas` : failureText(r1).slice(0, 200));
  record('deposit recorded as minted', (await bridge.view('deposit', { deposit_id: dep.toString('hex') })) === true);
  await refused('same deposit cannot mint twice', () => mint(encodeMint(m1, both(m1, 0, 2), receipt)), 'deposit already minted');
  { const m = att({ depositId: dep, amount: 1n }); await refused('same deposit, new amount, still once', () => mint(encodeMint(m, both(m))), 'deposit already minted'); }
  const page = await bridge.view('receipts', { from: '0', limit: '8' });
  record('encrypted receipt published and readable by everyone', page.length === 1 && page[0] === receipt.toString('hex'));

  // Transfers and redeem.
  await refused('transfer to an unregistered account', () => alice.callRaw(bridge, 'ft_transfer', { receiver_id: bob.accountId, amount: '1' }, { attachedDeposit: 1n }), 'not a registered holder');
  await bob.call(bridge, 'storage_deposit', {}, { attachedDeposit: 1250000000000000000000n });
  const tr = await alice.callRaw(bridge, 'ft_transfer', { receiver_id: bob.accountId, amount: '1000000000000' }, { attachedDeposit: 1n });
  record('transfer to a registered holder', tr.succeeded && (await bridge.view('ft_balance_of', { account_id: bob.accountId })) === '1000000000000');
  const qto = randomBytes(32).toString('hex');
  await refused('redeem needs exactly 1 yoctoNEAR', () => alice.callRaw(bridge, 'redeem', { amount: '1', quantus_to: qto }), 'exactly 1 yoctoNEAR');
  await refused('redeem refuses a bad Quantus account', () => alice.callRaw(bridge, 'redeem', { amount: '1', quantus_to: 'zz' + qto.slice(2) }, { attachedDeposit: 1n }), 'lowercase hex');
  await refused('redeem more than the balance', () => alice.callRaw(bridge, 'redeem', { amount: '9000000000000', quantus_to: qto }, { attachedDeposit: 1n }), 'insufficient balance');
  const rd = await alice.callRaw(bridge, 'redeem', { amount: '2000000000000', quantus_to: qto }, { attachedDeposit: 1n });
  const rec = await bridge.view('redemption', { id: '0' });
  record('redeem burns and records the Quantus destination', rd.succeeded && rec?.amount === '2000000000000' && rec.quantus_to === qto && rec.account === alice.accountId && (await bridge.view('ft_total_supply')) === '3000000000000');
  // Mode 1 into a verifier without code: the receiver call fails and resolve gives the tokens to the receiver.
  { const m = att({ intents: true, amount: 77n }); const r = await mint(encodeMint(m, both(m)));
    record('intents-mode mint whose verifier call fails ends with the receiver', r.succeeded && (await bridge.view('ft_balance_of', { account_id: 'nocode.test.near' })) === '0' && (await bridge.view('ft_balance_of', { account_id: alice.accountId })) === '2000000000077'); }
  { const m = att(); m[258] = 2; await refused('unknown mint mode', () => mint(encodeMint(m, both(m))), 'unknown mint mode'); }
  // near-sdk sends optional fields as null.
  { const r = await bob.callRaw(bridge, 'ft_transfer', new Uint8Array(Buffer.from(JSON.stringify({ receiver_id: alice.accountId, amount: '1', memo: null }))), { attachedDeposit: 1n });
    record('memo null is accepted as absent', r.succeeded, r.succeeded ? '' : failureText(r).slice(0, 160)); }
  // Intents withdrawal convention: ft_transfer to the bridge itself with memo WITHDRAW_TO:<hex>.
  await refused('transfer to the bridge without WITHDRAW_TO is refused', () => bob.callRaw(bridge, 'ft_transfer', { receiver_id: bridge.accountId, amount: '1' }, { attachedDeposit: 1n }), 'needs memo WITHDRAW_TO');
  const wq = randomBytes(32).toString('hex');
  const w = await bob.callRaw(bridge, 'ft_transfer', { receiver_id: bridge.accountId, amount: '400000000000', memo: `WITHDRAW_TO:${wq}` }, { attachedDeposit: 1n });
  const wrec = await bridge.view('redemption', { id: '1' });
  record('WITHDRAW_TO transfer burns and records like redeem', w.succeeded && wrec?.quantus_to === wq && wrec.account === bob.accountId && (await bridge.view('ft_balance_of', { account_id: bob.accountId })) === '599999999999');
  writeFileSync('evidence/bridge-sandbox.json', JSON.stringify({ date: new Date().toISOString().slice(0, 10), wasm_sha256: sha256(wasm).toString('hex'), results }, null, 2) + '\n');
} finally {
  await worker.tearDown();
}
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
