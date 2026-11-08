import { KeyPair } from 'near-api-js';
import { writeFileSync, existsSync } from 'node:fs';
const name = process.argv[2];
const dir = process.env.HOME + '/.qlyphs/near-testnet/';
const kp = KeyPair.fromRandom('ed25519');
const r = await fetch('https://helper.testnet.near.org/account', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: name, newAccountPublicKey: kp.getPublicKey().toString() }) });
const t = await r.text();
console.log(r.status, t.slice(0, 200));
if (r.ok) { const f = dir + name.replace('.testnet', '') + '.key'; if (existsSync(f)) throw Error('exists'); writeFileSync(f, kp.toString(), { mode: 0o600 }); writeFileSync(dir + name.replace('.testnet', '') + '.account', name + '\n'); console.log('saved', f); }
