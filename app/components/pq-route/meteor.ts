'use client';
/** A NEAR account held in Meteor Wallet (testnet), as a place the route delivers to and brings back from. The route
 * delivers to it only if, at a finalized block, its keys are exactly one ML-DSA-65 full-access key: the configuration
 * this demo supports. That is a snapshot; the holder can change keys later. This browser's backup cannot restore the
 * account: Meteor holds its key. */
import * as React from 'react';
import { nearAccounts, nearCall, nearDeleteKeys, nearSignIn, nearSignOut, nearSignedIn, nearUseAccount } from '@/lib/near-wallet';
import { ROUTE, directBalance, intentsBalance, postQuantumKey, receiverProblem, type KeyFix } from '@/lib/pq-route/route';

const METEOR = 'meteor-wallet';

export interface MeteorState {
  account: string | null;
  /** Every account Meteor shared with this page: the person picks which one receives. */
  accounts: string[];
  /** The handle of its only key, when the route may deliver to it. */
  handle: string | null;
  /** Why it may not, said for the person who holds it. */
  problem: string;
  /** What the holder can do about it, when they can. */
  fix: KeyFix | null;
  /** Removing the classical keys: waiting for Meteor. */
  fixing: boolean;
  /** The finalized block at which its keys were read. */
  block: number | null;
  /** Its QTC inside NEAR Intents, and on its own bridge-token balance (when Intents refused a deposit). */
  inside: bigint;
  direct: bigint;
  checking: boolean;
  connecting: boolean;
}

/** `enabled` false: nothing is loaded or read (the Meteor option is not offered). */
export function useMeteor(enabled: boolean) {
  const [s, setS] = React.useState<MeteorState>(EMPTY);
  const check = React.useCallback(async (account: string) => {
    setS((x) => ({ ...x, account, handle: null, block: null, fix: null, problem: '', checking: true }));
    void nearAccounts().then(({ accounts }) => setS((x) => ({ ...x, accounts }))).catch(() => {});
    try {
      const inside = BigInt(await intentsBalance(account).catch(() => '0'));
      const direct = BigInt(await directBalance(account).catch(() => '0'));
      const k = await postQuantumKey(account);
      const problem = 'problem' in k ? k.problem : (await receiverProblem(account, k.handle)) ?? '';
      setS((x) => ({ ...x, handle: 'handle' in k && !problem ? k.handle : null, block: 'block' in k ? k.block : null, problem: problem ? sentence(problem) : '', fix: 'fix' in k ? k.fix ?? null : null, inside, direct, checking: false }));
    } catch (e) { setS((x) => ({ ...x, handle: null, fix: null, problem: (e as Error).message, checking: false })); }
  }, []);
  React.useEffect(() => {
    if (!enabled) return;
    void nearSignedIn().then((a) => { if (a?.wallet === METEOR) void check(a.account); }).catch(() => {});
  }, [check, enabled]);

  async function connect() {
    setS((x) => ({ ...x, connecting: true, problem: '' }));
    try { await check(await nearSignIn(METEOR)); }
    catch (e) { setS((x) => ({ ...x, problem: `Meteor Wallet: ${(e as Error).message || 'the connection was closed'}` })); }
    finally { setS((x) => ({ ...x, connecting: false })); }
  }
  /** Another account Meteor already shared: it becomes the one that signs and receives. */
  async function choose(account: string) {
    if (account === s.account) return;
    try { await nearUseAccount(account); await check(account); }
    catch (e) { setS((x) => ({ ...x, problem: `Meteor Wallet: ${(e as Error).message}` })); }
  }
  /** Signs out and asks Meteor again, so the person can pick (or create) any of its accounts. */
  async function switchAccount() {
    await nearSignOut().catch(() => {});
    setS(EMPTY);
    await connect();
  }
  async function disconnect() {
    await nearSignOut().catch(() => {});
    setS(EMPTY);
  }
  /** Asks Meteor to remove the classical keys left on the connected account, once it already holds its one ML-DSA-65
   * key. The keys are read again first: only what is classical at this moment is removed, never the ML-DSA-65 key. */
  async function removeClassicalKeys() {
    const account = s.account;
    if (!account) return;
    setS((x) => ({ ...x, fixing: true, problem: '' }));
    try {
      const now = await nearSignedIn();
      if (now?.wallet !== METEOR || now.account !== account) throw new Error(`Meteor Wallet: connect ${account} again, it is no longer the connected account`);
      const k = await postQuantumKey(account);
      if ('fix' in k && k.fix?.kind === 'remove') await nearDeleteKeys(account, k.fix.keys);
      await check(account);
    } catch (e) { setS((x) => ({ ...x, problem: `Meteor Wallet: ${(e as Error).message || 'the request was closed'}` })); }
    finally { setS((x) => ({ ...x, fixing: false })); }
  }
  /** Asks Meteor to send the QTC of `account` back to the Quantus account `quantusHex`: from NEAR Intents
   * (ft_withdraw on the verifier) or, for a deposit Intents refused, from its own bridge-token balance (redeem on
   * the bridge). Meteor must still be connected to that same account: it is never swapped for another one. Resolves
   * with the transaction hash, or '' when Meteor answered without one (then the chain says what happened). */
  async function withdraw(account: string, from: 'inside' | 'direct', amount: bigint, quantusHex: string): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(quantusHex)) throw new Error('Not a Quantus account id');
    const now = await nearSignedIn();
    if (now?.wallet !== METEOR || now.account !== account) throw new Error(`Meteor Wallet: connect ${account} again, it is no longer the connected account`);
    const hash = from === 'inside'
      ? await nearCall({ receiverId: ROUTE.verifier, methodName: 'ft_withdraw', gas: 100_000_000_000_000n, deposit: 1n,
          args: { token: ROUTE.bridge, receiver_id: ROUTE.bridge, amount: String(amount), memo: `WITHDRAW_TO:${quantusHex}` } })
      : await nearCall({ receiverId: ROUTE.bridge, methodName: 'redeem', gas: 30_000_000_000_000n, deposit: 1n,
          args: { amount: String(amount), quantus_to: quantusHex } });
    return hash ?? '';
  }
  return { ...s, connect, disconnect, choose, switchAccount, removeClassicalKeys, recheck: () => (s.account ? check(s.account) : Promise.resolve()), withdraw };
}
export type Meteor = ReturnType<typeof useMeteor>;
const EMPTY: MeteorState = { account: null, accounts: [], handle: null, problem: '', fix: null, fixing: false, block: null, inside: 0n, direct: 0n, checking: false, connecting: false };

/** receiverProblem speaks of "the recipient"; here the person is the recipient. */
function sentence(why: string): string {
  const s = why.replace(/the recipient's account/g, 'this account').replace(/for the recipient/g, 'for this account').replace(/the recipient/g, 'this account');
  return s.charAt(0).toUpperCase() + s.slice(1) + (s.endsWith('.') ? '' : '.');
}
