# Protocol

This describes `contract/vault.c` and `sdk/vault.mjs`.

## Factory and vault accounts

Vaults are created only by the factory (`contract/factory.c`), and a wallet trusts only direct children of
the factory pinned in `deployments/<network>.json`.

The factory account is created by one transaction of `CreateAccount`, `Transfer` and `DeployContract`.
There is no `FunctionCall` in it, so no code runs as the factory before its own code, and nothing can be
scheduled for later (such as an `AddKey`). `auditFactoryCreation` checks this transaction once per
release. The factory has no access key and no upgrade path.

`create(public key (2,592 bytes))`, with at least 0.25 NEAR attached, creates the vault at an address
derived from the key: `<label>.<factory>`, where the label is the hex of the first 8 bytes of
SHA-256(public key) (`vaultAddress` in the SDK). The factory account id must be at most 47 characters so
the vault id fits in 64.

The label is a 64-bit locator, not the binding. Another key whose hash starts with the same 8 bytes
(about 2^64 classical or 2^32 idealized quantum trials) can be created first at that address. It can never
spend from the right owner's vault, but it occupies the name. What binds a vault to its owner is the full
key, checked by `checkVault`, so no funds may be sent to a vault id before that check passes.

`create` first writes a registry record in the factory's storage, key `r<label>`, value
`SHA-256(pk) ‖ 'P' ‖ deposit ‖ caller`. It refuses a key that already has a record. It then emits one
receipt to the vault account:

1. `CreateAccount`
2. `Transfer` of the deposit minus 0.01 NEAR, which stays in the factory to pay for the record (about
   0.19 NEAR of the vault's balance is locked as its storage stake)
3. `DeployContract` with the vault code embedded in the factory (its SHA-256 is `vault_sha256`)
4. `FunctionCall init` with the public key

The actions of a receipt are atomic. The private callback `on_create` settles the record, and only
rewrites its status byte, so it needs no balance and cannot fail on funds:

- on success it becomes `SHA-256(pk) ‖ 'C'`;
- on failure (for example, an account already sits at that address) it becomes
  `SHA-256(pk) ‖ 'F' ‖ deposit ‖ caller`.

The callback never pays. The deposit forwarded to the failed receipt comes back to the factory in a
separate refund receipt, which may arrive after the callback; paying from the callback could then fail
and leave the record pending for good. Instead `refund(registry key)`, which anyone may call, sends a
failed record's deposit to its recorded caller and marks the record `R` (refunding), so no second refund
can start meanwhile. Its private callback `on_refund` removes the record only if the transfer succeeded;
if it failed (the caller's account was deleted), the amount came back and the record returns to `F`,
owed again. Amount and recipient come from the record only, never from arguments. If the factory cannot
pay yet, the whole call fails, the record stays `F`, and it can be called again. `init` refuses a second call and any caller other
than the direct parent account.

The vault never has an access key: nobody can sign as the vault, redeploy it or delete it.

Storage: key `k` holds the public key, key `n` the next nonce (`u64`, little-endian), starting at 0.

## Signed message

256 bytes, signed with Pure ML-DSA-87 (FIPS 204, SHAKE, not HashML-DSA) under the context
`qlyphs/near-vault/v1`. Integers are little-endian. Account ids are ASCII, zero-padded to 64 bytes, with
their length in the byte before.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | `QLYP87N1` |
| 8 | 8 | network tag, zero-padded: `mainnet`, `testnet` or `sandbox` |
| 16 | 1 | vault account id length |
| 17 | 64 | vault account id |
| 81 | 1 | action: 0 NEAR transfer, 1 NEP-141 `ft_transfer` |
| 82 | 1 | token contract id length (0 for NEAR) |
| 83 | 64 | token contract id (all zero for NEAR) |
| 147 | 1 | receiver account id length |
| 148 | 64 | receiver account id |
| 212 | 16 | amount (`u128`, yoctoNEAR or token base units), strictly positive |
| 228 | 8 | vault nonce (must equal the stored one) |
| 236 | 8 | expiry block height (exclusive) |
| 244 | 8 | issue block height |
| 252 | 1 | gas for `ft_transfer` in Tgas, 10 to 100; 0 for a NEAR transfer |
| 253 | 3 | must be zero |

The contract refuses a message unless:

- the magic matches and the network tag equals the one compiled into the binary;
- the vault id equals the executing account;
- every id is a valid NEAR account id (2 to 64 chars of `a-z 0-9 - _ .`, no leading, trailing or doubled
  separator) with zero padding, and the receiver is not the vault;
- for a NEAR transfer the token field and the gas byte are empty; for `ft_transfer` the gas byte is 10 to 100;
- the amount is positive, the nonce is the stored one, and `issued <= height < expiry` with
  `expiry - issued <= 1800` blocks;
- the signature verifies under the stored key;
- the balance above the storage stake (`storage_usage × 10¹⁹` yoctoNEAR) covers the amount for a NEAR
  transfer, or 1 yoctoNEAR for `ft_transfer`.

## execute

Input: `signature (4,627 bytes) ‖ message (256 bytes)`, raw bytes, not JSON. Anyone may send it; the
relayer pays gas: a call burns about 7 Tgas; attach at least 30 Tgas for a NEAR transfer, and 30 Tgas
plus the signed `ft_transfer` gas for a token payment.

On success the nonce is incremented, then one receipt is created:

- NEAR: a `Transfer` of the amount to the receiver.
- NEP-141: `ft_transfer({"receiver_id": <receiver>, "amount": "<decimal>"})` on the token, with exactly
  1 yoctoNEAR attached and the signed gas.

The nonce is spent before the payment receipt runs. If that receipt fails (receiver does not exist, not
registered on the token, token paused), the NEAR comes back to the vault or the tokens never leave it, and
the owner signs a new authorization with the next nonce.

## state (view)

Returns `{"version":"qlyphs/near-vault/v1","chain":<network>,"nonce":<n>,"pk_sha256":<hex>}`.

## Wallet preflight

`checkVault` in `sdk/vault.mjs` runs before every signature. It reads everything at one final block:

- the vault id is the address the pinned factory derives from the owner's key;
- the factory runs the pinned code, has no access key, its `state` reports the pinned vault code, and its
  registry holds `SHA-256(pk) ‖ 'C'` for this vault;
- the vault runs that code and has no access key;
- the vault storage is exactly `k` (the owner's 2,592-byte key) and `n` (8 bytes, not `2^64 - 1`), and
  `state` reports the expected version and network.

It returns the nonce to sign. Account ids are checked against the NEAR grammar before encoding, so a
lookalike Unicode name is refused rather than silently changed.
