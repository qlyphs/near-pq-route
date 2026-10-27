// Testnet end to end with the real Qlyphs wallet extension (development build) in Chromium: the wallet
// derives the vault key, the factory creates the vault, the wallet signs a payment after a human-style
// review, the relayer pays the gas, and the wallet follows the outcome. Also checks the signing journal
// and the 24-word rule. Writes evidence/wallet-e2e-testnet.json.
// Usage: PARENT_ACCOUNT=<id> PARENT_KEY_FILE=<ed25519 key file> RELAYER_ACCOUNT=<id> RELAYER_KEY_FILE=<file>
//        [MONOREPO=~/quantus-otc] [SKIP_BUILD=1] node tests/wallet.e2e.testnet.mjs
import { connect, KeyPair, keyStores } from 'near-api-js';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkVault, encodeMessage, vaultAddress } from '../sdk/vault.mjs';

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const NODE = 'https://test.rpc.fastnear.com';
const PORT = 8797;
const { PARENT_ACCOUNT: parentId, RELAYER_ACCOUNT: relayerId } = process.env;
if (!parentId || !relayerId || !process.env.PARENT_KEY_FILE || !process.env.RELAYER_KEY_FILE) throw new Error('see Usage');

const monorepo = process.env.MONOREPO ?? join(homedir(), 'quantus-otc');
const extensionDir = join(monorepo, 'apps/extension');
const requireExt = createRequire(join(extensionDir, 'package.json'));
const { chromium } = requireExt('@playwright/test');
const { generateMnemonic } = requireExt('@scure/bip39');
const { wordlist } = requireExt('@scure/bip39/wordlists/english.js');

const deployment = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));
const evidenceDir = new URL('../evidence/', import.meta.url);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

const out = { network: 'testnet', factory: deployment.factory, relayer: relayerId, funder: parentId, steps: [], states_seen: {} };
const step = (name, ok, extra = {}) => {
  out.steps.push({ name, ok, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.tx ? ` tx=${extra.tx}` : ''}${extra.detail ? ` (${extra.detail})` : ''}`);
  return ok;
};

// NEAR side: the funder (parent) and a read-only provider.
const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey('testnet', parentId, KeyPair.fromString(readFileSync(process.env.PARENT_KEY_FILE, 'utf8').trim()));
const near = await connect({ networkId: 'testnet', nodeUrl: NODE, keyStore });
const provider = near.connection.provider;
const parent = await near.account(parentId);
const finalHeight = async () => BigInt((await provider.block({ finality: 'final' })).header.height);

// 1. Build and launch the development extension in a disposable profile.
if (!process.env.SKIP_BUILD) execFileSync('node', ['build.mjs'], { cwd: extensionDir, stdio: ['ignore', 'ignore', 'inherit'] });
const dist = resolve(extensionDir, 'dist/chrome');
const build = JSON.parse(readFileSync(join(dist, 'BUILD.json'), 'utf8'));
out.extension = { version: build.version, developmentFeatures: build.developmentFeatures, chromeId: build.chromeId };

async function launch(words) {
  const profile = mkdtempSync(join(tmpdir(), 'qlyphs-near-vault-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const close = async () => { await context.close(); rmSync(profile, { recursive: true, force: true }); };
  try {
    return await prepare(context, close, words);
  } catch (e) {
    await close();
    throw e;
  }
}
async function prepare(context, close, words) {
  const wallet = await context.newPage();
  await wallet.goto(`chrome-extension://${build.chromeId}/ui.html?surface=tab`);
  const message = (data) => wallet.evaluate((m) => chrome.runtime.sendMessage(m), data);
  await wallet.locator('#use-network').waitFor({ state: 'visible', timeout: 30000 });
  await wallet.locator('#use-network').click();
  const phrase = generateMnemonic(wordlist, words === 24 ? 256 : 128);
  // Choosing the network pins it in the background; import waits for that pin.
  let imported;
  for (let i = 0; i < 40; i++) {
    imported = await message({ action: 'import', password: randomUUID(), phrase });
    if (imported?.error !== 'Finish the current operation before changing accounts') break;
    await sleep(500);
  }
  if (imported?.error) throw new Error(`import refused: ${imported.error}`);
  // Account-scoped UI actions name the account they expect, as the wallet's own views do.
  const owner = (await message({ action: 'status' })).result?.account?.owner;
  const ack = await message({ action: 'ack', expectedOwner: owner });
  if (ack?.error) throw new Error(`backup acknowledgement refused: ${ack.error}`);
  const dapp = await context.newPage();
  await dapp.goto(build.api);
  await dapp.waitForFunction(() => !!window.qlyphs);
  const review = (start) => async () => {
    const opened = context.waitForEvent('page', { predicate: (p) => p !== wallet && p !== dapp, timeout: 30000 });
    await start();
    const page = await opened;
    await page.waitForURL(`chrome-extension://${build.chromeId}/ui.html?request=*`);
    await page.locator('body[data-busy="false"]').waitFor({ timeout: 30000 });
    return page;
  };
  // The site's calls run in the page; each result is kept on window so a review can sit in between.
  // NEAR vault methods go over the provider's own page channel (qlyphs:request:1) because the injected
  // provider of this build does not forward them (recorded as a failed step). Content script and
  // background see exactly what the provider would have sent.
  await dapp.evaluate(() => {
    window.rawRequest = (method, params) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const on = (event) => {
        const d = event.data;
        if (event.source !== window || d?.channel !== 'qlyphs:response:1' || d.id !== id) return;
        window.removeEventListener('message', on);
        if (d.error) reject(Object.assign(new Error(d.error.message), { code: d.error.code }));
        else resolve(d.result);
      };
      window.addEventListener('message', on);
      window.postMessage({ channel: 'qlyphs:request:1', request: { id, method, ...(params === undefined ? {} : { params }) } }, location.origin);
    });
  });
  // Every call goes through window.qlyphs, as a site would. rawRequest stays for comparison only.
  const viaProvider = () => true;
  const call = (method, params, provider = viaProvider(method)) => dapp.evaluate(async ([method, params, provider]) => {
    try {
      return { result: await (provider ? window.qlyphs.request(params ? { method, params } : { method }) : window.rawRequest(method, params)) };
    } catch (e) {
      return { error: { code: e?.code ?? null, message: e?.message ?? String(e) } };
    }
  }, [method, params, provider]);
  const start = (slot, method, params) => dapp.evaluate(([slot, method, params, provider]) => {
    window[slot] = null;
    (provider ? window.qlyphs.request(params === undefined ? { method } : { method, params }) : window.rawRequest(method, params)).then(
      (result) => { window[slot] = { result }; },
      (e) => { window[slot] = { error: { code: e?.code ?? null, message: e?.message ?? String(e) } }; });
  }, [slot, method, params, viaProvider(method)]);
  const settled = async (slot, ms = 60000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await dapp.evaluate((s) => window[s], slot);
      if (v) return v;
      if (Date.now() > end) return { error: { code: 'TEST_TIMEOUT', message: `no answer within ${ms} ms` } };
      await sleep(250);
    }
  };
  const page = await review(() => start('connected', 'connect'))();
  await page.locator('#approve').click();
  const connected = await settled('connected');
  return { context, close, wallet, dapp, call, start, settled, review, connected, message };
}

// Signs `message` through the review window: returns what the review showed and what the site got.
async function signThroughReview(w, slot, message, { shot } = {}) {
  const page = await w.review(() => w.start(slot, 'signNearVaultAuthorization', { message }))();
  const shown = {
    title: await page.locator('#review-title').textContent(),
    button: await page.locator('#approve').textContent(),
    summary: (await page.locator('#review-summary').innerText()).replace(/\s+/g, ' '),
  };
  if (shot) await page.screenshot({ path: shot });
  await page.locator('#approve').click();
  const answer = await w.settled(slot);
  if (answer.error) shown.after = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
  return { shown, answer };
}

let relayer, w;
try {
  w = await launch(24);
  step('dev extension built, fresh 24-word phrase imported, backup acknowledged, site connected',
    !w.connected.error && build.developmentFeatures?.includes('nearVault'),
    { detail: `extension ${build.version}, connect ${JSON.stringify(w.connected.result ?? w.connected.error)}` });

  // The documented call, through window.qlyphs.request, and what the wallet advertises.
  const viaInjected = await w.call('nearVaultPublicKey', undefined, true);
  const caps = await w.call('capabilities', undefined, true);
  out.injected_provider = { nearVaultPublicKey: viaInjected, capabilities_lists_nearVault: caps.result?.methods?.includes('nearVaultPublicKey') ?? null };
  step('window.qlyphs.request forwards nearVaultPublicKey (documented call)', !viaInjected.error || viaInjected.error.code !== 'UNSUPPORTED_METHOD',
    { detail: `${JSON.stringify(viaInjected.error ?? 'ok')}; capabilities lists it: ${out.injected_provider.capabilities_lists_nearVault}` });

  // 2. Key and vault state: derived, then the factory creates it, then verified.
  const k1 = await w.call('nearVaultPublicKey');
  if (k1.error) throw new Error(`nearVaultPublicKey: ${JSON.stringify(k1.error)}`);
  const publicKey = Buffer.from(k1.result.publicKey.slice(2), 'hex');
  const vault = k1.result.vault;
  out.vault = vault;
  out.wallet_address = k1.result.address;
  out.states_seen.nearVaultPublicKey = [k1.result.state];
  step('nearVaultPublicKey on a fresh key: state derived, vault id is the factory derivation',
    k1.result.state === 'derived' && publicKey.length === 2592 && vault === vaultAddress(publicKey, deployment.factory) && k1.result.network === 'testnet',
    { detail: `state ${k1.result.state}, vault ${vault}` });

  const created = await parent.functionCall({ contractId: deployment.factory, methodName: 'create', args: new Uint8Array(publicKey), gas: 200n * TGAS, attachedDeposit: NEAR / 4n });
  out.tx_create = created.transaction.hash;
  await provider.txStatus(created.transaction.hash, parentId, 'FINAL');
  let k2;
  for (let i = 0; i < 30; i++) {
    k2 = await w.call('nearVaultPublicKey');
    const s = k2.result?.state ?? `error:${k2.error?.code}`;
    if (out.states_seen.nearVaultPublicKey.at(-1) !== s) out.states_seen.nearVaultPublicKey.push(s);
    if (s === 'verified') break;
    await sleep(2000);
  }
  step('factory create final, then nearVaultPublicKey reads verified',
    !created.status?.Failure && k2.result?.state === 'verified' && k2.result.vault === vault,
    { tx: out.tx_create, detail: out.states_seen.nearVaultPublicKey.join(' -> ') });

  const funded = await parent.sendMoney(vault, NEAR / 20n);
  out.tx_fund = funded.transaction.hash;
  await provider.txStatus(funded.transaction.hash, parentId, 'FINAL');
  const before = await checkVault(provider, deployment, { vault, publicKey });
  step('vault funded with 0.05 test NEAR', !funded.status?.Failure, { tx: out.tx_fund, detail: `balance ${before.balance} yocto, nonce ${before.nonce}` });

  // 3. A 0.01 NEAR payment to the relayer account, reviewed and signed in the wallet.
  const h1 = await finalHeight();
  const m1 = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: relayerId, amount: NEAR / 100n, nonce: before.nonce, issued: h1, expiry: h1 + 600n });
  mkdirSync(new URL('wallet-e2e/', evidenceDir), { recursive: true });
  const s1 = await signThroughReview(w, 'sig1', hex(m1), { shot: new URL('wallet-e2e/payment-review.png', evidenceDir).pathname });
  out.review_payment = s1.shown;
  const reviewOk = s1.shown.summary.includes(relayerId) && s1.shown.summary.includes(vault) && /0\.01 NEAR/.test(s1.shown.summary) && s1.shown.button === 'Sign payment';
  step('review window shows recipient, amount and vault', reviewOk, { detail: s1.shown.summary.slice(0, 300) });
  const sig1 = s1.answer.result;
  step('approved: site gets {publicKey, signature} of the right sizes and key',
    !!sig1 && sig1.publicKey === k1.result.publicKey && sig1.signature.length === 2 + 2 * 4627,
    { detail: sig1 ? `signature ${(sig1.signature.length - 2) / 2} bytes` : JSON.stringify(s1.answer.error) });
  if (!sig1) throw new Error('no signature; stopping before the relayer');

  // 4. Relayer as its own process; the wallet follows the outcome from its own node.
  relayer = spawn(process.execPath, ['relayer/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), RELAYER_SPEND_CAP_YOCTO: String(NEAR / 10n) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayerLog = '';
  relayer.stdout.on('data', (d) => { relayerLog += d; });
  relayer.stderr.on('data', (d) => { relayerLog += d; });
  for (let i = 0; i < 50 && !/listening/.test(relayerLog); i++) await sleep(200);
  if (!/listening/.test(relayerLog)) throw new Error(`relayer did not start: ${relayerLog}`);
  const body = Buffer.concat([Buffer.from(sig1.signature.slice(2), 'hex'), m1]);
  const posted = await fetch(`http://127.0.0.1:${PORT}/execute`, { method: 'POST', body });
  const postedBody = await posted.json();
  const tx = postedBody.transaction;
  out.tx_payment = tx;
  step('relayer accepts the wallet signature and returns a transaction hash', posted.status === 200 && !!tx,
    { tx, detail: `HTTP ${posted.status} ${JSON.stringify(postedBody)}` });
  const outcomes = [];
  let st;
  for (let i = 0; i < 45; i++) {
    st = await w.call('nearVaultAuthorizationStatus', { message: hex(m1), transaction: tx, sender: relayerId });
    const o = st.result?.outcome ?? `error:${st.error?.code}`;
    if (outcomes.at(-1) !== o) outcomes.push(o);
    if (o === 'delivered' || o === 'failed') break;
    await sleep(2000);
  }
  out.states_seen.nearVaultAuthorizationStatus = outcomes;
  const relayerView = await (await fetch(`http://127.0.0.1:${PORT}/outcome/${tx}`)).json();
  out.relayer_outcome = relayerView;
  const allowed = new Set(['submitted', 'accepted', 'unknown', 'delivered']);
  step('wallet reads the outcome as delivered', st.result?.outcome === 'delivered' && outcomes.every((o) => allowed.has(o)),
    { tx, detail: `wallet ${outcomes.join(' -> ')}; relayer ${relayerView.status}` });
  const after = await checkVault(provider, deployment, { vault, publicKey });
  out.nonce = { before: before.nonce.toString(), after: after.nonce.toString() };
  step('vault nonce advanced by exactly 1', after.nonce === before.nonce + 1n, { detail: `${before.nonce} -> ${after.nonce}, balance ${before.balance} -> ${after.balance}` });

  // 5. Journal: A signed and kept, a different B at the same nonce refused, A again allowed.
  const h2 = await finalHeight();
  const mA = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: relayerId, amount: NEAR / 100n, nonce: after.nonce, issued: h2, expiry: h2 + 600n });
  const mB = encodeMessage({ chain: 'testnet', vault, kind: 'near', receiver: relayerId, amount: NEAR / 50n, nonce: after.nonce, issued: h2, expiry: h2 + 600n });
  const sA = await signThroughReview(w, 'sigA', hex(mA));
  step('journal: message A signed at the new nonce (not submitted)', !!sA.answer.result?.signature, { detail: sA.answer.error ? JSON.stringify(sA.answer.error) : `nonce ${after.nonce}` });
  const journal = await w.wallet.evaluate(async () => (await chrome.storage.local.get('nearVaultJournal')).nearVaultJournal);
  out.journal_after_A = (journal ?? []).map((e) => ({ vault: e.vault, nonce: e.nonce, expiry: e.expiry, origin: e.origin, is_A: e.message === '0x' + mA.toString('hex') }));
  // Refused before any review opens since the wallet's review-2 fixes.
  // Count review windows opened during the call; closing ones (A's review) do not count.
  let opened = 0;
  const onPage = (page) => { if (page.url().includes('ui.html?request=') || page.url() === 'about:blank') opened++; };
  w.context.on('page', onPage);
  const sB = await w.call('signNearVaultAuthorization', { message: hex(mB) });
  await new Promise((r) => setTimeout(r, 1500));
  w.context.off('page', onPage);
  out.refusal_B = { answer: sB, reviewWindowsOpened: opened };
  step('journal: different message B at the same nonce refused before any review, nothing signed',
    !!sB.error && !sB.result && opened === 0, { detail: JSON.stringify(sB.error ?? 'signed!') + `, ${opened} review window(s)` });
  const sA2 = await signThroughReview(w, 'sigA2', hex(mA));
  step('journal: message A signed again', !!sA2.answer.result?.signature, { detail: sA2.answer.error ? JSON.stringify(sA2.answer.error) : 'ok' });
  const stillNonce = (await checkVault(provider, deployment, { vault, publicKey })).nonce;
  step('nonce untouched by the journal checks (nothing submitted)', stillNonce === after.nonce, { detail: `nonce ${stillNonce}` });

  // 6. A 12-word phrase gets no vault.
  await w.close();
  w = null;
  const w12 = await launch(12);
  try {
    const k12 = await w12.call('nearVaultPublicKey');
    out.twelve_words = { connect: w12.connected.result ?? w12.connected.error, nearVaultPublicKey: k12 };
    step('12-word account refused by nearVaultPublicKey', !w12.connected.error && k12.error?.code === 'UNAUTHORIZED' && !k12.result,
      { detail: JSON.stringify(k12.error ?? k12.result) });
  } finally {
    await w12.close();
  }
} catch (e) {
  step('run aborted', false, { detail: e?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e) });
} finally {
  relayer?.kill();
  await w?.close?.();
  const fails = out.steps.filter((s) => !s.ok).length;
  out.passed = `${out.steps.length - fails}/${out.steps.length}`;
  writeFileSync(new URL('wallet-e2e-testnet.json', evidenceDir), JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(`${out.passed} passed`);
  process.exitCode = fails ? 1 : 0;
}
