// Writes docs/EVIDENCE.md from what the two verifiers wrote, refusing if either reported a failure. Two tables, each
// row tied by chain data only: mints (the lock deposit whose id the attestation names, the mint, the account it
// credited and that account's withdrawals) and redemptions (the bridge's own record and the Quantus release that paid
// it). A mint is not paired with a release: several redemptions can carry the same amount to the same address, and
// nothing on-chain says which withdrawal a given release answers beyond the redemption record itself.
//
//   node scripts/verify-route.mjs && node scripts/verify-quantus.mjs && node scripts/evidence-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const onchain = JSON.parse(readFileSync('evidence/route-onchain.json', 'utf8'));
const quantus = JSON.parse(readFileSync('evidence/route-quantus.json', 'utf8'));
const index = JSON.parse(readFileSync('evidence/route-quantus-index.json', 'utf8'));
const bridge = onchain.bridges.find((b) => b.current);
const NEAR = 'https://testnet.nearblocks.io';
const QIDX = 'https://testnet.qlyphs.com/api/transactions';
const failed = (list) => list.filter((r) => !r.ok).length;
if (failed(onchain.results) || failed(quantus.results)) throw new Error('a verifier reported a failure: fix that before writing the evidence page');

const qtc = (p) => (Number(BigInt(p)) / 1e12).toLocaleString('en-US', { maximumFractionDigits: 12 });
const tx = (h) => `[${h.slice(0, 8)}…](${NEAR}/txns/${h})`;
const acct = (a) => `[${a.split('.')[0].slice(0, 12)}…](${NEAR}/address/${a})`;
const qtx = (h) => `[${h.slice(0, 10)}…](${QIDX}/${h})`;
const locks = new Map(quantus.locks.map((l) => [l.deposit_id, l]));
const releaseResults = quantus.results.filter((r) => r.name.startsWith('redemption '));

const lines = [
  '# Evidence: the current bridge, step by step',
  '',
  `Generated from \`evidence/route-onchain.json\` (${onchain.results.length}/${onchain.results.length} checks on NEAR testnet, ${onchain.date}) and \`evidence/route-quantus.json\` (${quantus.results.length}/${quantus.results.length} checks on the Quantus test chain, finalized block ${quantus.quantus_finalized.number}, NEAR block ${quantus.near_block.height}). Rerun both and this page with:`,
  '',
  '```sh',
  'node scripts/verify-route.mjs && node scripts/verify-quantus.mjs && node scripts/evidence-page.mjs',
  '```',
  '',
  `Bridge \`${bridge.bridge}\`. Lock \`${index.bridge ? 'qzpPEK…' : ''}\` on the Quantus test chain (genesis \`0x06fb13f7…\`): a native multisig whose three signers and threshold of 2 the verifier reads from chain state. Quantus links open the Qlyphs test indexer's record of an extrinsic; the verifier itself reads the bytes and events from the public RPC \`https://testnet-rpc.qlyphs.com\`.`,
  '',
  '## Mints',
  '',
  'Each mint is backed by a lock deposit of the same amount: the deposit id in the NEAR attestation is SHA-256 of that Quantus block hash and extrinsic index, and that extrinsic emitted a successful transfer of the amount to the lock. Both attester signatures are verified again by `verify-route.mjs`.',
  '',
  '| # | QTC | Lock deposit on Quantus (wallet, ML-DSA-87) | Mint on NEAR (2 of 3 ML-DSA-87, checked by the contract) | Account credited (one ML-DSA-65 key) | Its withdrawals (ML-DSA-65) |',
  '|---|---|---|---|---|---|',
];
const rows = bridge.mints.map((m) => ({ m, lock: locks.get(m.deposit_id) })).sort((a, b) => (a.lock?.block ?? 0) - (b.lock?.block ?? 0));
rows.forEach(({ m, lock }, i) => {
  const ws = bridge.withdrawals.filter((w) => w.account === m.receiver);
  lines.push(`| ${i + 1} | ${qtc(m.planck)} | ${lock ? `${qtx(lock.tx)} block ${lock.block}` : '—'} | ${tx(m.tx)} signers ${m.attesters.join('+')} | ${acct(m.receiver)} | ${ws.length ? ws.map((w) => `${tx(w.tx)} ${qtc(w.planck)}`).join(', ') : 'none yet'} |`);
});
lines.push('', '## Redemptions and releases', '',
  'The NEAR bridge records every burn as a numbered redemption (amount, Quantus destination, NEAR block). For each one, the verifier finds a distinct Quantus release: the lock\'s multisig executed exactly that transfer, its inner call succeeded, two distinct signers of the lock approved it, and the transfer event followed. This does not establish that no other transfer ever left the lock.', '',
  '| Redemption | QTC | To (Quantus account id, as the bridge recorded it) | Release on Quantus (2 of 3 ML-DSA-87) |', '|---|---|---|---|');
for (const r of index.releases) {
  const res = releaseResults.find((x) => x.name.startsWith(`redemption ${r.redemption} `));
  lines.push(`| ${r.redemption} | ${qtc(r.planck)} | \`0x${r.destination.slice(0, 16)}…\` | ${qtx(r.execute)}${res?.ok ? '' : ' (not verified)'} |`);
}
const acc = quantus.results.find((r) => r.name.startsWith('verified mints minus redemptions'));
const bal = quantus.results.find((r) => r.name.startsWith('the lock holds'));
lines.push('', `**Accounting.** ${acc.detail}.`, '', `**Lock balance.** ${bal.detail}.`, '',
  'Mints and releases are approved by two of the three attester keys, all operated by Qlyphs in one service: this shows 2-of-3 post-quantum authorization, not independent operators. The relayer that submits mints pays gas and has no authority; its only key is ML-DSA-65.', '');
writeFileSync('docs/EVIDENCE.md', lines.join('\n'));
console.log(`docs/EVIDENCE.md: ${rows.length} mints, ${index.releases.length} releases`);
