'use client';
/** The visitor's NEAR wallet, through NEAR Wallet Selector, for the two calls the vault page asks of
 * it: the factory's `create` and a token's `storage_deposit`. Loaded only when the page needs it. */
import type { WalletSelector } from '@near-wallet-selector/core';

export interface NearWalletChoice {
  id: string;
  name: string;
}

let selector: Promise<WalletSelector> | null = null;

/** What the vault page asks of a NEAR wallet, as one object a development fixture can stand in for. */
export interface NearWalletStandIn {
  choices(): Promise<NearWalletChoice[]>;
  signedIn(): Promise<{ wallet: string; account: string } | null>;
  signIn(id: string): Promise<string>;
  signOut(): Promise<void>;
  call(call: NearCall): Promise<string | null>;
}
let standIn: NearWalletStandIn | null = null;
/** Development builds only (lib/vault-fixture.tsx); ignored anywhere else. */
export function setNearWalletStandIn(next: NearWalletStandIn | null): void {
  if (process.env.NODE_ENV === 'development') standIn = next;
}

/** Testnet only. The wallets offered are candidates, not a compatibility claim (vault-create.ts). */
export function nearSelector(): Promise<WalletSelector> {
  selector ??= (async () => {
    const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }, { setupIntearWallet }] = await Promise.all([
      import('@near-wallet-selector/core'),
      import('@near-wallet-selector/my-near-wallet'),
      import('@near-wallet-selector/meteor-wallet'),
      import('@near-wallet-selector/intear-wallet'),
    ]);
    return setupWalletSelector({ network: 'testnet', modules: [setupMyNearWallet(), setupMeteorWallet(), setupIntearWallet()] });
  })();
  selector.catch(() => {
    selector = null;
  });
  return selector;
}

export async function nearWalletChoices(): Promise<NearWalletChoice[]> {
  if (standIn) return standIn.choices();
  const s = await nearSelector();
  return s.store.getState().modules.map((m) => ({ id: m.id, name: m.metadata.name }));
}

/** The NEAR account signed in with the selector, if any. */
export async function nearSignedIn(): Promise<{ wallet: string; account: string } | null> {
  if (standIn) return standIn.signedIn();
  const s = await nearSelector();
  const state = s.store.getState();
  const account = state.accounts.find((a) => a.active) ?? state.accounts[0];
  return account && state.selectedWalletId ? { wallet: state.selectedWalletId, account: account.accountId } : null;
}

export async function nearSignIn(id: string): Promise<string> {
  if (standIn) return standIn.signIn(id);
  const s = await nearSelector();
  const wallet = await s.wallet(id);
  // No contract or methods: the page asks for no function-call key, only the account to sign with.
  const signIn = wallet.signIn.bind(wallet) as (params: object) => Promise<{ accountId: string }[]>;
  const accounts = await signIn({});
  const first = accounts[0]?.accountId;
  if (!first) throw new Error('The NEAR wallet did not name an account.');
  return first;
}

/** Every account the signed-in wallet shared, and the one in use. */
export async function nearAccounts(): Promise<{ accounts: string[]; active: string | null }> {
  if (standIn) { const a = await standIn.signedIn(); return { accounts: a ? [a.account] : [], active: a?.account ?? null }; }
  const state = (await nearSelector()).store.getState();
  const active = state.accounts.find((a) => a.active) ?? state.accounts[0];
  return { accounts: state.accounts.map((a) => a.accountId), active: active?.accountId ?? null };
}

/** Makes `account`, one the wallet already shared, the one that signs. */
export async function nearUseAccount(account: string): Promise<void> {
  if (standIn) return;
  const s = await nearSelector();
  if (!s.store.getState().accounts.some((a) => a.accountId === account)) throw new Error(`The NEAR wallet did not share ${account}`);
  s.setActiveAccount(account);
}

export async function nearSignOut(): Promise<void> {
  if (standIn) return standIn.signOut();
  const s = await nearSelector();
  if (s.isSignedIn()) await (await s.wallet()).signOut();
}

export interface NearCall {
  receiverId: string;
  methodName: string;
  /** Raw bytes are sent as they are; anything else as JSON. */
  args: Uint8Array | object;
  gas: bigint;
  deposit: bigint;
}

/**
 * Asks the NEAR wallet to sign and send one function call. Resolves with the transaction hash when the
 * wallet returns one, or null when it leaves the page or answers without one: then the call counts as
 * sent, not done, and the page reads the chain to learn what happened.
 */
export async function nearCall(call: NearCall): Promise<string | null> {
  if (standIn) return standIn.call(call);
  const s = await nearSelector();
  const { actionCreators } = await import('@near-wallet-selector/core');
  const wallet = await s.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: call.receiverId,
    actions: [actionCreators.functionCall(call.methodName, call.args, call.gas, call.deposit)],
  });
  const hash = (outcome as { transaction?: { hash?: unknown } } | void)?.transaction?.hash;
  return typeof hash === 'string' ? hash : null;
}

/**
 * Asks the NEAR wallet to remove `keys` from the signed-in `account`, in one transaction to itself. Only ed25519
 * and secp256k1 keys are accepted: this never removes a post-quantum key. Same answer as nearCall.
 */
export async function nearDeleteKeys(account: string, keys: string[]): Promise<string | null> {
  if (!keys.length) throw new Error('No key to remove');
  if (keys.some((k) => !/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(k))) throw new Error('Only classical keys can be removed here');
  const s = await nearSelector();
  const [{ actionCreators }, { PublicKey }] = await Promise.all([import('@near-wallet-selector/core'), import('@near-js/crypto')]);
  const wallet = await s.wallet();
  const outcome = await wallet.signAndSendTransaction({ signerId: account, receiverId: account, actions: keys.map((k) => actionCreators.deleteKey(PublicKey.from(k))) });
  const hash = (outcome as { transaction?: { hash?: unknown } } | void)?.transaction?.hash;
  return typeof hash === 'string' ? hash : null;
}
