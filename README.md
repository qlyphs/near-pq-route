# Qlyphs Guardian

**Post-quantum admin control for NEAR contracts.** A protocol hands its admin powers (here: mint and code
upgrade) to a Guardian contract that has no keys at all. The Guardian acts only after **two of three
ML-DSA-87 signers** approve the exact operation and an **on-chain delay** has passed; two signers can
cancel it during the delay. The old admin key stops working, and the contract keeps running and can still
be upgraded.

- **Live demo (NEAR testnet):** https://qlyphs-guardian-demo.qlyphs.workers.dev
- **Video:** `[link added at submission]`
- **Spec:** [docs/GUARDIAN.md](docs/GUARDIAN.md)

Unaudited testnet prototype. Read [Limits](#limits) before drawing conclusions.

## Why

On the day a classical key can be broken, an attacker does not need to rob users one by one. One admin
key, the owner of a token, the upgrade authority of a protocol, a bridge's multisig, can mint, upgrade or
drain a whole protocol. Those keys are classical today. NEAR already supports native ML-DSA-65 access keys;
what is missing is an admin *workflow* that a protocol can adopt without losing its contract, its
balances or its ability to upgrade: a quorum, a delay, a cancel path, and a way for anyone to check that no
classical bypass is left.

## Try it in two minutes

Open the [demo](https://qlyphs-guardian-demo.qlyphs.workers.dev) and:

1. **Verify control.** The page reads one finalized block and checks: Guardian and token have zero access
   keys, both run reviewed builds (reproducible hashes), the Guardian's configuration bytes are the expected
   ones, the token is guarded by this Guardian with no owner. Expect nine green checks.
2. **Try the old keys.** The former owner's key and the token's deleted deployment key are published on the
   page. Click both buttons. Expect `only the Guardian can do this` from the token, and
   `InvalidAccessKeyError: AccessKeyNotFound` from the network.
3. **Request a mint.** Enter any testnet account id. Two demo signers approve the 320-byte operation with
   ML-DSA-87, the Guardian queues it, and a 60-second timelock starts. Expect the Execute button to stay
   disabled until it ends, then click it. Expect `applied` and 100 demo tokens on that account.

The page also lists every transaction of the testnet cutover, each linked to the explorer.

## What was built

| Part | What it does |
|---|---|
| [`contract/guardian.c`](contract/guardian.c) | The Guardian. Immutable, no owner, no keys. `propose` and `cancel` share one validator (framing, network, Guardian, target, config hash, deadline, two distinct valid ML-DSA-87 approvals). `execute` marks the operation Executing before its single dispatch; a private callback settles it. |
| [`contract/token.c`](contract/token.c) | The reference target: a small token that starts with a classical owner, hands mint and upgrade to the Guardian once, and upgrades itself in one atomic deploy-and-migrate receipt. |
| [`sdk/guardian.mjs`](sdk/guardian.mjs) | Message encoding, approvals, the per-deployment creation audit and the `verifyControl` report. |
| [`tests/`](tests) | Unit checks of the SDK (23), sandbox suites (Guardian 67, token 48) and the testnet ceremony. |
| [`demo/`](demo) | The hosted demo: one Cloudflare Worker and one page. |

The ML-DSA-87 verifier in [`core/`](core) is the same C code as the Qlyphs vault (below), verified
against OpenSSL and FIPS 204 vectors.

## How it works

```
Owner (legacy key) ──handover──▶ Token ◀──mint / upgrade── Guardian ◀── propose(op, 2 × ML-DSA-87)
                                  │                          │  └──── cancel(op hash, 2 × ML-DSA-87)
                     keys deleted ┘                          └─ execute() by anyone after the delay
```

1. **Operation.** Signers approve 320 bytes: network, Guardian, target, config hash, nonce, action (mint:
   receiver and amount; upgrade: code hash, length and versions; cancel: the proposal hash) and a
   submission deadline. Pure ML-DSA-87, context `qlyphs/near-guardian/v1`.
2. **Queue.** `propose` checks everything, verifies two approvals from distinct signers, consumes the
   nonce and stores the operation (and the upgrade code) with `eta = now + delay`. The exact bytes are
   readable on-chain during the whole delay.
3. **Execute.** After `eta`, anyone calls `execute`. The Guardian calls the token's `mint` or `upgrade`,
   which accept only the Guardian as immediate caller. An upgrade is one batch receipt to the token itself:
   deploy, then migrate, atomic. The operation id is the Guardian nonce, recorded by the token, so nothing
   applies twice, even across upgrades.
4. **Cancel / expire.** Two signers can cancel a queued operation by its proposal hash; an operation not
   executed within its window can be expired by anyone.

The full rules, the state machine and the trust boundary are in [docs/GUARDIAN.md](docs/GUARDIAN.md).

## Claims and evidence

Release `qlyphs-guardian.testnet`. Journal of every step: `deployments/guardian-qlyphs-guardian.json`.

| Claim | Evidence |
|---|---|
| The token has no access keys and is guarded by the Guardian; the Guardian has no keys; both run reviewed builds | Live: the demo's report. Recorded: `evidence/guardian-qlyphs-guardian.json` (`report`, final block 276781808) |
| The Guardian was created by exactly CreateAccount, Transfer, DeployContract (pinned code), init (exact config bytes), with complete final execution | tx `6gL6FeB2Pgm2bTv8bfqRnrzkLjhdQ4wCjMtgRX4bSBFf`, re-audited by every report |
| Cutover: handover to the Guardian, then the token's only key deleted, in that order | handover `CxDJg7EMpHjMBTmMGpCrvBw8g3LDwe7jfrcqMzLGA37i`, key deletion `9gHUP4qwthzgr7kGZrgpMpRzfPMadY6BREyADdrjeXSD`, re-audited by every report |
| A PQ-approved mint and a PQ-approved upgrade V1 → V2 work after cutover; early execution is refused; balances, Guardian and replay state are kept | mint execute `FkyuGc7R5n14DBiyq4QQykJ3VKGiCLEw67cLUnrK88Xx`, upgrade execute `6AgZNcgPHbHfD1h9hsp465swo7ZU2V9x9kVJ9VNbMzcN`, early executes in the journal |
| The former owner cannot mint; the network refuses the deleted key | Live: demo buttons. Recorded: `attacks` in the evidence file |
| A 131,072-byte upgrade whose migration fails is rolled back and settled `failed`; a 131,072-byte upgrade applies; the callback uses 3.4 of its 10 Tgas | `9NNG4BituLmxucmEdACHwkwMTnq4oo2ykZsjikJdCwZg`, `4FxwywjkuBqbNDYxLkSVaiBEzwQRPGvfHkVAJSwvN9Vx` (second token and Guardian) |
| One signer, an outsider key, a tampered field, another network, Guardian, target or config, an expired deadline, a replay: all refused, with no state change | `evidence/guardian-sandbox.json` (67 checks) |
| Cancel is bound to Guardian, nonce and proposal hash; every terminal path frees the slot; two racing executes dispatch once; an underfunded execute leaves the operation queued; a failing callback leaves it unresolved, never retried | `evidence/guardian-sandbox.json` |
| The token reads exactly what `JSON.parse` reads or refuses (duplicates, escapes, non-JSON, trailing data), across the full u128 range | `evidence/token-sandbox.json` (48 checks) |
| The report never passes on missing, malformed, mismatched or placeholder evidence | `evidence/sdk-unit.json` (23 checks) |
| The release Wasm exports exactly the reviewed entry points | `scripts/check-exports.mjs`, run by `scripts/build.sh` |

Gas on testnet: queue a mint 13.6 Tgas (two ML-DSA-87 verifications), queue an upgrade 15.1 Tgas, execute a
mint 6.3 Tgas, execute an upgrade 10.0 Tgas, queue or execute a 131,072-byte upgrade about 29 Tgas.

An earlier release (`qlyphs-guardian-r1.testnet`) ran before review fixes to the token and the report; its
records are kept as `deployments/superseded-guardian-r1.json` and are not evidence for this build.

## Reproduce

Requirements: Node 22+, LLVM clang and lld with wasm32 (Homebrew `llvm` and `lld`), OpenSSL 3.5+ (ML-DSA).

```sh
npm ci
bash scripts/build.sh            # builds every contract, prints SHA-256, checks release exports
node tests/sdk.unit.mjs          # 23 checks, no network
node tests/token.sandbox.mjs     # 48 checks, local NEAR sandbox
node tests/guardian.sandbox.mjs  # 67 checks
```

The build is deterministic: the hashes printed for `build/guardian-testnet.wasm`, `build/token-v1.wasm`
and `build/token-v2.wasm` must equal `guardian_sha256` and `reviewed_target_sha256` in
`deployments/guardian-qlyphs-guardian.json`, which the report compares with the code deployed on testnet.

To run your own testnet ceremony (fresh account ids, used once; the script stops at the first failed step
and resumes only from state it recognises on chain):

```sh
FUNDER_ACCOUNT=<funded testnet account> FUNDER_KEY_FILE=<its key file> SECRETS_DIR=<a folder outside the repo> \
RELEASE_PARENT=<new-name>.testnet node tests/guardian.testnet.mjs
```

The demo runs locally with `cd demo && npm ci && npx wrangler dev` and a `demo/.dev.vars` holding
`SIGNER_A`, `SIGNER_B` (signer seeds), `RELAYER_KEY`, `RETIRED_OWNER_KEY`, `RETIRED_TOKEN_KEY`.

## Limits

- **Unaudited testnet prototype.** Adversarial design and code reviews shaped it; that is not an audit.
- **Scope of the claim.** Minting and upgrades of this reviewed token require two ML-DSA-87 approvals and
  the delay, at the reported block, after the recorded deployment and cutover. NEAR consensus, users'
  keys, other contracts, and code that a quorum approves later are outside it.
- **Trust boundary.** A snapshot cannot prove that no earlier incarnation of an account id left a delayed
  self-addressed receipt. The demo relies on fresh ids used once and a recorded ceremony; unknown
  provenance shows as unverified.
- **No recovery path, by design.** Losing two signer keys, or a settlement callback that fails, locks
  administration of the target for good. The Guardian has no override.
- **Demo signers.** The demo server holds two of the three signer keys so that visitors can trigger
  mints. In a real deployment each signer keeps its own key in its own wallet.
- **Why ML-DSA-87 and not NEAR's native ML-DSA-65?** The Qlyphs wallet already signs with ML-DSA-87
  (NIST category 5). The contribution here is the governance workflow and its verifiable cutover; the same
  model can use the native `ml_dsa_verify` host function later.

## Hackathon scope

Built for the NEAR Hackathon (Nov 2026). Every commit in this repository is from 22 Oct 2026 or later.
The ML-DSA-87 verifier, the vault and its factory (22–27 Oct) are reused; Guardian, the token, the
SDK additions, the suites, the testnet ceremony and the demo were built from 8 Nov. The Qlyphs wallet,
an existing product, is not part of this repository.

## Roadmap

- Signers in the Qlyphs wallet, each on its own device.
- An adapter for real NEAR protocols, starting with their mint, pause and upgrade paths.
- The same Guardian on EVM chains, using the ML-DSA-87 verifier already measured on Base Sepolia.
- Longer term: an evacuation path to a fully post-quantum chain for assets whose home chain cannot
  protect them.

## The vault

This repository started as an ML-DSA-87 vault on NEAR: an account with no keys that moves NEAR or NEP-141
tokens only after an on-chain ML-DSA-87 signature check. See [docs/VAULT.md](docs/VAULT.md),
[docs/PROTOCOL.md](docs/PROTOCOL.md) and [SECURITY.md](SECURITY.md).

## License

MIT. Third-party code: [THIRD_PARTY.md](THIRD_PARTY.md).
