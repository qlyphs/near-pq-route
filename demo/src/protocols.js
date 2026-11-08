// Reads, from NEAR mainnet at one finalized block, who can run the admin actions of well-known NEAR protocols, and
// how many classical full-access keys stand at the end of that path. Read-only; no protocol listed uses Guardian.

// Each entry names the contract and the public view that returns its admin accounts.
export const PROTOCOLS = [
  { id: 'rhea-amm', name: 'Rhea Finance AMM', category: 'DEX', contract: 'v2.ref-finance.near', admin: { method: 'metadata', field: 'owner' }, extra: { method: 'metadata', field: 'guardians', label: 'pause guardians' } },
  { id: 'rhea-lending', name: 'Rhea Lending', category: 'Lending', contract: 'contract.main.burrow.near', admin: { method: 'get_config', field: 'owner_id' } },
  { id: 'rhea-farm', name: 'Rhea Boost Farm', category: 'Farming', contract: 'boostfarm.ref-labs.near', admin: { method: 'get_metadata', field: 'owner_id' }, extra: { method: 'get_metadata', field: 'operators', label: 'operators' } },
  { id: 'linear', name: 'LiNEAR', category: 'Liquid staking', contract: 'linear-protocol.near', admin: { method: 'get_owner_id' } },
  { id: 'meta-pool', name: 'Meta Pool', category: 'Liquid staking', contract: 'meta-pool.near', admin: { method: 'get_owner_id' } },
  { id: 'intents', name: 'NEAR Intents', category: 'Intents', contract: 'intents.near', admin: { method: 'acl_get_permissioned_accounts', collect: (v) => [...(v?.super_admins ?? []), ...(v?.roles?.Upgrader?.grantees ?? [])] } },
  { id: 'omni-bridge', name: 'Omni Bridge', category: 'Bridge', contract: 'omni.bridge.near', admin: { method: 'acl_get_super_admins', args: { skip: 0, limit: 20 } } },
  { id: 'rainbow-bridge', name: 'Rainbow Bridge', category: 'Bridge', contract: 'factory.bridge.near', admin: { method: 'acl_get_super_admins', args: { skip: 0, limit: 20 } } },
  { id: 'usdt', name: 'USDT', category: 'Stablecoin', contract: 'usdt.tether-token.near', admin: { method: 'owner' } },
];

const NO_CODE = '11111111111111111111111111111111';
const MAX_MEMBERS = 12; // bounds the RPC calls of one read

// A Sputnik DAO default policy threshold [num, den] over n members: strictly more than num/den of them.
export function daoVotes(threshold, n) {
  if (Array.isArray(threshold)) { const [a, b] = threshold.map(Number); return Math.min(n, Math.floor((n * a) / b) + 1); }
  return Math.min(n, Number(threshold));
}

export function curveCounts(keys) {
  const out = {};
  for (const k of keys) if (k.access_key.permission === 'FullAccess') { const curve = k.public_key.split(':')[0]; out[curve] = (out[curve] ?? 0) + 1; }
  return out;
}

const add = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v; return a; };

class AtBlock {
  constructor(rpc, blockId) { this.rpc = rpc; this.blockId = blockId; }
  q(params) { return this.rpc.query({ ...params, block_id: this.blockId }); }
  keys(id) { return this.q({ request_type: 'view_access_key_list', account_id: id }).then((r) => r.keys); }
  account(id) { return this.q({ request_type: 'view_account', account_id: id }); }
  async view(id, method, args = {}) {
    const r = await this.q({ request_type: 'call_function', account_id: id, method_name: method, args_base64: btoa(JSON.stringify(args)) });
    const text = new TextDecoder().decode(Uint8Array.from(r.result));
    return text ? JSON.parse(text) : null;
  }
  tryView(id, method, args) { return this.view(id, method, args).catch(() => undefined); }
}

// What controls one account: its own keys, a DAO, a multisig, or a contract whose rules are not read here.
async function controller(at, id, depth = 0) {
  // A read that fails is never taken for "no keys": it leaves this part of the path unresolved.
  const [acct, keys] = await Promise.all([at.account(id).catch((e) => ({ error: e })), at.keys(id).catch(() => null)]);
  if (acct.error || !keys) return { id, kind: /does not exist|UNKNOWN_ACCOUNT/i.test(String(acct.error?.message)) ? 'missing' : 'unreadable', keys: {} };
  const own = curveCounts(keys);
  // An account can run code without its own code hash: a NEAR global contract, by hash or by account.
  const hasCode = acct.code_hash !== NO_CODE || Boolean(acct.global_contract_hash || acct.global_contract_account_id);
  if (!hasCode) return { id, kind: Object.keys(own).length ? 'account' : 'locked', keys: own };
  if (depth > 0) return { id, kind: 'contract', keys: own };
  const policy = await at.tryView(id, 'get_policy');
  if (policy?.roles) {
    const members = [...new Set(policy.roles.filter((r) => r.kind?.Group && r.permissions?.some((p) => /VoteApprove|\*:\*/.test(p))).flatMap((r) => r.kind.Group))];
    const resolved = []; for (const m of members.slice(0, MAX_MEMBERS)) resolved.push(await controller(at, m, depth + 1));
    return { id, kind: 'dao', keys: own, members: resolved, member_count: members.length, votes: daoVotes(policy.default_vote_policy?.threshold, members.length) };
  }
  const multisig = await at.tryView(id, 'get_members');
  if (Array.isArray(multisig)) {
    const confirmations = await at.tryView(id, 'get_num_confirmations');
    const accounts = multisig.map((m) => m.account_id).filter(Boolean);
    const resolved = []; for (const m of accounts.slice(0, MAX_MEMBERS)) resolved.push(await controller(at, m, depth + 1));
    const directKeys = multisig.filter((m) => m.public_key).map((m) => ({ public_key: m.public_key, access_key: { permission: 'FullAccess' } }));
    return { id, kind: 'multisig', keys: add(own, curveCounts(directKeys)), members: resolved, member_count: multisig.length, votes: Number(confirmations) || null };
  }
  return { id, kind: 'contract', keys: own };
}

// Totals the full-access keys at the end of every admin path, and whether part of the path was not resolved.
export function tally(admins) {
  const keys = {}; let unresolved = 0, locked = 0;
  const walk = (c) => {
    add(keys, c.keys);
    if (c.kind === 'contract' || c.kind === 'unreadable' || c.kind === 'missing') unresolved++;
    if (c.kind === 'locked') locked++;
    for (const m of c.members ?? []) walk(m);
    if ((c.member_count ?? 0) > (c.members?.length ?? 0)) unresolved++;
  };
  admins.forEach(walk);
  const classical = Object.entries(keys).filter(([c]) => !/^ml-dsa/.test(c)).reduce((s, [, n]) => s + n, 0);
  return { keys, classical, unresolved, locked };
}

export async function readProtocol(rpc, id) {
  const p = PROTOCOLS.find((x) => x.id === id);
  if (!p) return null;
  const block = await rpc.block({ finality: 'final' });
  const at = new AtBlock(rpc, block.header.height);
  const pick = (v, field) => (field ? v?.[field] : v);
  const [contractKeys, adminView, extraView] = await Promise.all([at.keys(p.contract), at.view(p.contract, p.admin.method, p.admin.args), p.extra ? at.tryView(p.contract, p.extra.method) : undefined]);
  const adminIds = [...new Set([].concat(p.admin.collect ? p.admin.collect(adminView) : pick(adminView, p.admin.field) ?? []))].filter((a) => typeof a === 'string' && a !== p.contract);
  const admins = await Promise.all(adminIds.map((a) => controller(at, a)));
  const contract = curveCounts(contractKeys);
  const t = tally(admins);
  return {
    id: p.id, name: p.name, category: p.category, contract: p.contract, block: { height: block.header.height, hash: block.header.hash },
    contract_keys: contract, admin_method: p.admin.method, admins,
    extra: p.extra ? { label: p.extra.label, accounts: [].concat(pick(extraView, p.extra.field) ?? []) } : null,
    totals: { ...t, classical: t.classical + Object.entries(contract).filter(([c]) => !/^ml-dsa/.test(c)).reduce((s, [, n]) => s + n, 0) },
  };
}
