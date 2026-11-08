// Live attacks on the testnet bridge, sent by the relayer (ML-DSA-65): replay a real mint, change its amount, its
// receiver, its mode, reuse one attester twice. Every one must be refused by the contract. Read-only otherwise.
import { readFileSync } from 'node:fs';
import { actions, sendTx } from '@fastnear/api';
import { signerFromSeed } from '@fastnear/ml-dsa-65';

const RPC = 'https://archival-rpc.testnet.fastnear.com';
const route = JSON.parse(readFileSync('deployments/route-curve-testnet.json', 'utf8'));
const txs = JSON.parse(readFileSync('evidence/route-transactions.json', 'utf8'))[route.bridge.account].filter((t) => t.methods.includes('mint'));
const tx = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: txs[0].hash, sender_account_id: txs[0].signer, wait_until: 'NONE' } }) })).json()).result;
const real = Buffer.from(tx.transaction.actions[0].FunctionCall.args, 'base64');
const relay = signerFromSeed(Buffer.from(readFileSync(process.env.HOME + '/.qlyphs/near-testnet/pqroute-relay.seed', 'utf8').trim(), 'hex'));
const mint = async (input) => {
  const r = await sendTx({ signerId: route.relayer.account, signer: relay, receiverId: route.bridge.account, network: 'testnet', waitUntil: 'FINAL',
    actions: [actions.functionCall({ methodName: 'mint', argsBase64: input.toString('base64'), gas: '300 Tgas', deposit: '0' })] });
  return { hash: r?.result?.transaction?.hash, error: JSON.stringify(r).match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? null };
};
// A fresh deposit id, so the contract reaches the signature checks instead of stopping at "already minted".
const fresh = (edit) => { const b = Buffer.from(real); b[113] ^= 0xff; edit?.(b); return b; };
const variants = [
  ['replay of a real mint', Buffer.from(real), 'deposit already minted'],
  ['replay with the amount changed', (() => { const b = Buffer.from(real); b[145] ^= 1; return b; })(), 'deposit already minted'],
  ['real signatures on another deposit id', fresh(), 'invalid attestation signature'],
  ['another deposit id and the amount doubled', fresh((b) => { b[150] ^= 1; }), 'invalid attestation signature'],
  ['another deposit id and another receiver', fresh((b) => { b[162] = b[162] === 0x72 ? 0x73 : 0x72; }), 'invalid attestation signature'],
  ['another deposit id, credited directly instead of into Intents', fresh((b) => { b[258] = 0; }), 'invalid attestation signature'],
  ['one attester twice', (() => { const b = Buffer.from(real); b.copy(b, 289 + 4627, 288, 289 + 4627); return b; })(), 'two different attesters'],
];
const out = [];
let failed = 0;
for (const [name, input, expect] of variants) {
  const r = await mint(input);
  const ok = r.error?.includes(expect);
  if (!ok) failed++;
  out.push({ attack: name, refused_with: r.error, tx: r.hash, ok });
  console.log(`${ok ? 'REFUSED' : 'UNEXPECTED'} ${name}: ${r.error ?? 'accepted'} (${r.hash})`);
}
relay.destroy();
console.log(JSON.stringify(out));
process.exit(failed ? 1 : 0);
