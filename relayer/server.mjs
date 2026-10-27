// HTTP front of the relayer: POST /execute, GET /outcome/<tx>, GET /health. Node http, no framework.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { checkRelayerAccount } from './account.mjs';
import { createChain } from './chain.mjs';
import { loadConfig } from './config.mjs';
import { costBound, readProtocolCosts } from './cost.mjs';
import { Limiter, Quota, SpendCap } from './limits.mjs';
import { acquireLock } from './lock.mjs';
import { REQUEST_LEN } from './message.mjs';
import { createOutcomeReader, outcome } from './outcome.mjs';
import { attachedGas, createRelay } from './relay.mjs';
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
 * `relay(body, ip)` and `outcomeOf(txHash, ip)` come from relay.mjs and outcome.mjs (both resolve to
 * { status, body }); `health()` returns
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
        const r = await outcomeOf(m[1], req.socket.remoteAddress ?? 'unknown');
        return reply(req, res, r.status, r.body);
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

/**
 * Wires the real chain, key and limits from the environment. Takes the state directory's lock first, so a
 * second instance on the same directory refuses before it reads the spend file. Refuses to start without
 * the protocol config, or when the relayer account could spend more than RELAYER_MAX_ACCOUNT_SPENDABLE.
 * Closing the server releases the lock.
 */
export async function startFromEnv(env = process.env) {
  const cfg = loadConfig(env);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(cfg.stateDir, { clearStale: cfg.clearStaleLock });
  try {
    return await start(cfg, release);
  } catch (e) {
    release();
    throw e;
  }
}

async function start(cfg, release) {
  const rpc = createRpc(cfg.rpcUrl);
  const costs = await readProtocolCosts(rpc, cfg.deployment);
  if (cfg.maxGasPriceYocto > costs.maxGasPrice) throw new Error('RELAYER_MAX_GAS_PRICE_YOCTO is above the protocol max_gas_price');
  const spendableAtStart = await checkRelayerAccount(rpc, { account: cfg.account, storageAmountPerByte: costs.storageAmountPerByte, maxSpendable: cfg.maxAccountSpendableYocto });
  const costOf = (req) => costBound(costs, { argsLen: REQUEST_LEN, prepaidGas: attachedGas(req), maxGasPriceYocto: cfg.maxGasPriceYocto });
  const cap = new SpendCap(cfg.spendCapYocto, { file: cfg.stateFile });
  const chain = createChain({ rpc, deployment: cfg.deployment });
  const submitter = createSubmitter({ rpc, accountId: cfg.account, keyPair: loadRelayerKey(cfg.keyFile), maxGasPriceYocto: cfg.maxGasPriceYocto, priceStep: costs.priceStep });
  const { relay, ledger } = createRelay({
    deployment: cfg.deployment,
    readVault: chain.readVault,
    gasPrice: chain.gasPrice,
    submit: submitter.submit,
    rebroadcast: submitter.rebroadcast,
    limiter: new Limiter({ concurrency: cfg.concurrency, queue: cfg.queue }),
    vaultQuota: new Quota({ limit: cfg.vaultPerHour, windowMs: cfg.windowMs }),
    ipQuota: new Quota({ limit: cfg.ipPerHour, windowMs: cfg.windowMs }),
    cap,
    costOf,
    maxGasPriceYocto: cfg.maxGasPriceYocto,
  });
  const outcomeOf = createOutcomeReader({
    read: (txHash) => outcome(rpc, { txHash, sender: cfg.account, deployment: cfg.deployment, ours: ledger.knows(txHash) }),
    limiter: new Limiter({ concurrency: cfg.outcomeConcurrency, queue: cfg.outcomeQueue }),
    ipQuota: new Quota({ limit: cfg.outcomePerMinute, windowMs: cfg.outcomeWindowMs }),
    globalQuota: new Quota({ limit: cfg.outcomeGlobalPerMinute, windowMs: cfg.outcomeWindowMs }),
    observe: (txHash, r) => ledger.observe(txHash, r),
  });
  const nearTransferBound = costOf({ action: 0, ftGasTgas: 0 });
  const server = createRelayerServer({
    relay,
    outcomeOf,
    health: () => ({ ok: !cap.paused, network: cfg.deployment.network, factory: cfg.deployment.factory, relayer: cfg.account,
      paused: cap.paused, spent_yocto: cap.spent.toString(), cap_yocto: cap.cap.toString(),
      protocol_version: costs.protocolVersion, max_gas_price_yocto: cfg.maxGasPriceYocto.toString(), near_transfer_bound_yocto: nearTransferBound.toString(),
      account_spendable_at_start_yocto: spendableAtStart.toString(), max_account_spendable_yocto: cfg.maxAccountSpendableYocto.toString() }),
  });
  server.once('close', release);
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(cfg.port, cfg.host, ok); });
  // The ledger is returned for in-process inspection (tests); it is never served.
  return { server, address: server.address(), stateFile: cfg.stateFile, ledger };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startFromEnv().then(({ address }) => console.log(`relayer listening on ${address.address}:${address.port}`), (e) => {
    console.error(`relayer did not start: ${e.message}`);
    process.exitCode = 1;
  });
}
