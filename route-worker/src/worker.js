// Public helper of the post-quantum QTC route (testnet). It holds no authority over funds:
//  - a mailbox for sealed payment requests (ML-KEM-1024 + AES-256-GCM ciphertext only; it cannot read them),
//  - the queue of route claims the payer's wallet signed (public data the attesters verify themselves),
//  - a sponsor that creates a fresh NEAR testnet account whose only key is the ML-DSA-65 key it is given; the
//    sponsor itself signs with ML-DSA-65 (its only key).
import { actions, sendTx } from '@fastnear/api';
import { signerFromSeed } from '@fastnear/ml-dsa-65';

const MAX_REQUEST = 32 * 1024;
const DAY = 86400;
const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/** The fresh account's name: r + 20 hex of SHA-256(the "ml-dsa-65:" public key string), under the sponsor. */
export const accountFor = async (publicKey, sponsor) => `r${hex(await sha256(new TextEncoder().encode(publicKey))).slice(0, 20)}.${sponsor}`;

async function rateLimit(env, key, max, ttl) {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / ttl)}`;
  const n = Number((await env.ROUTE.get(k)) ?? '0');
  if (n >= max) return false;
  await env.ROUTE.put(k, String(n + 1), { expirationTtl: ttl + 60 });
  return true;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',');
    const cors = origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    try {
      // Sealed payment requests: ciphertext in, an id out; anyone with the id may fetch the ciphertext.
      if (req.method === 'POST' && url.pathname === '/requests') {
        const body = new Uint8Array(await req.arrayBuffer());
        if (body.length > MAX_REQUEST || new TextDecoder().decode(body.subarray(0, 8)) !== 'QLYPREQ1') return json(400, { error: 'not a sealed payment request' }, cors);
        if (!(await rateLimit(env, `req:${ip}`, 60, 3600))) return json(429, { error: 'too many requests, try again in an hour' }, cors);
        const id = hex(await sha256(body)).slice(0, 32);
        await env.ROUTE.put(`request:${id}`, body, { expirationTtl: 7 * DAY });
        return json(200, { id }, cors);
      }
      let m = url.pathname.match(/^\/requests\/([0-9a-f]{32})$/);
      if (req.method === 'GET' && m) {
        const body = await env.ROUTE.get(`request:${m[1]}`, 'arrayBuffer');
        return body ? new Response(body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...cors } }) : json(404, { error: 'unknown or expired request' }, cors);
      }
      // Route claims: what the payer's wallet signed; the attesters re-check everything against the chains.
      if (req.method === 'POST' && url.pathname === '/claims') {
        const c = await req.json();
        const ok = /^0x[0-9a-f]{64}$/.test(c?.blockHash ?? '') && Number.isInteger(c?.extrinsicIndex) && /^[0-9a-f]{5184}$/.test(c?.publicKey ?? '')
          && typeof c?.route?.receiver === 'string' && typeof c?.route?.intents === 'boolean' && /^[0-9a-f]*$/.test(c?.route?.receipt ?? '')
          && /^[0-9a-f]+$/.test(c?.proof?.challenge ?? '') && /^[0-9a-f]{9254}$/.test(c?.proof?.signature ?? '');
        if (!ok) return json(400, { error: 'malformed claim' }, cors);
        if (!(await rateLimit(env, `claim:${ip}`, 30, 3600))) return json(429, { error: 'too many claims, try again in an hour' }, cors);
        const key = `claim:${String(Date.now()).padStart(15, '0')}:${c.blockHash}:${c.extrinsicIndex}`;
        await env.ROUTE.put(key, JSON.stringify({ ...c, origin }), { expirationTtl: 30 * DAY });
        return json(200, { queued: true, key }, cors);
      }
      if (req.method === 'GET' && url.pathname === '/claims') {
        const after = url.searchParams.get('after') ?? '';
        const list = await env.ROUTE.list({ prefix: 'claim:', limit: 100 });
        const keys = list.keys.map((k) => k.name).filter((k) => k > after).sort().slice(0, 20);
        const claims = [];
        for (const k of keys) claims.push({ key: k, ...(JSON.parse((await env.ROUTE.get(k)) ?? '{}')) });
        return json(200, { claims }, cors);
      }
      // Mint records: the route service says which NEAR transaction minted a deposit. Only a pointer: the page reads
      // that transaction from NEAR itself to tell delivery into Intents from a refund to the account.
      if (req.method === 'POST' && url.pathname === '/mints') {
        if (req.headers.get('authorization') !== `Bearer ${env.SERVICE_TOKEN}`) return json(401, { error: 'not the route service' }, cors);
        const { depositId, tx, signer } = await req.json();
        if (!/^[0-9a-f]{64}$/.test(depositId ?? '') || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx ?? '') || typeof signer !== 'string') return json(400, { error: 'malformed mint record' }, cors);
        await env.ROUTE.put(`mint:${depositId}`, JSON.stringify({ tx, signer }), { expirationTtl: 60 * DAY });
        return json(200, { ok: true }, cors);
      }
      m = url.pathname.match(/^\/mints\/([0-9a-f]{64})$/);
      if (req.method === 'GET' && m) {
        const v = await env.ROUTE.get(`mint:${m[1]}`);
        return v ? json(200, JSON.parse(v), cors) : json(404, { error: 'no mint recorded for this deposit yet' }, cors);
      }
      // Sponsor: a fresh account with only the given ML-DSA-65 key and a little NEAR for gas.
      if (req.method === 'POST' && url.pathname === '/accounts') {
        const { publicKey } = await req.json();
        if (typeof publicKey !== 'string' || !/^ml-dsa-65:[1-9A-HJ-NP-Za-km-z]{2600,2700}$/.test(publicKey)) return json(400, { error: 'expects an ml-dsa-65: public key' }, cors);
        if (!(await rateLimit(env, `acct:${ip}`, 12, 3600)) || !(await rateLimit(env, 'acct:all', 200, DAY))) return json(429, { error: 'account limit reached, try again later' }, cors);
        const accountId = await accountFor(publicKey, env.SPONSOR_ID);
        const sponsor = signerFromSeed(Uint8Array.from(env.SPONSOR_SEED.match(/../g).map((h) => parseInt(h, 16))));
        const r = await sendTx({ signerId: env.SPONSOR_ID, signer: sponsor, receiverId: accountId, network: 'testnet', waitUntil: 'FINAL',
          actions: [actions.createAccount(), actions.transfer('250000000000000000000000'), actions.addFullAccessKey({ publicKey })] }).finally(() => sponsor.destroy());
        const s = JSON.stringify(r);
        const failure = s.match(/"(AccountAlreadyExists|ExecutionError)":?[^}]*/)?.[0];
        return json(failure ? 409 : 200, { accountId, tx: r?.result?.transaction?.hash, failure }, cors);
      }
      if (url.pathname === '/') return json(200, { service: 'qlyphs-pq-route', network: 'testnet', holds: 'ciphertexts, public claims, a sponsor key that only creates accounts' }, cors);
      return json(404, { error: 'not found' }, cors);
    } catch (e) {
      return json(500, { error: String(e?.message ?? e) }, cors);
    }
  },
};
