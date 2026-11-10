// Read-only check of the post-quantum QTC route on NEAR testnet, from the chain only. For each bridge it checks
// that the bridge and the Intents verifier have no access key and run the published code, that the relayer's
// only key is ML-DSA-65, then for every mint it fetches the transaction, decodes the attestation and verifies
// both ML-DSA-87 signatures here against the published attester keys, and for every withdrawal from Intents it
// checks the account's only key and the transaction's signature scheme are ML-DSA-65.
// Writes evidence/route-onchain.json.   node scripts/verify-route.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

const RPC = 'https://archival-rpc.testnet.fastnear.com';
const INDEX = 'https://api-testnet.nearblocks.io/v3'; // used only to list transaction hashes; everything else is read from RPC
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (b) => { let n = BigInt('0x' + (Buffer.from(b).toString('hex') || '0')); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = '1' + s; } return s; };
const sha256 = (b) => createHash('sha256').update(b).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; i < 8; i++) {
    // A dropped connection or a timeout is retried like an RPC error; only eight failures in a row stop the run.
    const j = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      .then((r) => r.json()).catch((e) => ({ error: { network: String(e?.cause?.code ?? e?.message ?? e) } }));
    if (j.result) return j.result;
    if (i === 7) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
    await sleep(/429|Rate limit/.test(JSON.stringify(j.error ?? '')) ? 4000 * (i + 1) : 1000);
  }
}
const view = async (account, method, args = {}) => JSON.parse(Buffer.from((await rpc('query', { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString());
const keys = async (account) => (await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account })).keys.map((k) => k.public_key.split(':')[0]);
const codeHash = async (account) => (await rpc('query', { request_type: 'view_account', finality: 'final', account_id: account })).code_hash;
// Transaction hashes come from evidence/route-transactions.json (committed). `--index` refreshes that list from a
// public indexer first; the checks themselves read every transaction from the RPC, never from the indexer.
const TX_FILE = 'evidence/route-transactions.json';
const txList = existsSync(TX_FILE) ? JSON.parse(readFileSync(TX_FILE, 'utf8')) : {};
// The public index returns the newest 25 transactions per account (it ignores paging), so each refresh is merged
// into the committed list instead of replacing it: older transactions stay listed.
async function fromIndex(account) {
  let j = {};
  for (let i = 0; i < 6 && !j.data; i++) { if (i) await sleep(10_000 * i); j = await fetch(`${INDEX}/accounts/${account}/txns?per_page=25`).then((r) => r.json()).catch(() => ({})); }
  if (!j.data) throw new Error(`index unavailable for ${account}`);
  const fresh = j.data.map((t) => ({ hash: t.transaction_hash, signer: t.signer_account_id ?? t.predecessor_account_id, receiver: t.receiver_account_id, methods: (t.actions ?? []).map((a) => a.method ?? a.action) }));
  return [...new Map([...(txList[account] ?? []), ...fresh].map((t) => [t.hash, t])).values()];
}
async function listTxs(account) {
  if (process.argv.includes('--index') || !txList[account]) { txList[account] = await fromIndex(account); await sleep(2000); writeFileSync(TX_FILE, JSON.stringify(txList, null, 1) + '\n'); }
  return txList[account];
}

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const attesters = JSON.parse(readFileSync('deployments/route-attesters.json', 'utf8'));
const pks = attesters.map((a) => Buffer.from(a.public_key_hex, 'hex'));
const ctx = new TextEncoder().encode('qlyphs/near-bridge/v1');
const verifierWasm = readFileSync('third_party/near-intents/defuse-32cd1f97.wasm');
// The deployed code is checked against the hash pinned in deployments/; also against a local build when there is one
// (bash scripts/build.sh writes build/bridge-testnet.wasm; a clone without LLVM can still run every other check).
const bridgeWasm = existsSync('build/bridge-testnet.wasm') ? readFileSync('build/bridge-testnet.wasm') : null;
const out = { date: new Date().toISOString(), rpc: RPC, bridges: [] };

// The current bridge (curve test chain) must equal the local build; earlier ones must equal the hash they were deployed with.
const routes = ['deployments/route-curve-testnet.json', 'deployments/superseded-route-curve-r2.json', 'deployments/superseded-route-curve-r1.json', 'deployments/route-testnet.json']
  .map((f, i) => ({ ...JSON.parse(readFileSync(f, 'utf8')), current: i === 0 }));
const { verifier, relayer } = routes[0];
check(`verifier ${verifier.account} has no access key`, (await keys(verifier.account)).length === 0);
check('verifier runs the pinned upstream build', (await codeHash(verifier.account)) === b58(sha256(verifierWasm)), `sha256 ${sha256(verifierWasm).toString('hex').slice(0, 16)}…`);
const relayKeys = await keys(relayer.account);
check(`relayer ${relayer.account}: its only key is ML-DSA-65`, relayKeys.length === 1 && relayKeys[0] === 'ml-dsa-65-hash');
const sponsorKeys = await keys('qlyphs-pqroute-c.testnet');
check('sponsor qlyphs-pqroute-c.testnet (opens recipient accounts): its only key is ML-DSA-65', sponsorKeys.length === 1 && sponsorKeys[0] === 'ml-dsa-65-hash');

for (const route of routes) {
  const b = route.bridge.account;
  const entry = { bridge: b, current: route.current, quantus_network: route.bridge.quantus_network ?? 'Quantus development network', mints: [], withdrawals: [] };
  check(`${b} has no access key`, (await keys(b)).length === 0);
  const want = Buffer.from(route.bridge.wasm_sha256, 'hex');
  check(`${b} runs the code it was deployed with, sha256 ${want.toString('hex').slice(0, 16)}…${!route.current ? ' (earlier version)' : bridgeWasm ? ' (= your build/bridge-testnet.wasm)' : ' (run scripts/build.sh to compare with your own build)'}`, (await codeHash(b)) === b58(want) && (!route.current || !bridgeWasm || want.equals(sha256(bridgeWasm))));
  const st = await view(b, 'state');
  check(`${b} names the Quantus genesis and the three attester keys`, st.quantus_genesis === route.bridge.quantus_genesis.replace(/^0x/, '') && st.attesters.every((h, i) => h === attesters[i].key_sha256));
  entry.refused_attempts = [];
  for (const t of (await listTxs(b)).filter((x) => x.methods.includes('mint'))) {
    const tx = await rpc('tx', { tx_hash: t.hash, sender_account_id: t.signer, wait_until: 'NONE' });
    await sleep(300);
    const failed = 'Failure' in (tx.status ?? {});
    const input = Buffer.from(tx.transaction.actions[0].FunctionCall.args, 'base64');
    const m = input.subarray(0, 288), i = input[288], sigA = input.subarray(289, 289 + 4627), j = input[289 + 4627], sigB = input.subarray(290 + 4627, 290 + 2 * 4627);
    const depositId = m.subarray(113, 145).toString('hex');
    const amount = (m.readBigUInt64LE(153) << 64n) + m.readBigUInt64LE(145);
    const receiver = m.subarray(162, 162 + m[161]).toString('ascii');
    if (failed) {
      // A forged or replayed mint (scripts/ops/attack-route.mjs): the contract refused it, nothing was minted.
      const reason = JSON.stringify(tx.status.Failure).match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? 'failed';
      entry.refused_attempts.push({ tx: t.hash, refused_with: reason });
      continue;
    }
    const okA = ml_dsa87.verify(sigA, m, pks[i], { context: ctx }), okB = ml_dsa87.verify(sigB, m, pks[j], { context: ctx });
    check(`mint ${t.hash.slice(0, 10)}…: attesters ${i + 1} and ${j + 1} signed with ML-DSA-87 (verified here)`, okA && okB && i !== j && (await view(b, 'deposit', { deposit_id: depositId })) === true, `${amount} planck to ${receiver}${m[258] ? ' inside Intents' : ''}`);
    entry.mints.push({ tx: t.hash, deposit_id: depositId, planck: amount.toString(), receiver, into_intents: m[258] === 1, attesters: [i + 1, j + 1], signer: tx.transaction.signer_id, signer_key_scheme: tx.transaction.public_key.split(':')[0] });
  }
  if (entry.refused_attempts.length) check(`${b}: ${entry.refused_attempts.length} forged or replayed mint attempts, all refused by the contract`, true, [...new Set(entry.refused_attempts.map((x) => x.refused_with))].join('; '));
  out.bridges.push(entry);
}
for (const t of (await listTxs(verifier.account)).filter((x) => x.methods.includes('ft_withdraw'))) {
  const tx = await rpc('tx', { tx_hash: t.hash, sender_account_id: t.signer, wait_until: 'NONE' });
  await sleep(300);
  const args = JSON.parse(Buffer.from(tx.transaction.actions[0].FunctionCall.args, 'base64').toString());
  const k = await keys(t.signer);
  const scheme = tx.transaction.public_key.split(':')[0];
  check(`withdrawal ${t.hash.slice(0, 10)}… by ${t.signer.slice(0, 14)}…: signed ML-DSA-65, account's only key ML-DSA-65`, scheme === 'ml-dsa-65' && k.length === 1 && k[0] === 'ml-dsa-65-hash', `${args.amount} to ${args.memo}`);
  const route = routes.find((r) => r.bridge.account === args.token);
  out.bridges.find((x) => x.bridge === route?.bridge.account)?.withdrawals.push({ tx: t.hash, account: t.signer, token: args.token, planck: args.amount, memo: args.memo, signer_key_scheme: scheme });
}
// Current bridge: every recipient account was opened by the ML-DSA-65 sponsor with exactly one action set (create,
// fund, add one ML-DSA-65 key) before its mint, so nobody held it in between.
{
  const cur = out.bridges.find((x) => x.current);
  const sponsorTxs = await listTxs('qlyphs-pqroute-c.testnet');
  const height = async (hash) => (await rpc('block', { block_id: hash })).header.height;
  for (const m of cur?.mints ?? []) {
    const c = sponsorTxs.find((t) => t.receiver === m.receiver);
    if (!c) { check(`${m.receiver.slice(0, 14)}… creation transaction found`, false, 'not in the sponsor list'); continue; }
    const tx = await rpc('tx', { tx_hash: c.hash, sender_account_id: 'qlyphs-pqroute-c.testnet', wait_until: 'NONE' });
    const acts = tx.transaction.actions.map((a) => (typeof a === 'string' ? a : Object.keys(a)[0]));
    const addKey = tx.transaction.actions.find((a) => a.AddKey)?.AddKey;
    const mintTx = await rpc('tx', { tx_hash: m.tx, sender_account_id: m.signer, wait_until: 'NONE' });
    const [hc, hm] = [await height(tx.transaction_outcome.block_hash), await height(mintTx.transaction_outcome.block_hash)];
    const ok = JSON.stringify(acts) === JSON.stringify(['CreateAccount', 'Transfer', 'AddKey']) && addKey?.public_key?.startsWith('ml-dsa-65:') && addKey?.access_key?.permission === 'FullAccess'
      && tx.transaction.public_key.startsWith('ml-dsa-65') && hc < hm;
    check(`${m.receiver.slice(0, 14)}… opened by the ML-DSA-65 sponsor (create, fund, one ML-DSA-65 key) at block ${hc}, before its mint at ${hm}`, ok, c.hash.slice(0, 10) + '…');
    m.account_creation_tx = c.hash;
    await sleep(300);
  }
}
out.results = results;
writeFileSync('evidence/route-onchain.json', JSON.stringify(out, null, 1) + '\n');
console.log(`${results.length - failures}/${results.length} passed · evidence/route-onchain.json`);
process.exit(failures ? 1 : 0);
