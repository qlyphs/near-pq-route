// HTTP front of the relayer: POST /execute, GET /outcome/<tx>, GET /health. Node http, no framework.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createChain } from './chain.mjs';
import { loadConfig } from './config.mjs';
import { Limiter, Quota, SpendCap } from './limits.mjs';
import { REQUEST_LEN } from './message.mjs';
import { TX_HASH, outcome } from './outcome.mjs';
import { createRelay } from './relay.mjs';
import { createRpc } from './rpc.mjs';
import { createSubmitter, loadRelayerKey } from './submitter.mjs';

function reply(req, res, status, body, { close = false } = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(close ? { connection: 'close' } : {}) });
  // On a refused body the rest is never read: answer, then drop the connection.
  res.end(text, () => { if (close) req.destroy(); });
}

/** Reads at most REQUEST_LEN bytes. Resolves to the body, or null once the client sent more. */
function readBody(req) {
  return new Promise((done, fail) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > REQUEST_LEN) return done(null);
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > REQUEST_LEN) {
        req.off('data', onData);
        req.pause();
        return done(null);
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => done(Buffer.concat(chunks, size)));
    req.on('error', fail);
  });
}

/**
 * `relay(body, ip)` and `outcomeOf(txHash)` come from relay.mjs and outcome.mjs; `health()` returns
 * public counters. The client address is the socket's: forwarded headers are not trusted.
 */
export function createRelayerServer({ relay, outcomeOf, health }) {
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://relayer').pathname;
      if (path === '/execute') {
        if (req.method !== 'POST') return reply(req, res, 405, { error: 'use POST' });
        const body = await readBody(req);
        if (!body) return reply(req, res, 400, { error: `body must be exactly ${REQUEST_LEN} bytes` }, { close: true });
        const r = await relay(body, req.socket.remoteAddress ?? 'unknown');
        return reply(req, res, r.status, r.body);
      }
      if (req.method !== 'GET') return reply(req, res, 405, { error: 'use GET' });
      if (path === '/health') return reply(req, res, 200, health());
      const m = /^\/outcome\/([^/]+)$/.exec(path);
      if (m) {
        if (!TX_HASH.test(m[1])) return reply(req, res, 400, { error: 'not a transaction hash' });
        return reply(req, res, 200, { transaction: m[1], ...(await outcomeOf(m[1])) });
      }
      return reply(req, res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) reply(req, res, 500, { error: 'internal error' }, { close: true });
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.maxHeadersCount = 32;
  return server;
}

/** Wires the real chain, key and limits from the environment. */
export function startFromEnv(env = process.env) {
  const cfg = loadConfig(env);
  const rpc = createRpc(cfg.rpcUrl);
  const cap = new SpendCap(cfg.spendCapYocto);
  const { relay, ledger } = createRelay({
    deployment: cfg.deployment,
    readVault: createChain({ rpc, deployment: cfg.deployment }).readVault,
    submit: createSubmitter({ rpc, accountId: cfg.account, keyPair: loadRelayerKey(cfg.keyFile) }),
    limiter: new Limiter({ concurrency: cfg.concurrency, queue: cfg.queue }),
    vaultQuota: new Quota({ limit: cfg.vaultPerHour, windowMs: cfg.windowMs }),
    ipQuota: new Quota({ limit: cfg.ipPerHour, windowMs: cfg.windowMs }),
    cap,
    gasPriceYocto: cfg.gasPriceYocto,
  });
  const server = createRelayerServer({
    relay,
    outcomeOf: (txHash) => outcome(rpc, { txHash, sender: cfg.account, ours: ledger.knows(txHash) }),
    health: () => ({ ok: !cap.paused, network: cfg.deployment.network, factory: cfg.deployment.factory, relayer: cfg.account,
      paused: cap.paused, spent_yocto: cap.spent.toString(), cap_yocto: cap.cap.toString() }),
  });
  return new Promise((ok) => server.listen(cfg.port, cfg.host, () => ok({ server, address: server.address() })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startFromEnv().then(({ address }) => console.log(`relayer listening on ${address.address}:${address.port}`), (e) => {
    console.error(`relayer did not start: ${e.message}`);
    process.exitCode = 1;
  });
}
