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

## The relayer

`relayer/` is untrusted by design: nothing it does can move funds the owner did not sign for, because
the vault checks every byte again. What it adds is protection of its own gas budget, and honest reporting.

- **No gas for a request the vault would refuse.** It parses the message as the vault and the wallet do
  (both parsers agree on the shared vectors in `relayer/vectors/messages.json`; a NEAR transfer names no
  token in any byte), runs `checkVault`, checks nonce and window at a final block and verifies the
  signature locally before it signs anything. A request that only becomes invalid later (the window
  closes, another relayer spends the nonce first) still costs one failed `execute`.
- **One payment per authorization.** Requests are keyed by SHA-256 of the message, not of the body,
  because ML-DSA signing is randomized and the same authorization can arrive with several signatures. One
  submission per (vault, nonce), claimed only after the signature verified, so a forged request cannot
  hold a slot. A repeat gets the first hash back.
- **No lost hash, no second transaction for one attempt.** The transaction is signed and its hash and
  bytes recorded before the broadcast. A timeout or any RPC error other than an explicit validation
  refusal keeps the hash and the slot (state uncertain); a retry re-broadcasts the same signed bytes,
  which the network includes at most once. Even a refused re-broadcast leaves the state uncertain, since
  the first copy may already be in.
- **Slots are released from chain facts only.** A slot passes to another message only when the old
  message's window has closed at a final height and the finalized vault nonce still equals the slot's
  nonce, so the old one was never accepted and can no longer be. The same message is sent again only
  after its last `execute` was seen refused and a fresh read shows the nonce unchanged and the window
  open. Released records stay in the history.
- **Bounded cost: the account balance is the budget.** A NEAR transaction carries no signed maximum gas
  price, so nothing the relayer computes can force what one transaction is charged. The enforceable
  budget for the testnet rehearsal is the relayer account itself: a dedicated account, funded
  minimally, with no automatic top-up. At start the relayer reads it at a final block and refuses to
  start if its balance minus the storage stake (storage_usage × `storage_amount_per_byte`, less
  `locked`) exceeds `RELAYER_MAX_ACCOUNT_SPENDABLE` (default 0.5 NEAR). Whatever the price does, the
  relayer cannot lose more than that. Everything below is an estimate whose job is to pause early.
- **The reservation estimate.** Quotas count only verified requests, so garbage cannot use up a vault's
  quota. At start the relayer reads `EXPERIMENTAL_protocol_config` (and refuses to start without it, on
  another chain, without a gas price adjustment rate, or if receipts are priced with a pessimistic
  inflation other than 1). Every submission reserves (send fees + execution fees + prepaid gas) ×
  max(`RELAYER_MAX_GAS_PRICE_YOCTO`, `min_gas_purchase_price`): nearcore charges the send fees at the
  block's gas price and the receipt's gas at the purchase price (the gas price raised to
  `min_gas_purchase_price`, 1e9 yocto/gas on testnet), so this covers the charge while the inclusion
  block's price is at most the ceiling. Two checks keep it so in practice. The submitter reads the
  final block it signs against after the request's wait in its serial queue and signs nothing if that
  block's price is above half the ceiling (the reservation and quotas of an unsigned attempt go back).
  And the signed bytes are re-broadcast only while the final height is within that block's price
  window: the number of blocks the price needs to pass the ceiling at the protocol's fastest rate
  (`gas_price_adjustment_rate`, 1 % per block on testnet, each step rounded up), less 10 blocks for
  inclusion. Past it the transaction stays uncertain, is marked stopped and is only followed. What the
  estimate cannot exclude is a first broadcast that the network includes long after it was sent, while
  the reference block stays valid; the account balance bounds that case. Reservations are never
  credited back once signed. Measured on testnet (`evidence/relayer-testnet.json`): a NEAR transfer
  reserved 0.03144 NEAR, its peak charge was 0.03095 NEAR and its net cost after refunds 0.00077 NEAR,
  signed against a block priced 1e8 yocto/gas under a 1e9 ceiling. The reserved total and the pause are
  written to `RELAYER_STATE_DIR` (atomically, before the reservation counts) and read back at start, so
  a restart does not reset an exhausted budget: a human must delete the file or raise the cap. A spend
  file that cannot be read or written fails closed.
- **One writer per state directory.** Before it reads the spend file the relayer creates
  `relayer.lock` in the state directory with O_EXCL and its pid, and refuses to start while a running
  process holds it (two instances would overwrite each other's reserved total). A lock left by a dead
  process is cleared only when started with `RELAYER_CLEAR_STALE_LOCK=1`; a live pid is never cleared.
- **Bounded reads.** `/outcome` reads go through their own bounded queue, a per-client and a global
  per-minute budget, and concurrent reads of one transaction share a single RPC call. Verification runs
  in a bounded queue; the body is never read past 4,883 bytes.
- **No claim beyond the evidence.** `/execute` answers when RPC accepted the transaction. `/outcome` says
  `delivered` only from a final outcome where the payment receipt (identified among the receipts the
  `execute` emitted: from the vault, to the receiver or token, with exactly the signed Transfer, or an
  `ft_transfer` with 1 yocto, the signed gas and arguments byte for byte
  `{"receiver_id":"<signed receiver>","amount":"<signed amount>"}`) succeeded, and `failed` only when such a receipt of an accepted `execute`
  failed. A refused `execute` is `unknown` with `attemptRejected`: a replay of an authorization already
  accepted elsewhere is refused too, and calling it failed would invite a second, real payment (tested on
  testnet). Anything missing or ambiguous is `unknown`. Once accepted, a record only moves on to
  delivered or delivery failed, and those never change.
- **Little to steal.** It holds one ed25519 key that can only spend the relayer account's NEAR, never
  logs it, and keeps only hashes: of messages, of (vault, nonce), of quota keys, and transaction hashes
  with their signed bytes, in memory, plus the spend total on disk. A restart forgets the ledger; the
  vault nonce still prevents a second payment.
- **Limits.** The client address is the socket's: behind a proxy every client shares one quota. Quotas
  and the ledger are per process. RPC answers are trusted for the preflight, the gas price, the account
  balance and the outcome, as in the wallet. The reservation is an estimate; only the account balance
  is enforced, and only if nobody tops the account up. Testnet only.

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
deposit is back. The debt is removed only when the refund transfer is seen to succeed; a transfer that
fails (the caller's account was deleted) leaves it owed, to be paid once the account exists again. A record is never deleted because time passed: a pending creation may still complete.

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
