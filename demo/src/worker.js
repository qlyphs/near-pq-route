// Qlyphs Guardian demo Worker (NEAR testnet): the "Verify control" report, live PQ-approved mints anyone can
// request and execute, and the retired-credential attacks. Static page in demo/public.
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import deployment from '../../deployments/guardian-qlyphs-guardian.json';
import { encodeOperation, envelope, sha256, verifyControl, isAccountId, GUARDIAN_CONTEXT } from '../../sdk/guardian.mjs';
import { Rpc, edKey, functionCall, deployContract } from './near.js';

const RPC = 'https://test.rpc.fastnear.com';
const TGAS = 10n ** 12n;
const MINT_AMOUNT = 100n;
const { accounts } = deployment;
const config = Buffer.from(deployment.guardian_creation.config_hex, 'hex');
const configHash = sha256(config);
const json = (body, status = 200) => new Response(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
// A demo signer from its 32-byte FIPS 204 seed (a Worker secret). Signs exactly like the wallet: Pure
// ML-DSA-87 over the 320-byte operation with the Guardian context.
const signer = (seedHex) => { const kp = ml_dsa87.keygen(fromHex(seedHex)); return { sign: (m, ctx) => Buffer.from(ml_dsa87.sign(Uint8Array.from(m), kp.secretKey, { context: Uint8Array.from(ctx) })) }; };
const recent = new Map(); // per-isolate request pacing, a courtesy limit only

async function report(rpc) {
  return verifyControl(rpc, { network: 'testnet', guardian: accounts.guardian, target: accounts.token, guardianSha256: deployment.guardian_creation.guardian_sha256,
    reviewedTargetSha256: deployment.reviewed_target_sha256, config, deployment });
}

async function state(rpc) {
  const [guardian, token, metadata] = await Promise.all([rpc.view(accounts.guardian, 'state'), rpc.view(accounts.token, 'state'), rpc.view(accounts.token, 'ft_metadata')]);
  const block = await rpc.block({ finality: 'optimistic' });
  return { guardian, token, metadata, now_ns: block.header.timestamp_nanosec, accounts, ceremony: { parent_tx: deployment.parent_tx, legacy: deployment.legacy, guardian_creation: { tx: deployment.guardian_creation.tx, audit: deployment.guardian_creation.audit }, cutover: deployment.cutover, operations: deployment.operations, max: deployment.max } };
}

async function mint(rpc, env, body, ip) {
  const receiver = String(body?.receiver_id ?? '').trim().toLowerCase();
  if (!isAccountId(receiver)) return json({ error: 'Enter a valid NEAR account id (testnet), for example alice.testnet.' }, 400);
  const last = recent.get(ip) ?? 0;
  if (Date.now() - last < 30000) return json({ error: 'One request every 30 seconds, please.' }, 429);
  recent.set(ip, Date.now());
  const g = await rpc.view(accounts.guardian, 'state');
  if (g.active) return json({ error: 'Another operation is in the timelock right now. Watch it below, or try again in a minute.', active: g.active }, 409);
  const block = await rpc.block({ finality: 'final' });
  const op = encodeOperation({ chain: 'testnet', guardian: accounts.guardian, target: accounts.token, configHash, nonce: BigInt(g.next_nonce), action: 'mint',
    deadlineNs: BigInt(block.header.timestamp_nanosec) + 600n * 10n ** 9n, receiver, amount: MINT_AMOUNT });
  const approvals = [{ index: 0, signature: signer(env.SIGNER_A).sign(op, GUARDIAN_CONTEXT) }, { index: 1, signature: signer(env.SIGNER_B).sign(op, GUARDIAN_CONTEXT) }];
  const r = await rpc.send(env.RELAYER_ID, edKey(env.RELAYER_KEY), accounts.guardian, [functionCall('propose', envelope(op, approvals), 300n * TGAS)]);
  return json({ ok: r.ok, tx: r.hash, failure: r.failure, proposal_hash: sha256(op).toString('hex'), message_hex: op.toString('hex') }, r.ok ? 200 : 502);
}

async function execute(rpc, env) {
  const g = await rpc.view(accounts.guardian, 'state');
  if (!g.active || g.active.status !== 'queued') return json({ error: 'Nothing is waiting to be executed.' }, 409);
  const block = await rpc.block({ finality: 'optimistic' });
  if (BigInt(block.header.timestamp_nanosec) < BigInt(g.active.eta_ns)) return json({ error: 'The timelock has not passed yet.', eta_ns: g.active.eta_ns }, 409);
  const r = await rpc.send(env.RELAYER_ID, edKey(env.RELAYER_KEY), accounts.guardian, [functionCall('execute', new Uint8Array(0), 300n * TGAS)]);
  return json({ ok: r.ok, tx: r.hash, failure: r.failure }, r.ok ? 200 : 502);
}

// The retired credentials, published after the verified cutover. Anyone can reuse them; these calls show what
// happens when they do.
async function attack(rpc, env, kind) {
  if (kind === 'owner-mint') {
    const r = await rpc.send(accounts.owner, edKey(env.RETIRED_OWNER_KEY), accounts.token, [functionCall('mint', JSON.stringify({ receiver_id: accounts.owner, amount: '1000000000', op_id: '999999' }), 30n * TGAS)]);
    return json({ attempted: 'The former owner calls mint with its still-valid account key.', tx: r.hash, ok: r.ok, failure: r.failure,
      refused_as_expected: !r.ok && /only the Guardian can do this/.test(r.failure ?? '') });
  }
  if (kind === 'token-deploy') {
    const r = await rpc.send(accounts.token, edKey(env.RETIRED_TOKEN_KEY), accounts.token, [deployContract(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))]);
    return json({ attempted: "Someone signs a code deployment with the token account's deleted key.", tx: r.ok ? r.hash : null, ok: r.ok, failure: r.failure,
      refused_as_expected: !r.ok && /InvalidAccessKeyError/.test(r.failure ?? '') && /AccessKeyNotFound/.test(r.failure ?? '') });
  }
  return json({ error: 'unknown attack' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rpc = new Rpc(RPC);
    try {
      if (url.pathname === '/api/report') return json(await report(rpc));
      if (url.pathname === '/api/state') return json(await state(rpc));
      if (url.pathname === '/api/retired-keys') return json({ owner: { account: accounts.owner, secret: env.RETIRED_OWNER_KEY }, token: { account: accounts.token, secret: env.RETIRED_TOKEN_KEY, deleted_in: deployment.cutover.delete_keys_tx } });
      if (request.method === 'POST') {
        const ip = request.headers.get('cf-connecting-ip') ?? 'local';
        if (url.pathname === '/api/mint') return await mint(rpc, env, await request.json().catch(() => ({})), ip);
        if (url.pathname === '/api/execute') return await execute(rpc, env);
        if (url.pathname.startsWith('/api/attack/')) return await attack(rpc, env, url.pathname.slice(12));
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: `RPC or demo error: ${String(e.message ?? e).slice(0, 300)}` }, 502);
    }
  },
};
