// Differential message vectors shared by the relayer and the wallet parser: every vector must be accepted or
// refused by both. `node tests/relayer-vectors.mjs --write` rebuilds relayer/vectors/messages.json;
// `WALLET_PARSER=<path to the wallet's near-vault.ts> node tests/relayer-vectors.mjs` runs both parsers on it.
import { readFileSync, writeFileSync } from 'node:fs';
import { SIG_LEN, encodeMessage } from '../sdk/vault.mjs';
import { parseRequest } from '../relayer/message.mjs';

const FILE = new URL('../relayer/vectors/messages.json', import.meta.url);
const deployment = JSON.parse(readFileSync(new URL('../deployments/testnet.json', import.meta.url), 'utf8'));

function build() {
  const vault = `1decab283ca92482.${deployment.factory}`;
  const base = { chain: 'testnet', vault, kind: 'near', receiver: 'alice.testnet', amount: 10n ** 22n, nonce: 3n, issued: 1000n, expiry: 1600n };
  const near = (over = {}) => encodeMessage({ ...base, ...over });
  const ft = (over = {}) => encodeMessage({ ...base, kind: 'ft', token: 'wrap.testnet', ftGasTgas: 30, ...over });
  const edit = (m, f) => { const c = Buffer.from(m); f(c); return c; };
  const withToken = (m, id) => edit(m, (c) => { c[82] = id.length; c.write(id, 83, 'ascii'); });
  const v = [
    ['NEAR transfer', near(), true],
    ['ft_transfer', ft(), true],
    ['ft gas 10', ft({ ftGasTgas: 10 }), true],
    ['ft gas 100', ft({ ftGasTgas: 100 }), true],
    ['largest amount', near({ amount: (1n << 128n) - 1n }), true],
    ['window of 1800 blocks', near({ issued: 1000n, expiry: 2800n }), true],
    ['NEAR transfer naming a token', withToken(near(), 'wrap.testnet'), false],
    ['NEAR transfer with a token length only', edit(near(), (c) => { c[82] = 12; }), false],
    ['NEAR transfer with token bytes only', edit(near(), (c) => { c[100] = 1; }), false],
    ['NEAR transfer naming a token and its gas', edit(withToken(near(), 'wrap.testnet'), (c) => { c[252] = 30; }), false],
    ['NEAR transfer with a gas byte', edit(near(), (c) => { c[252] = 30; }), false],
    ['ft_transfer without a token', edit(ft(), (c) => { c.fill(0, 82, 147); }), false],
    ['ft gas 9', edit(ft(), (c) => { c[252] = 9; }), false],
    ['ft gas 101', edit(ft(), (c) => { c[252] = 101; }), false],
    ['ft gas 0', edit(ft(), (c) => { c[252] = 0; }), false],
    ['unknown action', edit(near(), (c) => { c[81] = 2; }), false],
    ['reserved byte', edit(near(), (c) => { c[255] = 1; }), false],
    ['bad magic', edit(near(), (c) => { c[0] = 0x41; }), false],
    ['zero amount', edit(near(), (c) => { c.fill(0, 212, 228); }), false],
    ['exhausted nonce', near({ nonce: (1n << 64n) - 1n }), false],
    ['empty window', near({ issued: 1000n, expiry: 1000n }), false],
    ['window of 1801 blocks', near({ issued: 1000n, expiry: 2801n }), false],
    ['receiver is the vault', near({ receiver: vault }), false],
    ['uppercase receiver', edit(near(), (c) => { c[148] = 0x41; }), false],
    ['receiver padding not zero', edit(near(), (c) => { c[148 + 63] = 1; }), false],
    ['one-character token', withToken(edit(ft(), (c) => c.fill(0, 82, 147)), 'w'), false],
    ['token padding not zero', edit(ft(), (c) => { c[83 + 63] = 1; }), false],
    ['vault of another factory', near({ vault: '1decab283ca92482.other.testnet' }), false],
    ['vault is a grandchild', near({ vault: `ab.cd.${deployment.factory}` }), false],
    ['mainnet tag', near({ chain: 'mainnet' }), false],
  ];
  return { factory: deployment.factory, network: deployment.network, vectors: v.map(([name, m, accept]) => ({ name, message: m.toString('hex'), accept })) };
}

const relayerAccepts = (hex) => {
  try { parseRequest(Buffer.concat([Buffer.alloc(SIG_LEN), Buffer.from(hex, 'hex')]), deployment); return true; } catch { return false; }
};

if (process.argv.includes('--write')) {
  writeFileSync(FILE, JSON.stringify(build(), null, 2) + '\n');
  console.log(`wrote ${FILE.pathname}`);
} else {
  const { vectors } = JSON.parse(readFileSync(FILE, 'utf8'));
  const wallet = process.env.WALLET_PARSER ? await import(process.env.WALLET_PARSER) : null;
  let fails = 0;
  for (const { name, message, accept } of vectors) {
    const r = relayerAccepts(message);
    let w = null;
    if (wallet) { try { wallet.parseNearVaultAuthorization(`0x${message}`); w = true; } catch { w = false; } }
    const ok = r === accept && (w === null || w === accept);
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: expected ${accept ? 'accept' : 'refuse'}, relayer ${r ? 'accepts' : 'refuses'}${w === null ? '' : `, wallet ${w ? 'accepts' : 'refuses'}`}`);
  }
  console.log(`${vectors.length - fails}/${vectors.length} agree${wallet ? ' (relayer and wallet)' : ' (relayer only; set WALLET_PARSER to compare)'}`);
  process.exitCode = fails ? 1 : 0;
}
