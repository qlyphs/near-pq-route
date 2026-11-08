# Guardian protocol

Qlyphs Guardian holds the admin powers of one NEAR contract and uses them only after 2 of 3 ML-DSA-87
signers approve an exact operation and an on-chain delay has passed. This describes `contract/guardian.c`,
the reference target `contract/token.c` and `sdk/guardian.mjs`.

The claim is narrow: at a stated finalized block, on the reviewed deployment and after the documented
deployment and cutover ceremony, minting and code upgrades of the target require two ML-DSA-87 approvals
and the configured delay. NEAR consensus, users' keys, other contracts, and code that a quorum approves
later are outside it.

## Accounts and roles

| Account | Access keys | Authority |
|---|---|---|
| Guardian | none | Calls the target's `mint` and `upgrade`, only for a queued, matured operation |
| Target (token) | none after cutover | Accepts `mint` and `upgrade` only when the immediate caller is the Guardian |
| Signers 0-2 | not NEAR accounts | ML-DSA-87 keys fixed at Guardian creation; any two approve an operation |
| Relayer / executor | any NEAR account | Submits approvals and executions, pays gas; chooses nothing that is signed |
| Former owner | its own account | No role after `handover` |

The Guardian has no owner, no upgrade path, no signer rotation, no arbitrary call and no recovery route.
Its configuration is fixed at creation. Two cases lock administration of the target for good, and are
stated rather than hidden: losing two signer keys, and an `Executing` operation whose settlement callback
fails (see Execution).

## Trust boundary: deployment and cutover

What the report can prove is the present state at one block: no access keys, reviewed code, expected
configuration. It cannot prove from a snapshot that no earlier incarnation of an account id left a
delayed self-addressed receipt (for example an `AddKey` waiting on a slow promise) that would still run
after the account is deleted and recreated. So the demo rests on a documented ceremony:

1. A dedicated release parent account is created for this release, and every Guardian and target id is a
   fresh child of it, used once. The ids, creation transactions and their complete receipt outcomes are
   recorded in `deployments/guardian-<network>.json`.
2. The Guardian is created by one transaction: `CreateAccount`, `Transfer`, `DeployContract` (pinned
   code), `FunctionCall init(config)`. `auditGuardianCreation` checks, per deployment, that this
   transaction succeeded with exactly those actions, that code hash, and those exact `init` bytes, and that
   every receipt it produced has completed.
3. The target is created by its own transaction with a full-access key (legacy mode), deployed with token
   V1 and initialized by the token account itself (`new`). Initial demo holders are minted by the owner.
4. Cutover: the SDK preflights the Guardian (its state names this target and the expected config), the
   owner calls `handover`, then the target account signs `DeleteKey` for every one of its access keys.
   Each step waits for complete receipt execution, not just block inclusion.
5. The verification report runs at a pinned finalized block after step 4.
6. Only then are the retired credentials (the owner's key and the target's deleted key) published.

Unknown or unrecorded provenance makes the report say "unverified", never green. This proves protection
after a trusted cutover; it does not certify migration of an account an adversary already controlled.

## Guardian configuration

The network is compiled into the binary (`-DQP_CHAIN`, like the vault), never a configuration value.

Config, exactly 7,857 bytes: target id (length u8 + 64 zero-padded bytes) ‖ delay in seconds (u64) ‖
dispatch window in seconds (u64) ‖ three ML-DSA-87 public keys (3 × 2,592). `init` refuses: a caller
other than the direct parent; a second call; an invalid or non-canonical target id; the Guardian itself as
target; duplicate keys; a delay outside 60 s to 30 days; a window outside 1 hour to 30 days. It stores the
config and `config_hash = SHA-256(config)`.

## The target contract

`contract/token.c`, a reference fixture with a fungible-token subset (`ft_transfer`, `ft_balance_of`,
`ft_total_supply`, `ft_metadata`), not a complete NEP-141 implementation. Two reviewed builds, V1 and V2,
differ only in metadata and compiled version.

State: `v` version (u32, its presence is the initialization sentinel and it is never removed), `o` owner
(legacy mode only), `g` Guardian (guarded mode only), `l` next acceptable operation id (u64, absent = 0),
`s` total supply, `b<account>` balances.

| Mode | `mint` | `upgrade` | `handover` |
|---|---|---|---|
| Legacy (`o` set, `g` absent) | immediate caller is the owner, no op id | refused | owner, once |
| Guarded (`g` set, `o` absent) | immediate caller is the Guardian, op id ≥ `l` | immediate caller is the Guardian | refused |

- `new({"owner_id"})`: only the token account itself, only when `v` is absent. Both builds refuse
  reinitialization.
- `handover({"guardian_id"})`: sets `g` and removes `o` in one receipt. Refuses the token itself.
- Guarded `mint({"receiver_id","amount","op_id"})`: `op_id` (decimal u64) must be ≥ `l`; sets
  `l = op_id + 1` in the same receipt as the mint. Returns nothing; any failure traps.
- `upgrade(op_id u64 ‖ from u32 ‖ to u32 ‖ code)`: requires `op_id ≥ l`, `from` = stored version,
  `to > from`, code of 1 to 131,072 bytes. Returns the promise of one batch receipt to itself:
  `DeployContract(code)` then `FunctionCall migrate(op_id ‖ from ‖ to)`. The receipt's actions are atomic.
- `migrate(op_id ‖ from ‖ to)`, run by the new code, callable only by the token itself: requires the
  stored version = `from`, `to` = the compiled version, `op_id ≥ l`, guarded mode with `g` present and `o`
  absent. Sets the version and `l = op_id + 1` (refusing `op_id = 2^64 - 1`). Balances, supply and `g` are
  untouched; the initialization sentinel remains present.
- `ft_transfer({"receiver_id","amount","memo"?})` with exactly 1 yoctoNEAR: the sender is the immediate
  caller (`predecessor_account_id`, never the transaction signer or a supplied field); the amount is
  positive; the sender's balance covers it; debit and credit use checked arithmetic; the receiver must
  already hold a balance record (records are created only by `mint` and kept at zero), so transfers cannot
  grow the target's storage. Self-transfer is refused. Amounts and `op_id` are decimal strings in JSON.

The operation id is the Guardian nonce. Ids may have gaps (canceled, expired and failed operations consume
nonces); they never repeat because the Guardian is fixed and its nonce only increases. This high-water
mark is valid only for one fixed Guardian with serialized operations.

## Signed operation

Exactly 320 bytes, Pure ML-DSA-87 (FIPS 204, no pre-hash) over these bytes with context
`qlyphs/near-guardian/v1`. Integers little-endian, read byte by byte. Account ids are ASCII, length byte
then 64 zero-padded bytes, checked against the NEAR grammar.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 8 | `QLYPGRD1` |
| 8 | 8 | network tag (compiled into the Guardian) |
| 16 | 1 + 64 | Guardian account id |
| 81 | 1 + 64 | target account id |
| 146 | 32 | `config_hash` |
| 178 | 8 | operation nonce |
| 186 | 1 | action: 1 mint, 2 upgrade, 3 cancel |
| 187 | 8 | submission deadline (queue deadline for a proposal, acceptance deadline for a cancel), block timestamp in nanoseconds |
| 195 | 125 | action payload, zero-padded |

Payloads:

- mint: receiver id (1 + 64) at 195, amount (u128, nonzero) at 260.
- upgrade: SHA-256 of the code (32) at 195, code length (u32, 1 to 131,072) at 227, from version (u32)
  at 231, to version (u32) at 235.
- cancel: `proposal_hash` (32) at 195, the SHA-256 of the 320-byte message of the operation to cancel.

`proposal_hash = SHA-256(message)` identifies an operation for display, cancellation and evidence.

## Approval envelope and the common validator

`propose` and `cancel` take the same envelope: the 320-byte message, then exactly two approvals, each
`signer index (u8, 0..2) ‖ signature (4,627 bytes)`: 9,576 bytes. `propose` for an upgrade appends exactly
the declared code length; nothing else may follow. Two different indices are required; both signatures
must verify. A third approval is not accepted (it adds no authority).

Both methods first run one validator: exact input length; magic; network tag = compiled tag; Guardian id =
executing account; target = configured target; `config_hash` = stored; every id field valid and canonically
padded; unused payload bytes zero; `now < deadline`; two distinct valid approvals. Then:

- `propose`: action 1 or 2; nonce = next nonce (< 2^64 - 1); no active operation; mint amount nonzero;
  upgrade code length and SHA-256 match. Stores the operation `Queued` with `queued_at = now`,
  `eta = now + delay × 10^9`, `expires = eta + window × 10^9` (nanoseconds, checked arithmetic), and
  increments the nonce once.
- `cancel`: action 3; an operation is `Queued`; its nonce equals the message nonce and its
  `proposal_hash` equals the payload.

Invalid input changes nothing. A proposal that cannot be paid for in storage fails as a whole and changes
nothing. Cancellation only affects a queued operation: approvals that were never queued stay usable until
their deadline.

## Execution

`execute()`: anyone, no arguments. Requires `Queued` and `eta <= now < expires` (`expires` is a dispatch
cutoff; the target receipt may land later). Sets `Executing`, then creates the target call with zero
deposit and fixed gas (mint: `TARGET_MINT_GAS`, upgrade: `TARGET_UPGRADE_GAS`) and the private callback
`on_result(nonce u64)` with `CALLBACK_GAS`. If the prepaid gas cannot cover these, the call fails as a
whole and the operation stays `Queued`.

`on_result`: predecessor = Guardian; exactly one promise result; input is exactly 8 bytes equal to the
active nonce; state is `Executing`. It inspects only the promise status and never copies return data;
an unexpected status traps and leaves the operation unresolved. Success: `Applied`; failure: `Failed`. For
the reviewed target, failure means nothing applied: `mint` changes state in one receipt and traps on any
error, and `upgrade` returns the atomic deploy-and-migrate batch. A failed operation is never retried
under its nonce; a new mint signed under a new nonce is a new authorization.

If `on_result` itself fails, the operation stays `Executing`, the slot stays occupied, and no new
operation can be queued: administration is locked even with all three keys. This is a disclosed testnet
limitation. Elapsed time never clears `Executing`, because it proves neither failure nor the absence of a
late effect.

`expire()`: anyone; requires `Queued` and `now >= expires`.

## State machine

One active slot (`a`) and one bounded last-terminal record (`t`).

| Current | Event | Result |
|---|---|---|
| Empty | valid `propose` | `Queued`, nonce + 1 |
| Queued | valid `cancel` | `t` = Canceled; code deleted; slot cleared |
| Queued | `expire`, `now >= expires` | `t` = Expired; code deleted; slot cleared |
| Queued | `execute`, matured | `Executing`; dispatched once |
| Executing | `on_result` success | `t` = Applied; code deleted; slot cleared |
| Executing | `on_result` failure | `t` = Failed; code deleted; slot cleared |
| Executing | `on_result` fails | stays `Executing` (unresolved) |

No transition decreases or reuses the nonce.

## Storage and funding

Queued upgrade code is stored under key `c` (at most 131,072 bytes, about 1.32 NEAR of storage at
10^19 yoctoNEAR per byte), plus record overhead. The testnet Guardian is funded with 2.5 NEAR, measured
against a maximum-size queued code on testnet. Anyone can top up a keyless account with a plain transfer.
Transfers cannot grow the target's ledger; its storage grows with `mint` to a new holder, a larger
deployed build, or the first write of `l`, all admin actions. Terminal cleanup treats an absent `c` (a mint)
as normal.

## Views

Guardian `state()`: version, network, target, config hash, delay, window, SHA-256 of each signer key,
next nonce, and the active operation: status, nonce, proposal hash, the 320-byte message in hex, decoded
fields (receiver and amount, or code hash, length and versions), `queued_at`, `eta`, `expires` (ns, as
decimal strings), and the signer bitmap; plus the last terminal record (nonce, proposal hash, status).
Queued code is read with RPC `view_state` paginated (`block_id` = a pinned finalized block,
`prefix_base64` = `Yw==`, `limit` = 1, available from nearcore 2.13): an unpaginated request fails once the
account state exceeds 50,000 bytes. The SDK requires the returned key to be exactly `c` and checks the
length and hash against the message. Config bytes (`C`) are read the same way.

The wallet renders an operation from the 320 bytes it signs, never from separate metadata.

## Verification report

`verifyControl` in `sdk/guardian.mjs` resolves one finalized block hash and runs every query at it:

- Guardian and target access-key lists are empty (an error or incomplete answer is "unverified");
- both accounts run directly deployed code (no global-contract reference); the Guardian code hash equals
  the reproducible build; the target code hash is one of the reviewed builds (V1 or V2), otherwise
  "unreviewed code";
- the Guardian config bytes equal the expected config (keys, delay, window, target) and `state` agrees;
- the target is initialized, guarded, names this Guardian, has no owner; its `l` is reported;
- the per-deployment creation audit and the cutover evidence from the deployment file are shown separately
  from the present-state checks, with their transaction hashes.

Result wording: "At finalized block B these accounts had no access keys and ran these reviewed builds
with this configuration, under the recorded deployment and cutover assumptions."

## Release checks

A build step lists the exports of each release Wasm and compares them with an allowlist: Guardian
`init propose cancel execute on_result expire state`; token `new mint handover upgrade migrate ft_transfer
ft_balance_of ft_total_supply ft_metadata state`. Test-only builds (`token-v2-failing.wasm`) are never
deployed outside the sandbox.
