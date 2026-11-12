// The Quantus side of the route, checked on the Quantus test chain's public RPC:
//   - the lock is a native multisig whose signers and threshold (2 of 3) are read from chain state;
//   - every mint that verify-route.mjs verified on NEAR is backed by a lock deposit of the same amount: the deposit id
//     is recomputed from the block hash and extrinsic index, and that extrinsic dispatched successfully and emitted a
//     Balances.Transfer of exactly that amount to the lock;
//   - for each redemption the NEAR bridge records, a distinct release extrinsic dispatched successfully, the lock's
//     multisig executed exactly the transfer to the recorded destination for the recorded amount with a successful
//     inner result, approved by two distinct signers of the lock, and the transfer event followed;
//   - the verified mints, unique, minus the redemptions equal the bridge's supply, and the lock's balance read from
//     the RPC at a recorded block is at least the bridge's supply now.
// The index is a snapshot taken at one NEAR block (index.near_block): steps 3 and 4 read the bridge at that block, so
// transfers made later (anyone can use the hosted app) do not break a run. They are counted and reported, not
// checked; refreshing the index covers them.
// This does not establish the absence of other transfers out of the lock, and it does not re-verify the Quantus
// signatures themselves (the chain did). It uses the Qlyphs test indexer for one thing only: finding the block and
// index of a release extrinsic from its hash; the hash is then recomputed from the bytes the RPC returns.
//
//   node scripts/verify-route.mjs      # first: writes evidence/route-onchain.json (the mints, verified on NEAR)
//   node scripts/verify-quantus.mjs    # then this; writes evidence/route-quantus.json
import { readFileSync, writeFileSync } from 'node:fs';
import { ApiPromise, HttpProvider } from '@polkadot/api';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { firstDuplicate, lockDeposit, lockRelease, transferCall } from './lib/quantus-evidence.mjs';

const QUANTUS_RPC = 'https://testnet-rpc.qlyphs.com';
const INDEXER = 'https://testnet.qlyphs.com/api';
// Reading the bridge at the index's block needs an archival node once that block is a few days old.
const NEAR_RPCS = [...(process.env.NEAR_RPC ? [process.env.NEAR_RPC] : []), 'https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
const lockDeployment = JSON.parse(readFileSync('deployments/quantus-lock-curve.json', 'utf8'));
const index = JSON.parse(readFileSync('evidence/route-quantus-index.json', 'utf8'));
const onchainBytes = readFileSync('evidence/route-onchain.json');
const onchain = JSON.parse(onchainBytes.toString('utf8'));
const LOCK = '0x' + lockDeployment.accountId.replace(/^0x/, '');

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(urls, method, params) {
  // A list of endpoints (NEAR) is rotated on any failure, rate limits included; Quantus has one endpoint.
  const list = Array.isArray(urls) ? urls : [urls];
  for (let i = 0; ; i++) {
    const url = list[i % list.length];
    try {
      const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j.result;
    } catch (e) { if (i >= 5) throw new Error(`${url} ${method}: ${e.message}`); await sleep(2000 * (i + 1)); }
  }
}

// 0. The input: the NEAR report must be a passing run on the current bridge, and the index must not repeat itself.
const bridge = onchain.bridges.find((b) => b.current);
const upstreamOk = onchain.results.length > 0 && onchain.results.every((r) => r.ok) && bridge?.bridge === index.bridge;
check('the NEAR report is a passing verify-route run on the bridge this index names', upstreamOk, `${onchain.results.length} checks at ${onchain.date}, bridge ${bridge?.bridge}`);
const dupMint = firstDuplicate(bridge.mints.map((m) => m.tx)) ?? firstDuplicate(bridge.mints.map((m) => m.deposit_id));
const dupIndex = firstDuplicate(index.deposits.map((d) => d.deposit_id)) ?? firstDuplicate(index.releases.map((r) => String(r.redemption))) ?? firstDuplicate(index.releases.map((r) => r.execute));
check('mints, deposits and releases are each listed once', !dupMint && !dupIndex, dupMint || dupIndex ? `repeated: ${dupMint ?? dupIndex}` : `${bridge.mints.length} mints, ${index.deposits.length} deposits, ${index.releases.length} releases`);

const api = await ApiPromise.create({ provider: new HttpProvider(QUANTUS_RPC), noInitWarn: true, types: { U512: 'UInt<512>' } });
const genesis = (await api.rpc.chain.getBlockHash(0)).toHex();
check('the Quantus RPC serves the test chain the lock lives on', genesis === lockDeployment.genesis, genesis);
const finalizedHash = (await api.rpc.chain.getFinalizedHead()).toHex();
const finalized = (await api.rpc.chain.getHeader(finalizedHash)).number.toNumber();
const atFinal = await api.at(finalizedHash);

// 1. The lock: a native multisig of the three attester keys, threshold 2, read from chain state.
const ms = (await atFinal.query.multisig.multisigs(LOCK)).toJSON();
const signers = (ms?.signers ?? []).map((s) => api.createType('AccountId32', s).toHex());
const wantSigners = lockDeployment.signers.map((s) => api.createType('AccountId32', s).toHex()).sort();
check('the lock is a native 2-of-3 multisig of the three attester keys', ms?.threshold === 2 && signers.length === 3 && [...signers].sort().join() === wantSigners.join(),
  `threshold ${ms?.threshold}, ${signers.length} signers, at finalized block ${finalized}`);

/** The events of one extrinsic (phase ApplyExtrinsic(index)), as plain data. */
async function eventsOf(blockHash, at) {
  const records = await (await api.at(blockHash)).query.system.events();
  const out = [];
  for (const r of records) {
    if (!r.phase.isApplyExtrinsic || r.phase.asApplyExtrinsic.toNumber() !== at) continue;
    const data = {};
    r.event.meta.fields.forEach((f, i) => {
      const v = r.event.data[i], type = v.toRawType();
      const isAccount = (t) => /AccountId|\[u8;32\]/.test(t);
      data[f.name.toString()] = Array.isArray(v) && v.length && isAccount(v[0].toRawType()) ? v.map((a) => a.toHex()) : /AccountId|\[u8;32\]/.test(type) ? v.toHex() : /^Bytes$|Vec<u8>/.test(type) ? v.toHex() : /^(u|i)\d+$|Compact|Balance/.test(type) ? v.toString() : v.toJSON();
    });
    out.push({ section: r.event.section, method: r.event.method, data });
  }
  return out;
}
async function extrinsicAt(block, at) {
  const blockHash = (await api.rpc.chain.getBlockHash(block)).toHex();
  const body = await post(QUANTUS_RPC, 'chain_getBlock', [blockHash]);
  const x = body?.block?.extrinsics?.[at];
  if (!x) throw new Error(`no extrinsic ${at} in block ${block}`);
  return { blockHash, hash: '0x' + hex(blake2b(unhex(x), { dkLen: 32 })) };
}

// The bridge at the index's NEAR block (the snapshot), and now.
const stateAt = async (at) => {
  const r = await post(NEAR_RPCS, 'query', { request_type: 'call_function', ...at, account_id: bridge.bridge, method_name: 'state', args_base64: Buffer.from('{}').toString('base64') });
  return { block: r.block_hash, height: r.block_height, state: JSON.parse(Buffer.from(r.result).toString()) };
};
const pinned = await stateAt(index.near_block ? { block_id: index.near_block.hash } : { finality: 'final' });
const live = await stateAt({ finality: 'final' });
const nearBlock = pinned.block, nearHeight = pinned.height, state = pinned.state;
check('the index is a snapshot at a NEAR block', !!index.near_block && index.near_block.height === nearHeight,
  index.near_block ? `NEAR block ${nearHeight}: ${state.redemptions} redemptions, supply ${state.supply}` : 'no near_block in the index: reading the latest block');
// A mint the index does not list is either newer than the snapshot (reported) or unbacked (a failure).
const mintHeight = async (m) => (await post(NEAR_RPCS, 'block', { block_id: (await post(NEAR_RPCS, 'tx', { tx_hash: m.tx, sender_account_id: m.signer, wait_until: 'NONE' })).transaction_outcome.block_hash })).header.height;
const inSnapshot = [];
let newerMints = 0;
for (const m of bridge.mints) {
  if (index.deposits.some((d) => d.deposit_id === m.deposit_id)) { inSnapshot.push(m); continue; }
  const h = await mintHeight(m).catch(() => null);
  if (index.near_block && h !== null && h > nearHeight) { newerMints++; continue; }
  inSnapshot.push(m);
}
// Receipts are optional per mint, so the bridge keeps no mint count: step 4's accounting at the same block is what
// shows that no mint up to the snapshot is missing from the list.
console.log(`INFO ${inSnapshot.length} mints up to NEAR block ${nearHeight}${newerMints ? `; ${newerMints} later mint${newerMints === 1 ? '' : 's'} not covered by the index yet` : ''}`);

// 2. Every mint is backed by a lock deposit of the same amount.
const byDeposit = new Map(index.deposits.map((d) => [d.deposit_id, d]));
let backed = 0n;
const locks = [];
for (const m of inSnapshot) {
  const d = byDeposit.get(m.deposit_id);
  if (!d) { check(`mint ${m.tx.slice(0, 10)}… has a recorded lock`, false, `deposit ${m.deposit_id.slice(0, 12)}… not in the index`); continue; }
  try {
    const x = await extrinsicAt(d.block, d.extrinsic);
    const id = hex(sha256(Uint8Array.of(...unhex(x.blockHash), d.extrinsic & 255, (d.extrinsic >> 8) & 255, (d.extrinsic >> 16) & 255, d.extrinsic >>> 24)));
    const ev = lockDeposit(await eventsOf(x.blockHash, d.extrinsic), { lock: LOCK, planck: m.planck });
    const ok = id === m.deposit_id && d.block <= finalized && ev.ok;
    if (ok) { backed += BigInt(m.planck); locks.push({ deposit_id: m.deposit_id, tx: x.hash, block: d.block, extrinsic: d.extrinsic }); }
    check(`mint ${m.tx.slice(0, 10)}… is backed by lock deposit ${x.hash.slice(0, 12)}… (block ${d.block} #${d.extrinsic})`, ok,
      `deposit id ${id === m.deposit_id ? 'recomputed from the block hash' : 'MISMATCH'}; ${d.block <= finalized ? 'finalized' : 'NOT finalized'}; ${ev.ok ? `succeeded, Transfer of ${m.planck} planck to the lock` : ev.why}`);
  } catch (e) { check(`mint ${m.tx.slice(0, 10)}… is backed by its lock deposit`, false, e.message); }
}

// 3. Each redemption the bridge records has a distinct successful release, read at the index's NEAR block.
const nearView = async (method, args) => JSON.parse(Buffer.from((await post(NEAR_RPCS, 'query', { request_type: 'call_function', block_id: nearBlock, account_id: bridge.bridge, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString());
const count = Number(state.redemptions);
const byId = new Map(index.releases.map((r) => [r.redemption, r]));
let released = 0n;
const usedExecutes = new Set();
for (let i = 0; i < count; i++) {
  const red = await nearView('redemption', { id: String(i) });
  const r = byId.get(i);
  if (!r) { check(`redemption ${i} has a release`, false, 'no release recorded'); continue; }
  try {
    const where = await fetch(`${INDEXER}/transactions/${r.execute}`).then((x) => x.json());
    const x = await extrinsicAt(where.height, where.index);
    const ev = lockRelease(await eventsOf(x.blockHash, where.index), { lock: LOCK, signers, threshold: 2, destination: '0x' + red.quantus_to, planck: red.amount, call: transferCall(red.quantus_to, red.amount) });
    const distinct = !usedExecutes.has(x.hash);
    usedExecutes.add(x.hash);
    const ok = x.hash === r.execute && where.height <= finalized && ev.ok && distinct;
    if (ok) released += BigInt(red.amount);
    check(`redemption ${i} (${red.amount} planck to ${red.quantus_to.slice(0, 10)}…) released by ${r.execute.slice(0, 12)}…`, ok,
      `block ${where.height} #${where.index}; hash ${x.hash === r.execute ? 'recomputed' : 'MISMATCH'}; ${ev.ok ? `proposal ${ev.proposal} executed by the lock, inner call succeeded, 2 signers approved, Transfer of the redeemed amount to the destination` : ev.why}${distinct ? '' : '; release already used for another redemption'}`);
  } catch (e) { check(`redemption ${i} has a release`, false, e.message); }
}

// 4. Accounting: the verified unique mints minus the redemptions equal the supply, and the lock covers it.
const supply = BigInt(state.supply);
const minted = inSnapshot.reduce((t, m) => t + BigInt(m.planck), 0n);
check('verified mints minus redemptions equal the bridge supply', backed === minted && minted - released === supply,
  `${inSnapshot.length} mints (${minted} planck) − ${count} redemptions (${released} planck) = ${minted - released}; supply ${supply} at NEAR block ${nearHeight}`);
const account = (await atFinal.query.system.account(LOCK)).toJSON();
const free = BigInt(account.data.free);
const supplyNow = BigInt(live.state.supply);
check('the lock holds at least the bridge supply now', free >= supplyNow, `lock free balance ${free} planck at Quantus block ${finalized} (${finalizedHash.slice(0, 12)}…); supply ${supplyNow} at NEAR block ${live.height}`);
const newer = Number(live.state.redemptions) - count;
console.log(`INFO after the index's block ${nearHeight}: ${newer} more redemption${newer === 1 ? '' : 's'} and supply ${live.state.supply} at block ${live.height}. Not checked here: the index does not list them yet.`);

await api.disconnect();
writeFileSync('evidence/route-quantus.json', JSON.stringify({
  date: new Date().toISOString(), quantus_rpc: QUANTUS_RPC, quantus_finalized: { number: finalized, hash: finalizedHash },
  near_block: { height: nearHeight, hash: nearBlock }, near_live: { height: live.height, redemptions: live.state.redemptions, supply: live.state.supply }, upstream: { file: 'evidence/route-onchain.json', sha256: hex(sha256(onchainBytes)), date: onchain.date, checks: onchain.results.length },
  indexer_used_for: 'locating release extrinsics by hash', bridge: bridge.bridge, locks, results,
}, null, 1) + '\n');
console.log(`${results.length - failures}/${results.length} passed · evidence/route-quantus.json`);
process.exit(failures ? 1 : 0);
