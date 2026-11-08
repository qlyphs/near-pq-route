// Qlyphs Guardian demo Worker (NEAR testnet): the "Verify control" report, live PQ-approved mints anyone can
// request and execute, and the retired-credential experiments. Static page in demo/public. Without the operator's
// secrets it runs read-only: the report, state and recorded evidence work, the actions answer 503.
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import deployment from '../../deployments/guardian-qlyphs-guardian.json';
import evidence from '../../evidence/guardian-qlyphs-guardian.json';
import { encodeOperation, envelope, sha256, verifyControl, isAccountId, GUARDIAN_CONTEXT } from '../../sdk/guardian.mjs';
import { Rpc, edKey, functionCall, deployContract } from './near.js';
import { ownerMintVerdict, deletedKeyVerdict, UNVERIFIED } from './verdicts.js';

// Public testnet RPCs, in order; the client moves to the next one on a rate limit or a server error.
const RPC = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const DECIMALS = 18n; // the reviewed token's ft_metadata
const MINT_AMOUNT = 100n * 10n ** DECIMALS; // 100 GDEMO
const ATTACK_AMOUNT = 1_000_000_000n * 10n ** DECIMALS; // 1,000,000,000 GDEMO
const { accounts } = deployment;
const config = Buffer.from(deployment.guardian_creation.config_hex, 'hex');
const configHash = sha256(config);
const json = (body, status = 200) => new Response(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
// A demo signer from its 32-byte FIPS 204 seed (a Worker secret). Signs exactly like a wallet signer: Pure
// ML-DSA-87 over the 320-byte operation with the Guardian context.
const signer = (seedHex) => { const kp = ml_dsa87.keygen(fromHex(seedHex)); return { sign: (m, ctx) => Buffer.from(ml_dsa87.sign(Uint8Array.from(m), kp.secretKey, { context: Uint8Array.from(ctx) })) }; };
const recent = new Map(); // per-isolate request pacing, a courtesy limit only
// Short per-isolate caches so that many visitors do not multiply RPC load. A cached report keeps its own block.
const cache = new Map();
const cached = async (key, ttlMs, fn) => { const hit = cache.get(key); if (hit && Date.now() - hit.at < ttlMs) return hit.value; const value = await fn(); cache.set(key, { at: Date.now(), value }); return value; };
const writable = (env) => Boolean(env.SIGNER_A && env.SIGNER_B && env.RELAYER_KEY);
const readOnly = () => json({ error: 'This copy of the demo runs read-only: it has no operator keys. Use the hosted demo to act.', verdict: UNVERIFIED }, 503);

async function report(rpc) {
  return verifyControl(rpc, { network: 'testnet', guardian: accounts.guardian, target: accounts.token, guardianSha256: deployment.guardian_creation.guardian_sha256,
    reviewedTargetSha256: deployment.reviewed_target_sha256, config, deployment });
}

async function balance(rpc, id) {
  const a = await rpc.query({ request_type: 'view_account', finality: 'optimistic', account_id: id }).catch(() => null);
  if (!a) return null;
  const free = BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
  return { near: Number(BigInt(a.amount) * 1000n / NEAR) / 1000, free_near: Number(free * 1000n / NEAR) / 1000 };
}

async function state(rpc, env) {
  const [guardian, token, metadata, block, relayer, owner, tokenAccount] = await Promise.all([rpc.view(accounts.guardian, 'state'), rpc.view(accounts.token, 'state'),
    rpc.view(accounts.token, 'ft_metadata'), rpc.block({ finality: 'optimistic' }), balance(rpc, env.RELAYER_ID ?? accounts.relayer), balance(rpc, accounts.owner), balance(rpc, accounts.token)]);
  return { guardian, token, metadata, now_ns: block.header.timestamp_nanosec, accounts, writable: writable(env), repo_url: env.REPO_URL || null,
    resources: { relayer, former_owner: owner, token: tokenAccount },
    ceremony: { parent_tx: deployment.parent_tx, legacy: deployment.legacy, guardian_creation: { tx: deployment.guardian_creation.tx, audit: deployment.guardian_creation.audit }, cutover: deployment.cutover, operations: deployment.operations, max: deployment.max, attacks: evidence.attacks ?? null } };
}

async function mint(rpc, env, body, ip) {
  if (!writable(env)) return readOnly();
  const receiver = String(body?.receiver_id ?? '').trim().toLowerCase();
  if (!isAccountId(receiver)) return json({ error: 'Enter a valid NEAR account id (testnet), for example alice.testnet.' }, 400);
  const last = recent.get(ip) ?? 0;
  if (Date.now() - last < 30000) return json({ error: 'One request every 30 seconds, please.' }, 429);
  recent.set(ip, Date.now());
  let g = await rpc.view(accounts.guardian, 'state');
  // A visitor who never comes back would hold the single slot: once its delay has passed, anyone may execute it
  // (or close it after its window), so the demo settles it first.
  // Re-read after any attempt: a failed target receipt still frees the slot once the Guardian records the result.
  if (g.active?.status === 'queued' && (await settleIfDue(rpc, env, g.active))) g = await rpc.view(accounts.guardian, 'state');
  if (g.active) return json({ error: 'Another operation is in the timelock right now. Watch it below, or try again in a minute.', active: g.active }, 409);
  const block = await rpc.block({ finality: 'final' });
  const op = encodeOperation({ chain: 'testnet', guardian: accounts.guardian, target: accounts.token, configHash, nonce: BigInt(g.next_nonce), action: 'mint',
    deadlineNs: BigInt(block.header.timestamp_nanosec) + 600n * 10n ** 9n, receiver, amount: MINT_AMOUNT });
  const approvals = [{ index: 0, signature: signer(env.SIGNER_A).sign(op, GUARDIAN_CONTEXT) }, { index: 1, signature: signer(env.SIGNER_B).sign(op, GUARDIAN_CONTEXT) }];
  const r = await rpc.send(env.RELAYER_ID, edKey(env.RELAYER_KEY), accounts.guardian, [functionCall('propose', envelope(op, approvals), 300n * TGAS)]);
  return json({ ok: r.ok, tx: r.hash, failure: r.failure, proposal_hash: sha256(op).toString('hex'), message_hex: op.toString('hex'), receiver_id: receiver, amount: MINT_AMOUNT.toString() }, r.ok ? 200 : 502);
}

// Runs execute (or expire after the dispatch window) on a queued operation whose delay has passed; true once a
// transaction was sent, whatever its receipts: the caller reads the Guardian state again either way.
async function settleIfDue(rpc, env, a) {
  const now = BigInt((await rpc.block({ finality: 'optimistic' })).header.timestamp_nanosec);
  if (now < BigInt(a.eta_ns)) return false;
  const method = now >= BigInt(a.expires_ns) ? 'expire' : 'execute';
  await rpc.send(env.RELAYER_ID, edKey(env.RELAYER_KEY), accounts.guardian, [functionCall(method, new Uint8Array(0), method === 'expire' ? 30n * TGAS : 300n * TGAS)]);
  return true;
}

// Executes the active operation once its delay has passed; after its dispatch window it is closed with expire().
async function execute(rpc, env, body) {
  if (!writable(env)) return readOnly();
  const g = await rpc.view(accounts.guardian, 'state');
  const a = g.active;
  if (!a || a.status !== 'queued' || (body?.proposal_hash && body.proposal_hash !== a.proposal_hash)) return json({ error: 'Nothing is waiting to be executed.', last: g.last }, 409);
  const now = BigInt((await rpc.block({ finality: 'optimistic' })).header.timestamp_nanosec);
  if (now < BigInt(a.eta_ns)) return json({ error: 'The timelock has not passed yet.', eta_ns: a.eta_ns }, 409);
  const method = now >= BigInt(a.expires_ns) ? 'expire' : 'execute';
  const r = await rpc.send(env.RELAYER_ID, edKey(env.RELAYER_KEY), accounts.guardian, [functionCall(method, new Uint8Array(0), method === 'expire' ? 30n * TGAS : 300n * TGAS)]);
  return json({ ok: r.ok, method, tx: r.hash, failure: r.failure }, r.ok ? 200 : 502);
}

// The retired credentials, published after the verified cutover. Each experiment returns a typed verdict; only the
// specific expected defense is reported as blocked.
async function attack(rpc, env, kind) {
  if (!env.RETIRED_OWNER_KEY || !env.RETIRED_TOKEN_KEY) return readOnly();
  if (kind === 'owner-mint') {
    const args = JSON.stringify({ receiver_id: accounts.owner, amount: ATTACK_AMOUNT.toString(), op_id: '999999' });
    const r = await rpc.send(accounts.owner, edKey(env.RETIRED_OWNER_KEY), accounts.token, [functionCall('mint', args, 30n * TGAS)], 'FINAL');
    return json({ attempted: 'The former owner calls mint with its still-valid account key.', tx: r.hash, failure: r.failure, ...ownerMintVerdict(r, { owner: accounts.owner, token: accounts.token, args }) });
  }
  if (kind === 'token-deploy') {
    const key = edKey(env.RETIRED_TOKEN_KEY);
    const r = await rpc.send(accounts.token, key, accounts.token, [deployContract(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))], 'FINAL');
    return json({ attempted: "Someone signs a code deployment with the token account's deleted key.", tx: r.ok ? r.hash : null, failure: r.failure, ...deletedKeyVerdict(r, { token: accounts.token, publicKey: key.publicKey }) });
  }
  return json({ error: 'unknown attack' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rpc = new Rpc(RPC);
    try {
      if (url.pathname === '/api/report') return json(await cached('report', 20000, () => report(rpc)));
      if (url.pathname === '/api/state') return json(await cached('state', 2000, () => state(rpc, env)));
      if (url.pathname === '/api/retired-keys') {
        return json({ owner: { account: accounts.owner, secret: env.RETIRED_OWNER_KEY ?? null }, token: { account: accounts.token, secret: env.RETIRED_TOKEN_KEY ?? null, deleted_in: deployment.cutover.delete_keys_tx } });
      }
      if (request.method === 'POST') {
        const ip = request.headers.get('cf-connecting-ip') ?? 'local';
        const body = await request.json().catch(() => ({}));
        if (url.pathname === '/api/mint') return await mint(rpc, env, body, ip);
        if (url.pathname === '/api/execute') return await execute(rpc, env, body);
        if (url.pathname.startsWith('/api/attack/')) return await attack(rpc, env, url.pathname.slice(12));
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: `RPC or demo error: ${String(e.message ?? e).slice(0, 300)}`, verdict: UNVERIFIED }, 502);
    }
  },
};
