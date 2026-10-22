// Client side of the NEAR vault: the 256-byte signed message and a local ML-DSA-87 test signer (OpenSSL >= 3.5).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CONTEXT = Buffer.from('qlyphs/near-vault/v1');
export const PK_LEN = 2592;
export const SIG_LEN = 4627;
export const MSG_LEN = 256;
export const MAX_TTL_BLOCKS = 1800n;
// SubjectPublicKeyInfo prefix for id-ml-dsa-87 (2.16.840.1.101.3.4.3.19).
const SPKI_PREFIX = Buffer.from('30820a32300b060960864801650304031303820a2100', 'hex');
// The ESM build of @near-js/utils has broken relative imports; its CommonJS build works.
const { baseDecode } = createRequire(import.meta.url)('@near-js/utils');
const OPENSSL = process.env.OPENSSL ?? 'openssl';

function openssl(args) {
  return execFileSync(OPENSSL, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
}

// NEAR account id grammar. Checked before encoding: Buffer's 'ascii' keeps only the low byte of each
// character, so a lookalike such as a Cyrillic 'а' would otherwise become a different, valid id.
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;
export const isAccountId = (id) => typeof id === 'string' && ACCOUNT_ID.test(id);

function idField(out, lenAt, at, id) {
  if (!isAccountId(id)) throw new Error(`not a NEAR account id: ${JSON.stringify(id)}`);
  out[lenAt] = id.length;
  out.write(id, at, 'ascii');
}

/** Encodes the message the vault checks (docs/PROTOCOL.md). amount, nonce and heights are bigints. */
export function encodeMessage({ chain, vault, kind, token, receiver, amount, nonce, issued, expiry, ftGasTgas = 30 }) {
  const m = Buffer.alloc(MSG_LEN);
  m.write('QLYP87N1', 0, 'ascii');
  if (!/^[a-z]{1,8}$/.test(chain)) throw new Error('chain tag is 1 to 8 lowercase letters');
  m.write(chain, 8, 'ascii');
  idField(m, 16, 17, vault);
  if (kind !== 'near' && kind !== 'ft') throw new Error('kind is near or ft');
  m[81] = kind === 'ft' ? 1 : 0;
  if (kind === 'ft') {
    idField(m, 82, 83, token);
    if (!Number.isInteger(ftGasTgas) || ftGasTgas < 10 || ftGasTgas > 100) throw new Error('ft gas is 10 to 100 Tgas');
    m[252] = ftGasTgas;
  }
  idField(m, 147, 148, receiver);
  if (typeof amount !== 'bigint' || amount <= 0n || amount >= 1n << 128n) throw new Error('amount is a positive u128 bigint');
  m.writeBigUInt64LE(amount & 0xffffffffffffffffn, 212);
  m.writeBigUInt64LE(amount >> 64n, 220);
  m.writeBigUInt64LE(nonce, 228);
  m.writeBigUInt64LE(expiry, 236);
  m.writeBigUInt64LE(issued, 244);
  return m;
}

/** A local ML-DSA-87 key file. Test signer only: the Qlyphs wallet is the intended signer. */
export class Key {
  constructor(path) {
    this.path = path;
    const der = openssl(['pkey', '-in', path, '-pubout', '-outform', 'DER']);
    if (der.length !== SPKI_PREFIX.length + PK_LEN || !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
      throw new Error('expected a canonical ML-DSA-87 public key');
    }
    this.publicKey = der.subarray(SPKI_PREFIX.length);
  }

  static generate(path) {
    closeSync(openSync(path, 'wx', 0o600)); // never overwrite an existing key
    openssl(['genpkey', '-algorithm', 'ML-DSA-87', '-out', path]);
    return new Key(path);
  }

  sign(message, context = CONTEXT) {
    const dir = mkdtempSync(join(tmpdir(), 'qvault-near-'));
    try {
      writeFileSync(join(dir, 'm'), message);
      openssl(['pkeyutl', '-sign', '-rawin', '-inkey', this.path, '-in', join(dir, 'm'), '-out', join(dir, 's'),
        '-pkeyopt', `hexcontext-string:${context.toString('hex')}`]);
      const sig = readFileSync(join(dir, 's'));
      if (sig.length !== SIG_LEN) throw new Error('unexpected signature length');
      return sig;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** execute() input: signature followed by the message. */
export const executeArgs = (sig, msg) => new Uint8Array(Buffer.concat([sig, msg]));

/** The vault address the factory derives from a key: hex of the first 8 bytes of SHA-256(pk), under the factory. */
export const vaultAddress = (publicKey, factory) => `${createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}.${factory}`;

/**
 * Wallet-side checks before signing for a vault, all read at one final block of a node the wallet trusts.
 * `deployment` is the pinned release manifest (deployments/<network>.json). A vault is trusted only if:
 * it is the address the pinned factory derives from the owner's key; the factory runs the pinned code,
 * has no access key, deploys the pinned vault code and holds a completed registry record for this key;
 * the vault runs that code, has no access key, and its storage is exactly the owner's key and a usable
 * nonce. Throws on the first mismatch, returns the nonce to sign with.
 * Creation history is not visible in state. The registry record proves this incarnation of the factory
 * created the vault; the factory's own creation is audited once per release (auditFactoryCreation).
 */
export async function checkVault(provider, deployment, { vault, publicKey }) {
  const { network, factory, factory_sha256: factorySha, vault_sha256: vaultSha } = deployment;
  if (Buffer.from(publicKey).length !== PK_LEN) throw new Error('expected a 2592-byte ML-DSA-87 public key');
  if (vault !== vaultAddress(publicKey, factory)) throw new Error(`${vault} is not the pinned factory's address for this key`);
  const block = (await provider.block({ finality: 'final' })).header.hash;
  const q = (request) => provider.query({ ...request, block_id: block });
  const codeHex = (a) => Buffer.from(baseDecode(a.code_hash)).toString('hex');
  const noKeys = async (id) => {
    const { keys } = await q({ request_type: 'view_access_key_list', account_id: id });
    if (keys.length) throw new Error(`${id} has ${keys.length} access key(s)`);
  };
  const call = async (id, method) => JSON.parse(Buffer.from((await q({ request_type: 'call_function', account_id: id, method_name: method, args_base64: '' })).result).toString());

  if (codeHex(await q({ request_type: 'view_account', account_id: factory })) !== factorySha) throw new Error('factory code is not the pinned release');
  await noKeys(factory);
  const fstate = await call(factory, 'state');
  if (fstate.version !== 'qlyphs/near-vault-factory/v1' || fstate.chain !== network || fstate.vault_sha256 !== vaultSha) throw new Error('factory does not deploy the pinned vault');
  const rkey = Buffer.from(`r${vault.slice(0, 16)}`);
  const { values: reg } = await q({ request_type: 'view_state', account_id: factory, prefix_base64: rkey.toString('base64') });
  const record = reg.find((v) => Buffer.from(v.key, 'base64').equals(rkey));
  const want = Buffer.concat([createHash('sha256').update(publicKey).digest(), Buffer.from('C')]);
  if (!record || !Buffer.from(record.value, 'base64').equals(want)) throw new Error(`${vault} is not in the factory registry as created for this key`);

  const account = await q({ request_type: 'view_account', account_id: vault });
  if (codeHex(account) !== vaultSha) throw new Error('vault code is not the pinned release');
  await noKeys(vault);
  const { values } = await q({ request_type: 'view_state', account_id: vault, prefix_base64: '' });
  const store = Object.fromEntries(values.map((v) => [Buffer.from(v.key, 'base64').toString('latin1'), Buffer.from(v.value, 'base64')]));
  const names = Object.keys(store).sort().join(',');
  if (names !== 'k,n' || store.n.length !== 8) throw new Error(`unexpected vault storage: ${names}`);
  if (store.k.length !== PK_LEN || !store.k.equals(Buffer.from(publicKey))) throw new Error('vault is bound to another ML-DSA-87 key');
  if (store.n.readBigUInt64LE(0) === 0xffffffffffffffffn) throw new Error('vault nonce is exhausted: it can never pay');
  const vstate = await call(vault, 'state');
  if (vstate.version !== CONTEXT.toString() || vstate.chain !== network) throw new Error('vault serves another network or version');
  return { block, nonce: store.n.readBigUInt64LE(0), balance: BigInt(account.amount) };
}

/**
 * One-time release audit of the factory account's creation transaction: the factory must have been
 * created by one batch of CreateAccount, Transfer and DeployContract only. With no FunctionCall in it,
 * no code ran before the factory's own, so nothing could have scheduled a later AddKey.
 */
export async function auditFactoryCreation(provider, { txHash, sender, factory }) {
  const r = await provider.sendJsonRpc('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' });
  if (r.transaction.receiver_id !== factory) throw new Error('transaction does not target the factory');
  const kinds = r.transaction.actions.map((a) => (typeof a === 'string' ? a : Object.keys(a)[0]));
  if (kinds.join(',') !== 'CreateAccount,Transfer,DeployContract') throw new Error(`factory creation actions: ${kinds.join(',')}`);
  for (const o of r.receipts_outcome) {
    if (!('SuccessValue' in o.outcome.status) && !('SuccessReceiptId' in o.outcome.status)) throw new Error(`receipt ${o.id} did not succeed`);
  }
  return { actions: kinds, receipts: r.receipts_outcome.length };
}
