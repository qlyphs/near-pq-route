// The Quantus side of the route, checked from public endpoints: every mint on the current bridge is backed by a real
// lock transfer on the Quantus test chain, and every redemption on NEAR was released by the 2-of-3 lock, once, to
// the destination and for the amount the bridge recorded.
//
//   node scripts/verify-route.mjs      # first: writes evidence/route-onchain.json (the mints, verified on NEAR)
//   node scripts/verify-quantus.mjs    # then this; writes evidence/route-quantus.json
//
// evidence/route-quantus-index.json only says where to look (block, extrinsic index, release hash). Every fact is
// read again: the extrinsic bytes from the chain's RPC (their BLAKE2b-256 must be the recorded hash), the deposit id
// recomputed from the block hash, the amounts and destinations from the extrinsic's call and from the NEAR bridge.
// The Qlyphs test indexer is used for two things the raw RPC cannot answer without the runtime's codec: where an
// extrinsic hash was included, and whether it succeeded. Both are labelled in the output.
import { readFileSync, writeFileSync } from 'node:fs';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';

const QUANTUS_RPC = 'https://testnet-rpc.qlyphs.com';
const INDEXER = 'https://testnet.qlyphs.com/api';
const NEAR_RPC = 'https://rpc.testnet.fastnear.com';
const lock = JSON.parse(readFileSync('deployments/quantus-lock-curve.json', 'utf8'));
const index = JSON.parse(readFileSync('evidence/route-quantus-index.json', 'utf8'));
const onchain = JSON.parse(readFileSync('evidence/route-onchain.json', 'utf8'));
const bridge = onchain.bridges.find((b) => b.current);
if (bridge.bridge !== index.bridge) throw new Error(`index is for ${index.bridge}, current bridge is ${bridge.bridge}`);

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, method, params) {
  for (let i = 0; ; i++) {
    try {
      const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j.result;
    } catch (e) { if (i >= 4) throw new Error(`${url} ${method}: ${e.message}`); await sleep(2000 * (i + 1)); }
  }
}
const quantus = (method, params = []) => post(QUANTUS_RPC, method, params);
async function indexed(hash) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${INDEXER}/transactions/${hash}`).catch(() => null);
    if (r?.ok) return r.json();
    if (i >= 4) throw new Error(`indexer: no answer for ${hash}`);
    await sleep(2000 * (i + 1));
  }
}
async function nearView(account, method, args) {
  const r = await post(NEAR_RPC, 'query', { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
}
/** SCALE compact encoding of an unsigned integer (the form amounts take inside a call). */
function compact(n) {
  n = BigInt(n);
  if (n < 1n << 6n) return Uint8Array.of(Number(n << 2n));
  if (n < 1n << 14n) { const v = Number((n << 2n) | 1n); return Uint8Array.of(v & 255, v >> 8); }
  if (n < 1n << 30n) { const v = Number((n << 2n) | 2n); return Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24); }
  const bytes = []; let m = n; while (m > 0n) { bytes.push(Number(m & 255n)); m >>= 8n; }
  return Uint8Array.of(((bytes.length - 4) << 2) | 3, ...bytes);
}
/** The call `Balances.transfer_keep_alive(MultiAddress::Id(to), Compact(amount))`: pallet 0x02, call 0x03. */
const transferCall = (toHex, planck) => hex(Uint8Array.of(0x02, 0x03, 0x00, ...unhex(toHex), ...compact(planck)));
/** The extrinsic at (block, index), with the checks that tie it to its recorded hash. */
async function extrinsicAt(block, at) {
  const blockHash = await quantus('chain_getBlockHash', [block]);
  const body = await quantus('chain_getBlock', [blockHash]);
  const x = body?.block?.extrinsics?.[at];
  if (!x) throw new Error(`no extrinsic ${at} in block ${block}`);
  return { blockHash, bytes: x.replace(/^0x/, ''), hash: '0x' + hex(blake2b(unhex(x), { dkLen: 32 })) };
}

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const genesis = await quantus('chain_getBlockHash', [0]);
check('the Quantus RPC serves the test chain the lock lives on', genesis === lock.genesis, genesis);
const finalizedHead = await quantus('chain_getFinalizedHead');
const finalized = parseInt((await quantus('chain_getHeader', [finalizedHead])).number, 16);
const lockId = lock.accountId.replace(/^0x/, '');

// 1. Every mint on NEAR is backed by a lock transfer of the same amount.
const byDeposit = new Map(index.deposits.map((d) => [d.deposit_id, d]));
let locked = 0n;
const locks = [];
for (const m of bridge.mints) {
  const d = byDeposit.get(m.deposit_id);
  if (!d) { check(`mint ${m.tx.slice(0, 10)}… has a recorded lock`, false, `deposit ${m.deposit_id.slice(0, 12)}… not in the index`); continue; }
  try {
    const x = await extrinsicAt(d.block, d.extrinsic);
    const id = hex(sha256(Uint8Array.of(...unhex(x.blockHash), d.extrinsic & 255, (d.extrinsic >> 8) & 255, (d.extrinsic >> 16) & 255, d.extrinsic >>> 24)));
    const where = await indexed(x.hash);
    const pays = x.bytes.endsWith(transferCall(lockId, m.planck));
    const ok = id === m.deposit_id && x.blockHash === d.block_hash && pays && d.block <= finalized && where.height === d.block && where.index === d.extrinsic && where.nativeSuccess === true;
    if (ok) { locked += BigInt(m.planck); locks.push({ deposit_id: m.deposit_id, tx: x.hash, block: d.block, extrinsic: d.extrinsic }); }
    check(`mint ${m.tx.slice(0, 10)}… is backed by lock ${x.hash.slice(0, 12)}… (block ${d.block} #${d.extrinsic})`, ok,
      `deposit id ${id === m.deposit_id ? 'recomputed from the block hash' : 'MISMATCH'}; call ${pays ? `transfer_keep_alive(lock, ${m.planck})` : 'is not a transfer of the minted amount to the lock'}; ${d.block <= finalized ? 'finalized' : 'not finalized'}; indexer: ${where.nativeSuccess ? 'succeeded' : 'NOT succeeded'}`);
  } catch (e) { check(`mint ${m.tx.slice(0, 10)}… is backed by its lock`, false, e.message); }
}

// 2. Every redemption on the bridge was released once, to its destination, for its amount, by the lock multisig.
const state = await nearView(bridge.bridge, 'state', {});
const count = Number(state.redemptions);
const byId = new Map(index.releases.map((r) => [r.redemption, r]));
let released = 0n;
const seen = new Set();
for (let i = 0; i < count; i++) {
  const red = await nearView(bridge.bridge, 'redemption', { id: String(i) });
  const r = byId.get(i);
  if (!r) { check(`redemption ${i} was released`, false, 'no release recorded'); continue; }
  try {
    const where = await indexed(r.execute);
    const x = await extrinsicAt(where.height, where.index);
    // The lock's multisig call (pallet 0x13, call 0x06) on the lock account, whose inner call pays the destination.
    const ok = x.hash === r.execute && x.bytes.includes('1306' + lockId) && x.bytes.endsWith(transferCall(red.quantus_to, red.amount))
      && where.height <= finalized && where.nativeSuccess === true && !seen.has(r.execute) && r.destination === red.quantus_to && r.planck === red.amount;
    seen.add(r.execute);
    if (ok) released += BigInt(red.amount);
    check(`redemption ${i} (${red.amount} planck, withdrawn through ${red.account}) released by ${r.execute.slice(0, 12)}…`, ok,
      `block ${where.height} #${where.index}; multisig of the lock pays ${red.quantus_to.slice(0, 10)}… exactly the redeemed amount; indexer: ${where.nativeSuccess ? 'succeeded' : 'NOT succeeded'}`);
  } catch (e) { check(`redemption ${i} was released`, false, e.message); }
}

// 3. Nothing left out: the mints checked above, minus every redemption, is exactly what the bridge says exists.
const supply = BigInt(state.supply);
const mintedAll = bridge.mints.reduce((t, m) => t + BigInt(m.planck), 0n);
check('every mint and redemption of the bridge is accounted for', mintedAll - released === supply && locked === mintedAll,
  `${bridge.mints.length} mints (${mintedAll} planck) − ${count} redemptions (${released} planck) = ${mintedAll - released}; bridge supply ${supply}`);
// 4. What NEAR still holds is backed by what the lock still holds.
const balance = await fetch(`${INDEXER}/balance?owner=0x${lockId}`).then((r) => r.json());
const free = BigInt(balance.free);
check('QTC on NEAR is fully backed by QTC in the lock', free >= supply, `bridge supply ${supply} planck; lock free balance ${free} planck (indexer); minted ${locked}, released ${released}`);

writeFileSync('evidence/route-quantus.json', JSON.stringify({ date: new Date().toISOString(), quantus_rpc: QUANTUS_RPC, indexer: INDEXER, bridge: bridge.bridge, finalized, locks, results }, null, 1) + '\n');
console.log(`${results.length - failures}/${results.length} passed · evidence/route-quantus.json`);
process.exit(failures ? 1 : 0);
