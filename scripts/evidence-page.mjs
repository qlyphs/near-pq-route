// Writes docs/EVIDENCE.md from what the two verifiers wrote: every round trip on the current bridge, each step with
// a link, chained by the data itself (the mint names the lock's deposit id, the withdrawal is signed by the account
// the mint credited, the redemption records that withdrawal's amount and destination, the release pays them).
//
//   node scripts/verify-route.mjs && node scripts/verify-quantus.mjs && node scripts/evidence-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const onchain = JSON.parse(readFileSync('evidence/route-onchain.json', 'utf8'));
const quantus = JSON.parse(readFileSync('evidence/route-quantus.json', 'utf8'));
const index = JSON.parse(readFileSync('evidence/route-quantus-index.json', 'utf8'));
const bridge = onchain.bridges.find((b) => b.current);
const NEAR = 'https://testnet.nearblocks.io';
const QIDX = 'https://testnet.qlyphs.com/api/transactions';
const qtc = (p) => (Number(BigInt(p)) / 1e12).toLocaleString('en-US', { maximumFractionDigits: 12 });
const tx = (h) => `[${h.slice(0, 8)}…](${NEAR}/txns/${h})`;
const acct = (a) => `[${a.split('.')[0].slice(0, 12)}…](${NEAR}/address/${a})`;
const qtx = (h) => `[${h.slice(0, 10)}…](${QIDX}/${h})`;
const failed = (list) => list.filter((r) => !r.ok).length;
if (failed(onchain.results) || failed(quantus.results)) throw new Error('a verifier reported a failure: fix that before writing the evidence page');

const deposits = new Map(quantus.locks.map((d) => [d.deposit_id, d]));
const releases = [...index.releases];
const used = new Set();
const rows = [];
for (const m of bridge.mints) {
  const lock = deposits.get(m.deposit_id);
  const w = bridge.withdrawals.find((x) => x.account === m.receiver && x.planck === m.planck);
  const dest = w?.memo.replace('WITHDRAW_TO:', '');
  const rel = w && releases.find((r) => !used.has(r.redemption) && r.destination === dest && r.planck === w.planck);
  if (rel) used.add(rel.redemption);
  rows.push({ m, lock, w, rel });
}
rows.sort((a, b) => (a.lock?.block ?? 0) - (b.lock?.block ?? 0));

const lines = [];
lines.push('# Evidence: every round trip on the current bridge');
lines.push('');
lines.push(`Generated from \`evidence/route-onchain.json\` (${onchain.results.length}/${onchain.results.length} checks, NEAR testnet) and \`evidence/route-quantus.json\` (${quantus.results.length}/${quantus.results.length} checks, Quantus test chain). Rerun both and this page with:`);
lines.push('');
lines.push('```sh');
lines.push('node scripts/verify-route.mjs && node scripts/verify-quantus.mjs && node scripts/evidence-page.mjs');
lines.push('```');
lines.push('');
lines.push(`Bridge \`${bridge.bridge}\`, lock \`qzpPEK…\` (2-of-3 ML-DSA-87 multisig on the Quantus test chain, genesis \`0x06fb13f7…\`). Quantus links open the Qlyphs test indexer's record of the extrinsic (height, index, success); \`verify-quantus.mjs\` re-reads its bytes from the public RPC \`https://testnet-rpc.qlyphs.com\` and checks the hash, the call and the amount.`);
lines.push('');
lines.push('| # | Amount (QTC) | 1. Lock on Quantus (ML-DSA-87) | 2. Mint on NEAR (2 of 3 ML-DSA-87, checked on-chain) | NEAR account (one ML-DSA-65 key) | 3. Withdrawal (ML-DSA-65) | 4. Release on Quantus (2 of 3 ML-DSA-87) |');
lines.push('|---|---|---|---|---|---|---|');
rows.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${qtc(r.m.planck)} | ${r.lock ? qtx(r.lock.tx) : '—'} | ${tx(r.m.tx)} signers ${r.m.attesters.join('+')} | ${acct(r.m.receiver)} | ${r.w ? tx(r.w.tx) : 'not withdrawn'} | ${r.rel ? `${qtx(r.rel.execute)} (redemption ${r.rel.redemption})` : r.w ? 'pending' : '—'} |`);
});
lines.push('');
const left = releases.filter((r) => !used.has(r.redemption));
if (left.length) {
  lines.push(`Releases that do not pair with a single withdrawal above (several withdrawals of the same amount to the same address, or a withdrawal through a direct redemption): ${left.map((r) => `${qtx(r.execute)} (redemption ${r.redemption}, ${qtc(r.planck)} QTC)`).join(', ')}. Each one is still checked by \`verify-quantus.mjs\` against the bridge's own redemption record.`);
  lines.push('');
}
const supply = quantus.results.find((r) => r.name.startsWith('every mint and redemption'));
const backing = quantus.results.find((r) => r.name.startsWith('QTC on NEAR is fully backed'));
lines.push(`**Accounting.** ${supply.detail}. **Backing.** ${backing.detail}.`);
lines.push('');
lines.push('Mints are signed by two of the three attester keys, all operated by Qlyphs in one service: this shows 2-of-3 post-quantum authorization, not independent operators. The relayer that submits mints pays gas and has no authority; its only key is ML-DSA-65.');
lines.push('');
writeFileSync('docs/EVIDENCE.md', lines.join('\n'));
console.log(`docs/EVIDENCE.md: ${rows.length} mints, ${rows.filter((r) => r.rel).length} complete round trips`);
