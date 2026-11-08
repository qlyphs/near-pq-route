# Guardian protocol

Qlyphs Guardian holds the admin powers of one NEAR contract and uses them only after 2 of 3 ML-DSA-87
signers approve an exact operation and an on-chain delay has passed. This describes `contract/guardian.c`,
the reference target `contract/token.c` and `sdk/guardian.mjs`.

The claim is narrow: on the reviewed deployment, minting and code upgrades of the target require two
ML-DSA-87 approvals and the configured delay. NEAR consensus, users' keys and any other contract are
outside it.

## Accounts and roles

| Account | Access keys | Authority |
|---|---|---|
| Guardian | none | Calls the target's `mint` and `upgrade`, only for a queued, matured operation |
| Target (token) | none after migration | Accepts `mint` and `upgrade` only when the immediate caller is the Guardian |
| Signers 1-3 | not NEAR accounts | ML-DSA-87 keys fixed at Guardian creation; any two approve an operation |
| Relayer / executor | any NEAR account | Submits approvals and executions, pays gas; chooses nothing that is signed |
| Former owner | its own account | No role after `handover` |

The Guardian has no owner, no upgrade path, no signer rotation, no arbitrary call and no recovery
route. Its configuration is fixed at creation. Losing two signer keys locks administration of the target
for good: that is the price of having no fallback, and it is stated, not hidden.

## Creating the Guardian

One transaction from a creating account, with exactly these actions:

1. `CreateAccount`
2. `Transfer` (storage funding)
3. `DeployContract` with the pinned Guardian code
4. `FunctionCall init(config)`

`init` refuses a second call and any caller other than the direct parent account (same rule as the
vault). Nothing in the Guardian code adds keys, deploys code or yields. `auditGuardianCreation` checks the
transaction once per release: those four actions only, the code hash, and the config.

Config (binary, fixed size): network tag (8) ‖ target id (len 1 + 64) ‖ delay in seconds (u64) ‖
execution window in seconds (u64) ‖ three ML-DSA-87 public keys (3 × 2,592). `init` refuses duplicate
keys, a delay below 60 s or above 30 days, and a window below 1 hour. The Guardian stores
`config_hash = SHA-256(config)`, and every signed message names it.

## The target contract

The reference target is a small token (`contract/token.c`, NEP-141 subset: `ft_transfer`,
`ft_balance_of`, `ft_total_supply`, `ft_metadata`). Its admin surface is exactly:

- `mint(op_id, receiver, amount)`: caller is the owner (legacy mode) or the Guardian (guarded mode).
  In guarded mode the op id must be new; it is recorded atomically with the mint.
- `handover(guardian_id)`: owner only, once. Sets the Guardian, clears the owner. There is no way back.
- `upgrade(op_id, from_version, to_version, code)`: caller is the Guardian. Returns a promise for one
  batch receipt to itself: `DeployContract(code)` then `FunctionCall migrate(op_id, from, to)`. Actions of
  one receipt are atomic, so a failing `migrate` leaves the old code and state in place.
- `migrate(op_id, from, to)`: callable only by the token itself (inside that batch). Requires the
  stored version to equal `from`, sets it to `to`, records the op id.

There is no other method that writes the owner, the Guardian, balances (except `ft_transfer` by the
holder) or code. Migration of a live target: the owner calls `handover`, then the target account deletes
its own access keys. Both are visible in the verification report.

## Signed operation

320 bytes, Pure ML-DSA-87 (FIPS 204), context `qlyphs/near-guardian/v1`. Integers little-endian.
Account ids are ASCII, zero-padded to 64 bytes, length in the byte before, checked against the NEAR
grammar.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | `QLYPGRD1` |
| 8 | 8 | network tag |
| 16 | 1 + 64 | Guardian account id |
| 81 | 1 + 64 | target account id |
| 146 | 32 | `config_hash` |
| 178 | 8 | operation nonce (must equal the Guardian's next nonce; cancel: the nonce being canceled) |
| 186 | 1 | action: 1 mint, 2 upgrade, 3 cancel |
| 187 | 8 | deadline (block timestamp, seconds): approvals must be queued before it |
| 195 | 125 | action payload, zero-padded |

Payloads:

- mint: receiver id (1 + 64) at 195, amount (u128, strictly positive) at 260.
- upgrade: SHA-256 of the new code (32) at 195, code length (u32) at 227, from version (u32) at 231,
  to version (u32) at 235. The code follows the approvals in the `propose` input.
- cancel: no payload; the nonce field names the operation.

All unused bytes must be zero. Attached deposit to the target is always zero and is not a field.

## Methods

`propose(message ‖ k ‖ k × (signer index ‖ signature) ‖ extra)`: anyone may call. `k` is 2 or 3; indices
are distinct and in 0..2; every signature must verify under that signer's key. Checks: magic, network,
Guardian id = self, target = configured target, config hash, action 1 or 2, nonce = next nonce, current
time < deadline, no operation active. For mint `extra` is empty; for upgrade it is the code (length and SHA-256 checked, at most 400 KB). On success: the nonce is
consumed, and the operation is stored as `Queued` with `eta = now + delay` and `expires = eta + window`,
using the block timestamp when the quorum is verified. Invalid input consumes nothing.

`cancel(message ‖ k ‖ approvals)`: action 3, nonce = the active operation's nonce, deadline in the future,
2 of 3 valid signatures. Only a `Queued` operation can be canceled; it becomes `Canceled` and its stored
code is deleted.

`execute()`: anyone may call. The active operation must be `Queued`, with `eta <= now < expires`. It
becomes `Executing` before the target call is created, so a second `execute` fails. The Guardian calls the
target (`mint` or `upgrade`, zero deposit, fixed gas) and chains its private callback `on_result`.

`on_result`: predecessor must be the Guardian; the operation must be `Executing` with the expected nonce.
Success: `Applied`. Failure: `Failed`. Either way the slot is freed and stored code is deleted. A failed
operation is never retried under the same nonce; signers approve a new one. If the callback itself never
lands the operation stays `Executing` (shown as unresolved); the target's op id record still prevents
any duplicate mint or upgrade.

An operation past `expires` while `Queued` can be closed by anyone with `expire()`, which marks it
`Expired` and frees the slot.

Views: `state()` returns version, network, target, config hash, delay, window, signer key hashes, next
nonce and the active operation (status, action, eta, expires, code hash). `code(nonce)` is not provided:
queued code is readable from the Guardian's storage (key `c`) through RPC `view_state`.

## Timing

All times come from `block_timestamp` (nanoseconds, converted to seconds). The delay starts when the
quorum is verified, never from an off-chain time. Re-submitting the same approvals fails (nonce spent).
`execute` before `eta` fails and leaves the operation intact.

## Verification report

`verifyControl` in `sdk/guardian.mjs`, at one finalized block:

- Guardian and target access-key lists are empty (paginated, errors are failures, not "empty");
- both accounts run directly deployed code (no global-contract reference) whose SHA-256 matches the
  reproducible build;
- the Guardian `state` matches the expected config hash, target and delay;
- the target `state` names the Guardian and no owner;
- the Guardian creation transaction passes `auditGuardianCreation`.

An empty key list proves the account-key condition at that block. The absence of hidden application
authority depends on the reviewed code, which is in this repository.
