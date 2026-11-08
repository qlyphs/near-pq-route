// Testnet spike: a fresh named account whose only key is ML-DSA-65, then a transfer it signs itself.
import { readFileSync } from 'node:fs';
import { actions, sendTx, queryAccessKeyList, queryProtocolVersion } from '@fastnear/api';
import { signerFromPrivateKey } from '@fastnear/utils';
import { generateSigner } from '@fastnear/ml-dsa-65';
const home = process.env.HOME + '/.qlyphs/near-testnet/';
const parent = readFileSync(home + 'parent.account', 'utf8').trim();
const classical = signerFromPrivateKey(readFileSync(home + 'parent.key', 'utf8').trim());
console.log('protocol', await queryProtocolVersion({ network: 'testnet' }));
const pq = generateSigner();
const id = `pq65-${Date.now().toString(36)}.${parent}`;
try {
  const c = await sendTx({ signerId: parent, signer: classical, receiverId: id, network: 'testnet', waitUntil: 'FINAL',
    actions: [actions.createAccount(), actions.transfer('100000000000000000000000'), actions.addFullAccessKey({ publicKey: pq.publicKey })] });
  console.log('created', id, c?.transaction?.hash ?? c?.result?.transaction?.hash ?? '');
  const keys = await queryAccessKeyList({ accountId: id, blockId: 'final', network: 'testnet' });
  console.log('keys', keys.result.keys.map((k) => k.public_key.slice(0, 24) + '… ' + (typeof k.access_key.permission === 'string' ? k.access_key.permission : 'FunctionCall')));
  const t = await sendTx({ signerId: id, signer: pq, receiverId: parent, network: 'testnet', waitUntil: 'FINAL', actions: [actions.transfer('1000000000000000000000')] });
  console.log('ml-dsa-65 signed transfer', JSON.stringify(t).match(/"hash":"([^"]+)"/)?.[1], JSON.stringify(t).includes('SuccessValue') ? 'SUCCESS' : JSON.stringify(t).slice(0, 300));
} finally { pq.destroy(); }
