// Unit checks of the protocol directory reader (demo/src/protocols.js) against a fake RPC: a failed read is never
// reported as "no keys", an account running a global contract is not taken for a closed one, and the DAO vote
// count follows the Sputnik default policy. Writes evidence/protocols-unit.json.
import { writeFileSync } from 'node:fs';
import { readProtocol, daoVotes, tally } from '../demo/src/protocols.js';

const results = [];
let failures = 0;
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
const NO_CODE = '11111111111111111111111111111111';
const key = (curve = 'ed25519', full = true) => ({ public_key: `${curve}:x`, access_key: { permission: full ? 'FullAccess' : { FunctionCall: {} } } });
const enc = (v) => Array.from(Buffer.from(JSON.stringify(v)));

// accounts: id -> { code_hash?, global_contract_hash?, keys?: [] | 'fail', views?: { method: value } }
function fakeRpc(accounts) {
  return {
    block: async () => ({ header: { height: 100, hash: 'H' } }),
    query: async (p) => {
      const a = accounts[p.account_id];
      if (!a) throw new Error(`account ${p.account_id} does not exist`);
      if (p.request_type === 'view_account') { if (a.account === 'fail') throw new Error('429 Rate limit'); return { code_hash: a.code_hash ?? NO_CODE, global_contract_hash: a.global_contract_hash }; }
      if (p.request_type === 'view_access_key_list') { if (a.keys === 'fail') throw new Error('429 Rate limit'); return { keys: a.keys ?? [] }; }
      if (p.request_type === 'call_function') { if (!(p.method_name in (a.views ?? {}))) throw new Error('MethodNotFound'); return { result: enc(a.views[p.method_name]) }; }
      throw new Error('unexpected');
    },
  };
}
const target = (owner) => ({ code_hash: 'C', views: { get_owner_id: owner } });
const dao = (members, threshold = [1, 2], extra = {}) => ({ code_hash: 'D', views: { get_policy: { roles: [{ name: 'council', kind: { Group: members }, permissions: ['*:VoteApprove'] }], default_vote_policy: { threshold } } }, ...extra });

{
  const r = await readProtocol(fakeRpc({ 'meta-pool.near': target('owner.dao'), 'owner.dao': { ...dao(['a', 'b']), code_hash: NO_CODE, global_contract_hash: 'G' }, a: { keys: [key()] }, b: { keys: [key(), key('ed25519', false)] } }), 'meta-pool');
  record('global contract account is read as a DAO, not as closed', r.admins[0].kind === 'dao' && r.totals.locked === 0 && r.totals.classical === 2, JSON.stringify(r.totals));
}
{
  const r = await readProtocol(fakeRpc({ 'meta-pool.near': target('owner.x'), 'owner.x': { keys: 'fail' } }), 'meta-pool');
  record('failed key read is unresolved, never closed', r.admins[0].kind === 'unreadable' && r.totals.locked === 0 && r.totals.unresolved === 1);
}
{
  const r = await readProtocol(fakeRpc({ 'meta-pool.near': target('owner.x'), 'owner.x': { account: 'fail' } }), 'meta-pool');
  record('failed account read is unresolved, never closed', r.admins[0].kind === 'unreadable' && r.totals.locked === 0);
}
{
  const r = await readProtocol(fakeRpc({ 'meta-pool.near': target('owner.x'), 'owner.x': {} }), 'meta-pool');
  record('account with no keys and no code is closed', r.admins[0].kind === 'locked' && r.totals.locked === 1 && r.totals.unresolved === 0);
}
{
  const r = await readProtocol(fakeRpc({ 'meta-pool.near': target('owner.dao'), 'owner.dao': dao(['a', 'b', 'c']), a: { keys: 'fail' }, b: { keys: [key()] }, c: { code_hash: 'Z' } }), 'meta-pool');
  record('DAO member unreadable or a contract counts as unresolved', r.totals.unresolved === 2 && r.totals.classical === 1);
}
{
  let threw = false;
  try { await readProtocol(fakeRpc({ 'meta-pool.near': { ...target('o'), keys: 'fail' }, o: {} }), 'meta-pool'); } catch { threw = true; }
  record('failed read of the contract keys fails the whole tile', threw);
}
{
  const r = await readProtocol(fakeRpc({ 'meta-pool.near': target('owner.x'), 'owner.x': { keys: [key('ml-dsa-65'), key()] } }), 'meta-pool');
  record('ml-dsa keys are not counted as classical', r.totals.classical === 1 && r.totals.keys['ml-dsa-65'] === 1);
}
record('Sputnik threshold [1,2] over 5 members needs 3', daoVotes([1, 2], 5) === 3);
record('Sputnik threshold [55,100] over 4 members needs 3', daoVotes([55, 100], 4) === 3);
record('Sputnik threshold [1,2] over 4 members needs 3', daoVotes([1, 2], 4) === 3);
record('fixed weight threshold is capped at the member count', daoVotes('7', 5) === 5);
record('member list longer than the read bound is unresolved', tally([{ kind: 'dao', keys: {}, members: [], member_count: 20 }]).unresolved === 1);

writeFileSync('evidence/protocols-unit.json', JSON.stringify({ suite: 'protocols.unit', results }, null, 2) + '\n');
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
