// Sandbox suite: factory creation, wallet preflight, payments and every refusal. Writes evidence/vault-sandbox.json.
import { Worker } from 'near-workspaces';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Key, auditFactoryCreation, checkVault, encodeMessage, executeArgs, vaultAddress, MAX_TTL_BLOCKS } from '../sdk/vault.mjs';

const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const results = [];
let failures = 0;

function record(name, ok, extra = {}) {
  results.push({ name, ok, ...extra });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` (${extra.detail})` : ''}`);
}
const failureText = (r) => JSON.stringify(r.Failure ?? r.receiptFailures ?? '');
async function expectRefused(name, call, reason) {
  const r = await call();
  record(name, r.failed && failureText(r).includes(reason), { detail: r.failed ? reason : 'was accepted' });
}
async function expectThrows(name, fn, reason) {
  try { await fn(); record(name, false, { detail: 'did not throw' }); } catch (e) { record(name, String(e.message).includes(reason), { detail: e.message }); }
}
// Writes an id field without the SDK's checks, to test what the contract itself refuses.
const rawId = (m, lenAt, at, id) => { m.fill(0, at, at + 64); m[lenAt] = Buffer.byteLength(id); m.write(id, at, 'latin1'); return m; };

const keys = mkdtempSync(join(tmpdir(), 'qvault-near-keys-'));
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const provider = worker.provider;
  const vaultWasm = readFileSync('build/vault-sandbox.wasm');
  const factoryWasm = readFileSync('build/factory-sandbox.wasm');
  const owner = Key.generate(join(keys, 'owner.pem'));
  const stranger = Key.generate(join(keys, 'stranger.pem'));
  const alice = await root.createSubAccount('alice', { initialBalance: 50n * NEAR });
  const relayer = await root.createSubAccount('relayer', { initialBalance: 50n * NEAR });
  const bob = await root.createSubAccount('bob', { initialBalance: 1n * NEAR });
  const total = async (a) => BigInt((await a.balance()).total.toString());
  const height = async () => BigInt((await provider.block({ finality: 'optimistic' })).header.height);
  const settle = async () => { const h = await height(); while ((await height()) < h + 3n) await new Promise((ok) => setTimeout(ok, 200)); };

  // Factory: created by a batch with no FunctionCall, so no code runs before its own.
  const factory = `factory.${root.accountId}`;
  const fr = await root.batch(factory).createAccount().transfer(3n * NEAR).deployContract(factoryWasm).transact();
  await settle();
  const deployment = { network: 'sandbox', factory, factory_sha256: sha(factoryWasm), vault_sha256: sha(vaultWasm) };
  const audit = await auditFactoryCreation(provider, { txHash: fr.result.transaction.hash, sender: root.accountId, factory });
  record('factory creation audit: CreateAccount, Transfer, DeployContract only', audit.actions.length === 3, { detail: audit.actions.join(',') });
  record('factory account has no access key', (await root.viewAccessKeys(factory)).keys.length === 0);

  const create = (pk, deposit = 5n * NEAR, from = alice, on = factory) =>
    from.callRaw(on, 'create', new Uint8Array(pk), { gas: 200n * TGAS, attachedDeposit: deposit });

  const cr = await create(owner.publicKey);
  await settle();
  const vault = vaultAddress(owner.publicKey, factory);
  record('factory creates the vault at the key-derived address', cr.succeeded && (await root.getAccount(vault).exists()), { detail: `${vault}, ${Number(BigInt(cr.gas_burnt)) / 1e12} Tgas total` });
  const pre = await checkVault(provider, deployment, { vault, publicKey: owner.publicKey }).catch((e) => e);
  record('wallet preflight passes on a factory vault', !(pre instanceof Error) && pre.nonce === 0n, { detail: pre instanceof Error ? pre.message : 'nonce 0' });
  const held = await total(root.getAccount(vault));
  record('vault holds the deposit minus the 0.01 NEAR registry fee', held >= 5n * NEAR - NEAR / 100n - NEAR / 1000n && held <= 5n * NEAR, { detail: `${Number(held) / 1e24} NEAR` });

  {
    const before = await total(alice);
    const again = await create(owner.publicKey, 2n * NEAR);
    await settle();
    const lost = before - (await total(alice));
    record('second vault for the same key refused, deposit returned', again.failed && failureText(again).includes('exists or is being created') && lost < NEAR / 100n, { detail: `caller net cost ${Number(lost) / 1e24} NEAR` });
  }
  await expectRefused('deposit below 0.25 NEAR', () => create(stranger.publicKey, NEAR / 10n), 'attach at least 0.25 NEAR');
  await expectRefused('wrong key length', () => alice.callRaw(factory, 'create', new Uint8Array(100), { gas: 200n * TGAS, attachedDeposit: NEAR }), 'expected a 2592-byte');
  await expectRefused('on_create is private', () => alice.callRaw(factory, 'on_create', new Uint8Array(17), { gas: 30n * TGAS }), 'private');
  await expectRefused('refund of a created vault', () => bob.callRaw(factory, 'refund', new Uint8Array(Buffer.from('r' + vault.split('.')[0], 'latin1')), { gas: 30n * TGAS }), 'no failed creation to refund');

  // A vault made outside the factory (the first review's delayed-AddKey batch) is never trusted.
  const rogue = `rogue.${root.accountId}`;
  await root.batch(rogue).createAccount().transfer(3n * NEAR).deployContract(vaultWasm).functionCall('init', new Uint8Array(owner.publicKey), { gas: 30n * TGAS }).transact();
  await expectThrows('preflight refuses a vault not created by the pinned factory', () => checkVault(provider, deployment, { vault: rogue, publicKey: owner.publicKey }), "not the pinned factory's address");

  // The second review's attack: a child made by an earlier life of the factory account id survives the
  // deletion and sits at the key-derived address. The audit of the new creation passes; the registry does not.
  {
    const victim = Key.generate(join(keys, 'victim.pem'));
    const early = await root.createSubAccount('factory2', { initialBalance: 10n * NEAR });
    const f2 = early.accountId;
    const planted = vaultAddress(victim.publicKey, f2);
    await early.batch(planted).createAccount().transfer(NEAR).deployContract(vaultWasm).functionCall('init', new Uint8Array(victim.publicKey), { gas: 30n * TGAS }).transact();
    // A second planted child, used below to make a refund transfer fail.
    const victim2 = Key.generate(join(keys, 'victim2.pem'));
    const planted2 = vaultAddress(victim2.publicKey, f2);
    await early.batch(planted2).createAccount().transfer(NEAR).transact();
    await early.delete(root.accountId);
    const again = await root.batch(f2).createAccount().transfer(3n * NEAR).deployContract(factoryWasm).transact();
    await settle();
    const d2 = { ...deployment, factory: f2 };
    const a2 = await auditFactoryCreation(provider, { txHash: again.result.transaction.hash, sender: root.accountId, factory: f2 }).then(() => true, () => false);
    record('earlier-life child: the re-creation alone passes the audit', a2 && (await root.getAccount(planted).exists()));
    await expectThrows('earlier-life child: preflight refuses it (no registry record)', () => checkVault(provider, d2, { vault: planted, publicKey: victim.publicKey }), 'not in the factory registry');
    const before = await total(alice);
    const blocked = await create(victim.publicKey, 2n * NEAR, alice, f2);
    await settle();
    const lost = before - (await total(alice));
    record('earlier-life child: creating that key fails and the record waits for a refund', blocked.logs.some((l) => l.includes('refund pending')) && lost > NEAR, { detail: `caller out ${Number(lost) / 1e24} NEAR until refund` });
    const rk = new Uint8Array(Buffer.from('r' + planted.split('.')[0], 'latin1'));
    await expectRefused('refund of an unknown key', () => bob.callRaw(f2, 'refund', new Uint8Array(Buffer.from('r' + '0'.repeat(16), 'latin1')), { gas: 30n * TGAS }), 'no such record');
    // Anyone may trigger it; the money goes to the recorded caller only.
    const paid = await bob.callRaw(f2, 'refund', rk, { gas: 50n * TGAS });
    await settle();
    const net = before - (await total(alice));
    record('refund, sent by a third party, pays the recorded caller', paid.succeeded && paid.logs.some((l) => l.includes('refunded')) && net < NEAR / 100n, { detail: `caller net cost ${Number(net) / 1e24} NEAR` });
    await expectRefused('second refund of the same record', () => bob.callRaw(f2, 'refund', rk, { gas: 30n * TGAS }), 'no such record');

    // Review 2: the refund's transfer fails because the caller's account is gone. The debt must survive.
    const carol = await root.createSubAccount('carol', { initialBalance: 5n * NEAR });
    const failing = await carol.callRaw(f2, 'create', new Uint8Array(victim2.publicKey), { gas: 200n * TGAS, attachedDeposit: 2n * NEAR });
    await settle();
    await carol.delete(root.accountId);
    await settle();
    const rk2 = new Uint8Array(Buffer.from('r' + planted2.split('.')[0], 'latin1'));
    const undelivered = await bob.callRaw(f2, 'refund', rk2, { gas: 50n * TGAS });
    await settle();
    record('refund to a deleted caller is not delivered and stays owed', failing.logs.some((l) => l.includes('refund pending')) && undelivered.logs.some((l) => l.includes('owed again')) && !undelivered.logs.some((l) => l === 'refunded'));
    await expectRefused('on_refund is private', () => bob.callRaw(f2, 'on_refund', rk2, { gas: 30n * TGAS }), 'private');
    const back = await root.createSubAccount('carol', { initialBalance: NEAR / 10n });
    const before2 = await total(back);
    const paid2 = await bob.callRaw(f2, 'refund', rk2, { gas: 50n * TGAS });
    await settle();
    const got = (await total(back)) - before2;
    record('once the caller exists again, the owed refund is paid exactly once', paid2.logs.some((l) => l === 'refunded') && got === 2n * NEAR, { detail: `${Number(got) / 1e24} NEAR` });
    await expectRefused('no third refund', () => bob.callRaw(f2, 'refund', rk2, { gas: 50n * TGAS }), 'no such record');
    await expectThrows('earlier-life child: still refused after the failed creation', () => checkVault(provider, d2, { vault: planted, publicKey: victim.publicKey }), 'not in the factory registry');
  }
  await expectThrows('preflight refuses another owner key', () => checkVault(provider, deployment, { vault, publicKey: stranger.publicKey }), "not the pinned factory's address");
  await expectThrows('preflight refuses a factory with other pinned code', () => checkVault(provider, { ...deployment, factory_sha256: '00'.repeat(32) }, { vault, publicKey: owner.publicKey }), 'factory code');
  await expectThrows('SDK refuses a lookalike receiver id', () => encodeMessage({ chain: 'sandbox', vault, kind: 'near', receiver: 'bin\u0430nce.near', amount: 1n, nonce: 0n, issued: 0n, expiry: 1n }), 'not a NEAR account id');

  await expectRefused('init twice', () => root.callRaw(vault, 'init', new Uint8Array(owner.publicKey), { gas: 30n * TGAS }), 'already initialized');
  const mid = await root.createSubAccount('mid', { initialBalance: 10n * NEAR });
  const orphan = `o.${mid.accountId}`;
  await mid.batch(orphan).createAccount().transfer(3n * NEAR).deployContract(vaultWasm).transact();
  await expectRefused('init from a grandparent account', () => root.callRaw(orphan, 'init', new Uint8Array(stranger.publicKey), { gas: 30n * TGAS }), 'init must come from the parent account');
  await expectRefused('init from an unrelated account', () => relayer.callRaw(orphan, 'init', new Uint8Array(stranger.publicKey), { gas: 30n * TGAS }), 'init must come from the parent account');

  const base = async (over = {}) => {
    const now = await height();
    return { chain: 'sandbox', vault, kind: 'near', receiver: bob.accountId, amount: NEAR, nonce: 0n, issued: now, expiry: now + 600n, ...over };
  };
  const exec = (args, from = relayer) => from.callRaw(vault, 'execute', args, { gas: 100n * TGAS });
  const signed = async (over, key = owner) => { const m = encodeMessage(await base(over)); return { m, s: key.sign(m) }; };
  const resign = (m) => executeArgs(owner.sign(m), m); // owner signs bytes the SDK would refuse to build

  {
    const { m, s } = await signed({});
    const tampered = (at, value) => { const t = Buffer.from(m); t[at] = value; return executeArgs(s, t); };
    await expectRefused('tampered amount', () => exec(tampered(212 + 9, 7)), 'invalid signature');
    await expectRefused('tampered receiver', () => exec(executeArgs(s, rawId(Buffer.from(m), 147, 148, relayer.accountId))), 'invalid signature');
    await expectRefused('altered signature', () => { const t = Buffer.from(s); t[100] ^= 1; return exec(executeArgs(t, m)); }, 'invalid signature');
    await expectRefused('reserved bytes set', () => exec(tampered(255, 1)), 'reserved bytes must be zero');
  }
  await expectRefused('signed by another key', async () => { const { m, s } = await signed({}, stranger); return exec(executeArgs(s, m)); }, 'invalid signature');
  await expectRefused('other vault in the message', async () => { const { m, s } = await signed({ vault: orphan }); return exec(executeArgs(s, m)); }, 'message is for another vault');
  await expectRefused('other network in the message', async () => { const { m, s } = await signed({ chain: 'testnet' }); return exec(executeArgs(s, m)); }, 'wrong network');
  await expectRefused('expired', async () => { const now = await height(); const { m, s } = await signed({ issued: now - 10n, expiry: now }); return exec(executeArgs(s, m)); }, 'authorization expired');
  await expectRefused('validity window too long', async () => { const now = await height(); const { m, s } = await signed({ issued: now, expiry: now + MAX_TTL_BLOCKS + 1n }); return exec(executeArgs(s, m)); }, 'authorization expired');
  await expectRefused('issued in the future', async () => { const now = await height(); const { m, s } = await signed({ issued: now + 50n, expiry: now + 100n }); return exec(executeArgs(s, m)); }, 'authorization expired');
  await expectRefused('future nonce', async () => { const { m, s } = await signed({ nonce: 5n }); return exec(executeArgs(s, m)); }, 'stale or reused nonce');
  await expectRefused('amount above spendable balance', async () => { const { m, s } = await signed({ amount: 5n * NEAR }); return exec(executeArgs(s, m)); }, 'insufficient balance');
  await expectRefused('amount near 2^128 (no overflow in the balance check)', async () => { const { m, s } = await signed({ amount: (1n << 128n) - 1n }); return exec(executeArgs(s, m)); }, 'insufficient balance');
  await expectRefused('zero amount', async () => { const m = encodeMessage(await base()); m.fill(0, 212, 228); return exec(resign(m)); }, 'amount must be positive');
  await expectRefused('receiver is the vault', async () => { const { m, s } = await signed({ receiver: vault }); return exec(executeArgs(s, m)); }, 'receiver is the vault');
  await expectRefused('invalid receiver id', async () => exec(resign(rawId(encodeMessage(await base()), 147, 148, 'Bob.test.near'))), 'bad receiver account');
  await expectRefused('JSON in the receiver id', async () => exec(resign(rawId(encodeMessage(await base({ kind: 'ft', token: `ft.${root.accountId}` })), 147, 148, 'a","amount":"9'))), 'bad receiver account');
  await expectRefused('NEAR transfer with a token set', async () => exec(resign(rawId(encodeMessage(await base()), 82, 83, 'ft.ab'))), 'token set on a NEAR transfer');
  await expectRefused('NEAR transfer with ft gas set', async () => { const m = encodeMessage(await base()); m[252] = 30; return exec(resign(m)); }, 'token set on a NEAR transfer');
  await expectRefused('ft gas below 10 Tgas', async () => { const m = encodeMessage(await base({ kind: 'ft', token: `ft.${root.accountId}` })); m[252] = 5; return exec(resign(m)); }, 'bad token account or gas');

  // Nominal NEAR payment.
  const bobBefore = await total(bob);
  const pay = await signed({});
  const r = await exec(executeArgs(pay.s, pay.m));
  await settle();
  const nonceAfter = (await checkVault(provider, deployment, { vault, publicKey: owner.publicKey })).nonce;
  const callTgas = Number(r.receipts_outcomes[0].outcome.gas_burnt) / 1e12;
  record('NEAR payment: receiver gets exactly the signed amount', r.succeeded && (await total(bob)) - bobBefore === NEAR && nonceAfter === 1n, { detail: `call ${callTgas} Tgas`, call_tgas: callTgas });
  await expectRefused('replay of a spent authorization', () => exec(executeArgs(pay.s, pay.m)), 'stale or reused nonce');

  // NEP-141 payment through the recording stand-in, with the signed ft gas.
  const ft = await root.devDeploy('build/mock_ft.wasm');
  for (const amount of [123456789012345678901234567n, (1n << 128n) - 1n]) {
    await settle();
    const { nonce } = await checkVault(provider, deployment, { vault, publicKey: owner.publicKey });
    const { m, s } = await signed({ kind: 'ft', token: ft.accountId, amount, nonce, ftGasTgas: 30 });
    const fx = await exec(executeArgs(s, m));
    const last = Buffer.from((await ft.viewRaw('last')).result).toString();
    const want = `${vault}|{"receiver_id":"${bob.accountId}","amount":"${amount}"}`;
    const tg = Number(fx.receipts_outcomes[0].outcome.gas_burnt) / 1e12;
    record(`NEP-141 payment ${amount}: exact ft_transfer call with 1 yocto`, fx.succeeded && last === want, { detail: last === want ? `call ${tg} Tgas` : last, call_tgas: tg });
  }

  // A payment to an account that does not exist: the transfer fails, the NEAR comes back, the nonce stays spent.
  {
    await settle();
    const before = await total(root.getAccount(vault));
    const { nonce } = await checkVault(provider, deployment, { vault, publicKey: owner.publicKey });
    const { m, s } = await signed({ receiver: `ghost.${root.accountId}`, nonce });
    await exec(executeArgs(s, m));
    await settle();
    const after = await total(root.getAccount(vault));
    const n2 = (await checkVault(provider, deployment, { vault, publicKey: owner.publicKey })).nonce;
    record('failed delivery refunds the vault and keeps the nonce spent', after >= before && n2 === nonce + 1n, { detail: `balance delta ${after - before} yocto` });
  }

  writeFileSync('evidence/vault-sandbox.json', JSON.stringify({
    sandbox: 'near-sandbox 2.6.2 (nearcore)', deployment,
    passed: results.filter((x) => x.ok).length, total: results.length, results,
  }, null, 2) + '\n');
  console.log(`${results.length - failures}/${results.length} passed`);
  process.exitCode = failures ? 1 : 0;
} finally {
  await worker.tearDown();
  rmSync(keys, { recursive: true, force: true });
}
