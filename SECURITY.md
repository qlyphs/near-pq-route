# Security model and limits

Research proof of concept. Not audited. Never use it with real funds.

## What the contract enforces

- Funds leave a vault only after the contract has verified, on-chain and in one call, an ML-DSA-87
  signature (FIPS 204, context `qlyphs/near-vault/v1`) by the vault's key. The signed message fixes the
  network tag, the vault, the action, the token, the receiver, the amount, the nonce and a validity window
  of at most 1,800 blocks.
- A nonce is consumed once. A replay, a changed byte of the message or another key is refused (tested on
  a local sandbox and on testnet).
- A vault is trusted only if the pinned factory created it, which the factory's own registry records.
  The factory's batch is fixed code, so the vault has no access key from the moment it exists: no Ed25519
  key can spend from it, redeploy it or delete it, and its code cannot change.
- The relayer pays gas and carries public bytes. It can delay or drop a payment. It cannot change what
  is paid, to whom, from which vault or on which network.

## Why the factory

An earlier version trusted any account whose state showed the release code and no access key. A review
showed this is not enough: a creator can put extra actions in the creating batch, before the vault code,
that schedule a delayed `AddKey` (a yielded receipt). Nothing in account state shows the pending receipt,
so every check passes, then the key appears and the vault is drained. This was demonstrated on a local
sandbox. Creation history cannot be read from state, so trust now starts from a factory whose own
creation contained no `FunctionCall`, checked once per release.

A second review found that this was still not enough. On NEAR, deleting an account leaves its
sub-accounts and its pending receipts in place. So whoever controls the parent can create the factory
id once with a key and plant a rigged vault under it. They can then delete that account and re-create the
factory cleanly. The audit passes on the new creation. Also demonstrated on a sandbox.

The factory now records every vault it creates in its own storage, written before the creating receipt
runs, and the preflight requires that record. A vault from an earlier life of the account is not in it,
and is refused (tested). Release rules that remain:

- the factory id must never have existed before its audited creation (check archival history once);
- publish the factory only after a quiet period, since old pending receipts are bounded by yield timeouts
  and gas;
- read the audit from archival nodes you trust.

## Short vault ids

The vault id carries only 64 bits of the key's hash. A key whose hash shares those 8 bytes can be created
first at that address: it cannot spend from the right owner's vault, but it takes the name, and money sent
to the name before `checkVault` passed would be under that other key. Wallets therefore treat a derived id
as unusable until the full-key check passes at a final block, and show a conflict if another key holds it.
A mainnet profile should carry the full 256-bit hash in the id.

## Failed creations

The creation callback only rewrites the record's status. A failed creation is marked `F` and paid back by
`refund`, which anyone may call, from the record's amount to the record's caller, once the forwarded
deposit is back. A record is never deleted because time passed: a pending creation may still complete.

## What it does not protect

- **NEAR itself is not post-quantum.** Consensus, validators, the relayer's key and every account outside
  the vault use classical cryptography. Only the authorization to spend from this vault needs ML-DSA-87.
- **The token is trusted.** A NEP-141 balance is whatever the token contract says. A token with an
  owner who can freeze, mint or upgrade keeps those powers over the vault's balance.
- **The network tag is compiled in, not learned.** Anyone can start a private chain with an account of
  the same name and the same code, and replay a testnet authorization there. That moves nothing on
  testnet. The defense is the wallet preflight (`checkVault`): pinned factory, release code, zero keys and
  the owner's key, read from a node the wallet trusts. RPC answers are not consensus proofs.
- **Assets the vault cannot move stay there.** It can send NEAR and call `ft_transfer`, nothing else.
  NFTs (NEP-171), multi-tokens (NEP-245), `ft_transfer_call`, token storage deposits and the storage
  stake itself cannot leave the vault.
- **Outstanding authorizations.** A relayer can hold a signed authorization until it expires (at most
  1,800 blocks). Two authorizations with the same nonce exclude each other, but nonce N and N+1 can both
  run. The wallet must track what it has signed.
- **Failed deliveries spend the nonce.** If the payment receipt fails, the funds stay in or return to
  the vault, and the owner must sign again.
- **Keys.** One ML-DSA-87 key per vault, no rotation and no recovery: losing it locks the funds for good.
- **The signer is a test script** (`sdk/vault.mjs`, OpenSSL). The Qlyphs wallet does not sign vault
  authorizations yet.

## Key material

No key or phrase is committed. Test keys live outside the repository.

## Reporting

This is a research repository. Report issues to the repository owner privately.
