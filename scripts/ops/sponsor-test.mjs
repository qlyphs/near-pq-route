import { generateSigner } from '@fastnear/ml-dsa-65';
import { accountFor } from '/Users/yacinealloul/qlyphs-pq87-near/sdk/route-crypto.mjs';
const s = generateSigner();
const r = await fetch('https://qlyphs-pq-route.qlyphs.workers.dev/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: s.publicKey }) });
const j = await r.json();
console.log(r.status, j, 'expected', accountFor(s.publicKey, 'qlyphs-pqroute-c.testnet'));
s.destroy();
