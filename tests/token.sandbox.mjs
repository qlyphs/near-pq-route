// Sandbox suite for the Guardian reference target (contract/token.c): legacy admin, handover, Guardian-only
// mint and upgrade, op-id replay, atomic rollback of a failing migration. A plain account plays the Guardian
// here; the Guardian contract has its own suite. Writes evidence/token-sandbox.json.
import { Worker } from 'near-workspaces';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const results = [];
let failures = 0;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
const failureText = (r) => JSON.stringify(r.Failure ?? r.receiptFailures ?? r.result?.status ?? '');
async function refused(name, call, reason) {
  const r = await call();
  const text = failureText(r);
  record(name, r.failed && text.includes(reason), r.failed ? reason : 'was accepted');
}
const upgradeArgs = (op, from, to, code) => {
  const b = Buffer.alloc(16 + code.length);
  b.writeBigUInt64LE(BigInt(op), 0); b.writeUInt32LE(from, 8); b.writeUInt32LE(to, 12); code.copy(b, 16);
  return new Uint8Array(b);
};

const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const v1 = readFileSync('build/token-v1.wasm'), v2 = readFileSync('build/token-v2.wasm');
  const v2bad = readFileSync('build/token-v2-failing.wasm');
  const owner = await root.createSubAccount('owner', { initialBalance: 20n * NEAR });
  const guardian = await root.createSubAccount('guardian', { initialBalance: 20n * NEAR });
  const alice = await root.createSubAccount('alice', { initialBalance: 5n * NEAR });
  const token = await root.createSubAccount('token', { initialBalance: 10n * NEAR });
  await token.deploy(v1);
  const view = (m, a = {}) => token.view(m, a);
  const code = async () => sha(Buffer.from((await worker.provider.query({ request_type: 'view_code', account_id: token.accountId, finality: 'optimistic' })).code_base64, 'base64'));

  await refused('new only by the token account', () => owner.callRaw(token, 'new', { owner_id: owner.accountId }), 'only the token account');
  await token.call(token, 'new', { owner_id: owner.accountId });
  await refused('new only once', () => token.callRaw(token, 'new', { owner_id: alice.accountId }), 'already initialized');
  record('starts in legacy mode, version 1', JSON.stringify(await view('state')) === JSON.stringify({ version: 1, owner: owner.accountId, guardian: null, next_op: '0', total_supply: '0' }));

  await owner.call(token, 'mint', { receiver_id: alice.accountId, amount: '1000' });
  record('legacy owner mints', (await view('ft_balance_of', { account_id: alice.accountId })) === '1000');
  await refused('stranger cannot mint', () => alice.callRaw(token, 'mint', { receiver_id: alice.accountId, amount: '1' }), 'only the owner');
  await refused('legacy mint refuses op_id', () => owner.callRaw(token, 'mint', { receiver_id: alice.accountId, amount: '1', op_id: '1' }), 'op_id is for Guardian calls');
  await refused('upgrade refused before handover', () => owner.callRaw(token, 'upgrade', upgradeArgs(1, 1, 2, v2), { gas: 200n * TGAS }), 'upgrades go through the Guardian');
  await refused('duplicate JSON field refused', () => owner.callRaw(token, 'mint', Buffer.from(`{"receiver_id":"${alice.accountId}","amount":"1","amount":"5"}`), {}), 'duplicate JSON field');
  await refused('leading zero amount refused', () => owner.callRaw(token, 'mint', { receiver_id: alice.accountId, amount: '01' }), 'bad number');
  await refused('amount above u128 refused', () => owner.callRaw(token, 'mint', { receiver_id: alice.accountId, amount: '340282366920938463463374607431768211456' }), 'amount overflow');

  // Strict JSON: the token reads what JSON.parse reads, or refuses. Each refusal leaves supply unchanged.
  const raw = (body) => owner.callRaw(token, 'mint', Buffer.from(body), {});
  const supplyBefore = (await view('state')).total_supply;
  const r = alice.accountId, o = owner.accountId;
  await refused('duplicate field hidden by whitespace', () => raw(`{"receiver_id":"${o}","receiver_id" : "${r}","amount":"1"}`), 'duplicate JSON field');
  await refused('escaped field name', () => raw(`{"receiver_id":"${o}","receiv\\u0065r_id":"${r}","amount":"1"}`), 'unsupported JSON field name');
  await refused('field picked out of text that is not JSON', () => raw(`garbage "receiver_id":"${r}","amount":"1" trailing`), 'expected a JSON object');
  await refused('trailing garbage after the object', () => raw(`{"receiver_id":"${r}","amount":"1"} x`), 'trailing data');
  await refused('nested value', () => raw(`{"receiver_id":"${r}","amount":{"v":"1"}}`), 'JSON values must be strings');
  await refused('numeric value instead of a string', () => raw(`{"receiver_id":"${r}","amount":1}`), 'JSON values must be strings');
  await refused('unknown field', () => raw(`{"receiver_id":"${r}","amount":"1","admin":"x"}`), 'unexpected JSON field');
  await refused('escape inside a value', () => raw(`{"receiver_id":"al\\u0069ce.test.near","amount":"1"}`), 'unsupported character');
  record('refused JSON changed nothing', (await view('state')).total_supply === supplyBefore);
  await owner.call(token, 'mint', Buffer.from(` {\n "receiver_id" : "${r}" ,\t"amount": "2" } `), {});
  record('ordinary whitespace around separators accepted', (await view('ft_balance_of', { account_id: r })) === '1002');
  record('balance view reads the one account field', (await token.view('ft_balance_of', { account_id: r })) === '1002');
  await refused('balance view refuses a duplicated account field', () => token.view('ft_balance_of', Buffer.from(`{"account_id":"${o}","account_id" : "${r}"}`)).then(() => ({ failed: false }), (e) => ({ failed: true, Failure: String(e.message) })), 'duplicate JSON field');
  // u128 bounds: the old cutoff, the maximum, the maximum plus one, a supply overflow.
  const fresh = await root.createSubAccount('bounds', { initialBalance: 10n * NEAR });
  await fresh.deploy(v1); await fresh.call(fresh, 'new', { owner_id: owner.accountId });
  const MAX = (1n << 128n) - 1n;
  await owner.call(fresh, 'mint', { receiver_id: r, amount: '212676479325586539664609129644855132160' });
  record('amount at the old cutoff accepted', (await fresh.view('ft_balance_of', { account_id: r })) === '212676479325586539664609129644855132160');
  const f2 = await root.createSubAccount('bounds2', { initialBalance: 10n * NEAR });
  await f2.deploy(v1); await f2.call(f2, 'new', { owner_id: owner.accountId });
  await owner.call(f2, 'mint', { receiver_id: r, amount: MAX.toString() });
  record('maximum u128 accepted', (await f2.view('ft_total_supply')) === MAX.toString());
  await refused('maximum u128 plus one refused', () => owner.callRaw(f2, 'mint', { receiver_id: o, amount: (MAX + 1n).toString() }), 'amount overflow');
  await refused('supply overflow refused', () => owner.callRaw(f2, 'mint', { receiver_id: o, amount: '1' }), 'amount overflow');

  await refused('stranger cannot hand over', () => alice.callRaw(token, 'handover', { guardian_id: alice.accountId }), 'only the owner');
  await owner.call(token, 'handover', { guardian_id: guardian.accountId });
  const s1 = await view('state');
  record('handover sets the Guardian and removes the owner', s1.owner === null && s1.guardian === guardian.accountId);
  await refused('handover only once', () => guardian.callRaw(token, 'handover', { guardian_id: alice.accountId }), 'already guarded');
  await refused('former owner cannot mint', () => owner.callRaw(token, 'mint', { receiver_id: owner.accountId, amount: '5', op_id: '9' }), 'only the Guardian');
  await refused('Guardian mint needs op_id', () => guardian.callRaw(token, 'mint', { receiver_id: alice.accountId, amount: '5' }), 'missing number');
  await guardian.call(token, 'mint', { receiver_id: alice.accountId, amount: '5', op_id: '1' });
  await refused('replayed op id refused', () => guardian.callRaw(token, 'mint', { receiver_id: alice.accountId, amount: '5', op_id: '1' }), 'operation already applied');
  record('Guardian mint applied once', (await view('ft_balance_of', { account_id: alice.accountId })) === '1007');

  await refused('stranger cannot upgrade', () => owner.callRaw(token, 'upgrade', upgradeArgs(2, 1, 2, v2), { gas: 200n * TGAS }), 'only the Guardian');
  await refused('upgrade with a spent op id', () => guardian.callRaw(token, 'upgrade', upgradeArgs(1, 1, 2, v2), { gas: 200n * TGAS }), 'operation already applied');
  await refused('upgrade from the wrong version', () => guardian.callRaw(token, 'upgrade', upgradeArgs(2, 3, 4, v2), { gas: 200n * TGAS }), 'version mismatch');
  await refused('migrate is private', () => alice.callRaw(token, 'migrate', upgradeArgs(2, 1, 2, Buffer.alloc(0)), {}), 'private');

  const before = await code();
  const bad = await guardian.callRaw(token, 'upgrade', upgradeArgs(2, 1, 2, v2bad), { gas: 200n * TGAS });
  const after = await code();
  record('failing migration rolls the whole batch back', bad.failed && failureText(bad).includes('migration refused') && before === after && (await view('state')).version === 1 && (await view('ft_balance_of', { account_id: alice.accountId })) === '1007', `code ${after === before ? 'unchanged' : 'CHANGED'}`);

  const ok = await guardian.callRaw(token, 'upgrade', upgradeArgs(2, 1, 2, v2), { gas: 200n * TGAS });
  const s2 = await view('state');
  record('Guardian upgrade V1 to V2', ok.succeeded && s2.version === 2 && s2.next_op === '3' && s2.guardian === guardian.accountId, `${Number(BigInt(ok.result.transaction_outcome.outcome.gas_burnt) + ok.result.receipts_outcome.reduce((a, r) => a + BigInt(r.outcome.gas_burnt), 0n)) / 1e12} Tgas`);
  record('upgraded code is the V2 build', (await code()) === sha(v2) && before === sha(v1));
  record('balances and supply preserved across the upgrade', (await view('ft_balance_of', { account_id: alice.accountId })) === '1007' && s2.total_supply === '1007');
  record('V2 metadata live', (await view('ft_metadata')).name === 'Guardian Demo Token v2');
  await refused('replayed upgrade refused after V2', () => guardian.callRaw(token, 'upgrade', upgradeArgs(2, 2, 3, v2), { gas: 200n * TGAS }), 'operation already applied');

  await refused('ft_transfer to an unregistered account', () => alice.callRaw(token, 'ft_transfer', { receiver_id: owner.accountId, amount: '5' }, { attachedDeposit: 1n }), 'not a registered holder');
  await guardian.call(token, 'mint', { receiver_id: owner.accountId, amount: '1', op_id: '7' });
  await refused('op id below the high-water mark after a gap', () => guardian.callRaw(token, 'mint', { receiver_id: owner.accountId, amount: '1', op_id: '5' }), 'operation already applied');
  await refused('ft_transfer needs 1 yocto', () => alice.callRaw(token, 'ft_transfer', { receiver_id: owner.accountId, amount: '5' }), 'exactly 1 yoctoNEAR');
  await alice.call(token, 'ft_transfer', { receiver_id: owner.accountId, amount: '5' }, { attachedDeposit: 1n });
  await refused('ft_transfer over balance', () => alice.callRaw(token, 'ft_transfer', { receiver_id: owner.accountId, amount: '5000' }, { attachedDeposit: 1n }), 'insufficient balance');
  record('ft_transfer moves balances', (await view('ft_balance_of', { account_id: owner.accountId })) === '6');

  writeFileSync('evidence/token-sandbox.json', JSON.stringify({ suite: 'token.sandbox', token_v1_sha256: sha(v1), token_v2_sha256: sha(v2), results }, null, 2) + '\n');
} finally {
  await worker.tearDown();
}
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
