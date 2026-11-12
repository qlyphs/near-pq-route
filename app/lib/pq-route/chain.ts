/** Reads on the curve test chain and the ML-DSA-65 withdrawal on NEAR testnet, for the post-quantum route. */
import { blake2b } from '@noble/hashes/blake2.js';
import { actions, sendTx } from '@fastnear/api';
import { ROUTE } from './route';
import type { Signer65 } from './crypto.js';

const QUANTUS_RPC = 'https://testnet-rpc.qlyphs.com';
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(QUANTUS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`Quantus test chain: ${j.error.message ?? 'RPC error'}`);
  return j.result as T;
}
const bytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Where a transaction landed: its block hash and position, found by hashing the extrinsics of recent blocks
 * (blake2-256, the chain's transaction hash). Null while it is not in the last `depth` blocks.
 */
export async function findInclusion(txHash: string, depth = 40): Promise<{ blockHash: string; index: number; number: number } | null> {
  const head = await rpc<{ number: string }>('chain_getHeader');
  const top = parseInt(head.number, 16);
  for (let n = top; n > top - depth && n >= 0; n--) {
    const blockHash = await rpc<string>('chain_getBlockHash', [n]);
    const block = await rpc<{ block: { extrinsics: string[] } }>('chain_getBlock', [blockHash]);
    const i = block.block.extrinsics.findIndex((x) => toHex(blake2b(bytes(x), { dkLen: 32 })) === txHash.toLowerCase());
    if (i >= 0) return { blockHash, index: i, number: n };
  }
  return null;
}
/** The number of a Quantus block, from its hash (for counting confirmations on screen). */
export async function blockNumberOf(blockHash: string): Promise<number> {
  const h = await rpc<{ number: string }>('chain_getHeader', [blockHash]);
  return parseInt(h.number, 16);
}

export async function bestNumber(): Promise<number> {
  return parseInt((await rpc<{ number: string }>('chain_getHeader')).number, 16);
}

/** Tokens the verifier refused stay on the account's own token balance: this burns them to a Quantus account. */
export async function redeemDirect(signer: Signer65, accountId: string, amount: string, quantusAccountHex: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(quantusAccountHex)) throw new Error('Not a Quantus account id');
  const r = await sendTx({
    signerId: accountId, signer: signer as never, receiverId: ROUTE.bridge, network: 'testnet', waitUntil: 'FINAL',
    actions: [actions.functionCall({ methodName: 'redeem', args: { amount, quantus_to: quantusAccountHex }, gas: '30 Tgas', deposit: '1' })],
  });
  const failure = JSON.stringify(r).match(/"ExecutionError":"([^"]+)"/)?.[1];
  if (failure) throw new Error(`NEAR testnet refused the withdrawal: ${failure}`);
  return (r as { result?: { transaction?: { hash?: string } } })?.result?.transaction?.hash ?? '';
}

/** The fresh account withdraws from NEAR Intents to a Quantus account; the transaction is signed with ML-DSA-65. */
export async function withdrawToQuantus(signer: Signer65, accountId: string, amount: string, quantusAccountHex: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(quantusAccountHex)) throw new Error('Not a Quantus account id');
  const r = await sendTx({
    signerId: accountId, signer: signer as never, receiverId: ROUTE.verifier, network: 'testnet', waitUntil: 'FINAL',
    actions: [actions.functionCall({ methodName: 'ft_withdraw', args: { token: ROUTE.bridge, receiver_id: ROUTE.bridge, amount, memo: `WITHDRAW_TO:${quantusAccountHex}` }, gas: '100 Tgas', deposit: '1' })],
  });
  const s = JSON.stringify(r);
  const failure = s.match(/"ExecutionError":"([^"]+)"/)?.[1];
  if (failure) throw new Error(`NEAR testnet refused the withdrawal: ${failure}`);
  return (r as { result?: { transaction?: { hash?: string } } })?.result?.transaction?.hash ?? '';
}
