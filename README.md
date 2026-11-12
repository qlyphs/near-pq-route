# Qlyphs: a post-quantum route into NEAR Intents

**QTC is signed with ML-DSA on Quantus. This route brings it into NEAR Intents and back with ML-DSA at every
application authorization step: user transactions, bridge approvals and withdrawals.**

At NEAR mainnet block 223,674,074 (2026-11-09), `bridge-mng.near`, the account that signs the `ft_deposit` calls
minting the existing QTC token on NEAR, had one ed25519 full-access key ([snapshot](evidence/bridge-mng-snapshot.json)).
The demonstrated deposit-and-return flow below uses ML-DSA for user transactions and bridge approvals. The NEAR
bridge enforces two ML-DSA-87 attestations, recipient withdrawals use native ML-DSA-65, and Quantus enforces the
reserve multisig. This covers application authorization; it does not cover NEAR consensus or signed swaps inside
Intents.

| Step | Who authorizes | Scheme |
|---|---|---|
| 1. Lock QTC on Quantus | the sender's Qlyphs wallet, into a native 2-of-3 multisig | ML-DSA-87 |
| Choose the destination on NEAR | the same wallet key, signing the exact route | ML-DSA-87 |
| 2. Mint on NEAR, straight into NEAR Intents | 2 of 3 attesters, verified on-chain by a contract that has no key | ML-DSA-87 |
| Recipient account control | a NEAR account whose only key, at the checked snapshot, is native | ML-DSA-65 |
| 3. Withdraw to Quantus | that account (`ft_withdraw`, `WITHDRAW_TO:`) | ML-DSA-65 |
| 4. Release from the Quantus lock | 2 of 3 attesters, enforced by Quantus's own multisig | ML-DSA-87 |

Payment requests are signed with ML-DSA-87 and encrypted with **ML-KEM-1024** for the one person who pays.

Test networks only: the Quantus test chain the Qlyphs app uses, and NEAR testnet. Unaudited prototype. Qlyphs
runs all three attester keys in one service: this demonstrates 2-of-3 post-quantum authorization, not
independent operators (see [what this is not](#what-this-is-and-is-not)).

## Check it yourself (read-only, a few minutes)

```sh
npm ci
node scripts/verify-route.mjs      # NEAR testnet       → evidence/route-onchain.json
node scripts/verify-quantus.mjs    # Quantus test chain → evidence/route-quantus.json
```

`verify-route.mjs` reads NEAR testnet and checks, among other things:
- the bridge and the Intents verifier have **no access key** and run the pinned code (and your own build, if
  you ran `scripts/build.sh`);
- for **every mint**, both **ML-DSA-87 attester signatures, verified again on your machine** against
  `deployments/route-attesters.json`;
- every withdrawal was signed with ML-DSA-65 by an account whose only key is ML-DSA-65, opened before its mint;
- every forged or replayed mint ever sent to a bridge was refused.

`verify-quantus.mjs` reads the Quantus test chain's public RPC and checks:
- the lock is a native multisig whose three signers and threshold of 2 it reads from chain state;
- **every mint is backed by a lock deposit of the same amount**: the deposit id is recomputed from the block hash,
  and that extrinsic dispatched successfully and emitted a transfer of exactly that amount to the lock;
- **for each NEAR redemption, a distinct successful release**: the lock's multisig executed exactly the transfer
  to the recorded destination for the recorded amount, its inner call succeeded, two distinct signers approved;
- the verified mints minus the redemptions equal the token's supply, and the lock's balance at a recorded block
  is at least that supply.

It does not establish that no other transfer ever left the lock, and it uses the Qlyphs test indexer only to find
a release extrinsic's block from its hash. Every mint and redemption, with links: **[docs/EVIDENCE.md](docs/EVIDENCE.md)**.

## Try it

**https://app-testnet.qlyphs.com/bridge/quantum** (the Qlyphs app on its test network)

- **Bridge.** Send QTC from Quantus to NEAR Intents and back. The page opens a fresh NEAR account whose only key
  is ML-DSA-65, held by your browser; your Qlyphs wallet approves the lock, then signs the exact destination.
  About two minutes later the QTC is inside NEAR Intents. Bringing it back is signed in the page with that
  account's ML-DSA-65 key, and two of three attesters release it on Quantus.
- **Request.** Ask someone for QTC. Their *pay link* holds their ML-KEM-1024 public key; your request is signed
  with ML-DSA-87 and sealed so that only they can open it. No wallet needed to make a request.
- **Pay.** Open a payment link: your browser decrypts the request, checks the sender's signature and the
  receiving account, then your wallet pays.

The picture beside the form follows each step live, with the scheme that signs it and a link to the
transaction. Bridging and paying need the Qlyphs wallet on its test network; making a request, opening a pay
link and the read-only checks above need nothing.

An account you already hold in **Meteor Wallet** can also receive, if its keys are exactly one ML-DSA-65
full-access key: open the page with `?meteor=1`. Experimental: the route delivers to such an account, named only by
the key handle NEAR lists (last row of [docs/EVIDENCE.md](docs/EVIDENCE.md), a stand-in account), but a round trip
approved in Meteor itself has not been recorded yet.

## Attack lab (live, NEAR testnet)

`node scripts/ops/attack-route.mjs` sends forged mints to the real bridge; each one must be refused
(`evidence/route-attacks.json`, with transaction links):

| # | Attack | Refused with |
|---|---|---|
| 1 | Replay a real mint | `deposit already minted` |
| 2 | Replay it with a changed amount | `deposit already minted` |
| 3 | Real signatures moved to a fresh deposit id | `invalid attestation signature` |
| 4 | A fresh deposit id plus a doubled amount | `invalid attestation signature` |
| 5 | A fresh deposit id plus another receiver | `invalid attestation signature` |
| 6 | A fresh deposit id, credited directly instead of into Intents | `invalid attestation signature` |
| 7 | One attester counted twice | `two different attesters are required` |
| 8 | A queued claim redirecting someone's deposit, without the depositor's key | `address(publicKey) is not the sender of the deposit` |
| 9 | A second attester service on the same state | `state directory is in use` |

One-field-at-a-time mutations of an unused attestation are in the sandbox: 46 refusals and edge cases in
`tests/bridge.sandbox.mjs`. Attester service: releases killed with SIGKILL after the proposal, the approval and
the paying execution each paid exactly once after restart (`evidence/route-crash-drills.json`).

## On-chain

| What | Where |
|---|---|
| Intents verifier, upstream `near/intents@32cd1f97`, unmodified, no key | [`intents.qlyphs-pqroute-b.testnet`](https://testnet.nearblocks.io/address/intents.qlyphs-pqroute-b.testnet) |
| Bridge token (current), no key | [`qtc-pq.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/qtc-pq.qlyphs-pqroute-a.testnet) |
| Relayer: pays gas for mints, no authority, ML-DSA-65 key only | [`relay.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/relay.qlyphs-pqroute-a.testnet) |
| Sponsor: opens recipients' accounts, ML-DSA-65 key only | [`qlyphs-pqroute-c.testnet`](https://testnet.nearblocks.io/address/qlyphs-pqroute-c.testnet) |
| The lock on the Quantus test chain: native 2-of-3 multisig of the three attester keys | `qzpPEKhGncdyaUgZSxY1zMq3VvB5ng5LmZBP4arD83PFp46jE` (`deployments/quantus-lock-curve.json`) |
| Earlier bridge tokens, kept for their records | [`qtcpq`](https://testnet.nearblocks.io/address/qtcpq.qlyphs-pqroute-a.testnet) (wrong Quantus genesis), [`pqqtc`](https://testnet.nearblocks.io/address/pqqtc.qlyphs-pqroute-a.testnet) (no minimum withdrawal), [`qtc`](https://testnet.nearblocks.io/address/qtc.qlyphs-pqroute-a.testnet) (Quantus development network) |

## Reproduce the code

```sh
bash scripts/build.sh                     # contracts (LLVM 19+); build/bridge-testnet.wasm is the deployed bridge, sha256 6c375c5b…
node tests/bridge.sandbox.mjs             # 46 checks: quorum, every signed field, one mint per deposit, Intents mode, minimum withdrawal, storage
node --test tests/route-crypto.unit.mjs   # sealing, tampering, pinned recipient, fresh accounts, restore
node --test tests/quantus-evidence.unit.mjs   # what verify-quantus accepts: real transfers; not remarks, failed inner calls, other extrinsics, duplicates
```

`tests/intents.sandbox.mjs` runs the bridge against the verifier, but the sandbox node that near-workspaces
ships is older than the verifier build, so that part runs on testnet (the evidence above).

## What is in this repository, and what is not

Qlyphs is a live product and its codebase is not open source. Everything the route needs to be checked is
published here.

- **Here:**
  - the bridge contract (`contract/bridge.c`);
  - the route cryptography (`sdk/route-crypto.mjs`);
  - the source of the `/bridge/quantum` page, with its tests ([app/](app/README.md));
  - the route service Worker (`route-worker/`: encrypted request mailbox, claim queue, account sponsor);
  - both verifiers and the attack lab;
  - the formats ([docs/ROUTE.md](docs/ROUTE.md)) and the evidence.
- **Not here:**
  - The attester service: deposit inspection, attestation, mint and release orchestration, journal and recovery.
    It runs the three attester keys, and it stays private.
  - The shared platform parts the page imports: UI kit, logos, and the connection to the Qlyphs wallet extension
    (listed in [app/README.md](app/README.md#not-included)).

  The attester service's formats are specified in [docs/ROUTE.md](docs/ROUTE.md). You can exercise it on the
  hosted app above, but you cannot run the whole route yourself from this repository.
- **What the verifiers prove:** the effects of that service on both chains (every mint, withdrawal, redemption and
  release listed in [docs/EVIDENCE.md](docs/EVIDENCE.md)), not its internal implementation.

## What this is, and is not

- **Trust.** Three separate ML-DSA-87 attester keys, all operated by Qlyphs in one service. This shows 2-of-3
  post-quantum authorization, not independent operators or decentralized custody. Two compromised attester keys
  could mint unbacked tokens or release the lock. The attesters check Quantus deposits themselves; NEAR does not
  verify Quantus consensus.
- **Confirmation.** The attesters sign a deposit 8 blocks deep (the demo policy), not at Quantus's default
  finality rule (100 blocks).
- **Scope.** User accounts, attestations and the lock are post-quantum. NEAR's validators and consensus, the RPC
  transport and the browser that holds a fresh account's key are outside that claim. Intents signed inside the
  verifier (swaps) still use classical schemes; this route does not change that.
- **Privacy.** Requests, notes and the link between a person and each fresh account are encrypted. Amounts,
  times and accounts are public on both chains, and the payer knows who they paid. A Meteor account is linked to
  its own history.
- **The existing route** serves users today. This is a separate test-network prototype. We do not claim that any
  partner uses or endorses it.

## Hackathon

Built for the NEAR HACKATHON (November 2026). Every commit in this repository was written after the hackathon was
announced on 2026-10-19 (first commit 2026-10-22): first an ML-DSA-87 vault ([docs/VAULT.md](docs/VAULT.md)) and an
admin-control prototype ([docs/GUARDIAN-README.md](docs/GUARDIAN-README.md)), then the route, which is the entry
([full history](../../commits)). The `/bridge/quantum` page ([app/](app/README.md)) was written for the route in
November. Pre-existing and not submitted: the rest of the Qlyphs app, the Qlyphs wallet on Quantus (which signs the
lock and the route), and the Quantus chain itself.

Commit dates can be rewritten, block times cannot. On NEAR testnet, the route's Intents verifier was created at
2026-11-08 21:35 UTC (block 276,831,137, tx `2iBeS7DWvjpczchycknGzSAcm9U2oemeedT1u4GhLGdg`). The bridge contract was
created at 2026-11-08 23:59 UTC (block 276,845,398, tx `3ciFNuoeFNPAn5aoUoauiNGvAmoTx9WZPyaYBGAcjJgD`). Every mint and
withdrawal in [docs/EVIDENCE.md](docs/EVIDENCE.md) came after that.

AI assistance: this repository was written with AI coding assistants (Claude Code and Pi Code), with ChatGPT 6 Pro
as security auditor and DeepSeek (uncensored), directed and reviewed by the author, who is responsible for it.

Thanks to Illia for the metal-framed *Attention Is All You Need* at qDays. It watched over the desk where this was built.

The bridge verifies ML-DSA-87 on-chain with its own freestanding C verifier (`core/pq87.c`, written after the
pq-crystals reference; see [THIRD_PARTY.md](THIRD_PARTY.md)). Built with [`near/intents`](https://github.com/near/intents) (unmodified verifier),
[`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) (ML-DSA-87, ML-KEM-1024),
[`@fastnear/ml-dsa-65`](https://www.npmjs.com/package/@fastnear/ml-dsa-65) and `@fastnear/api` (NEAR ML-DSA-65
keys and transactions), `@polkadot/api` (Quantus events and state), `@noble/hashes`, `@noble/ciphers`, `near-api-js` and `near-workspaces`.

## Docs

- [docs/ROUTE.md](docs/ROUTE.md): formats, trust model, privacy limits.
- [docs/EVIDENCE.md](docs/EVIDENCE.md): every round trip, step by step.
- [docs/PROPOSAL.md](docs/PROPOSAL.md): a draft interface any chain with a native ML-DSA multisig can use to plug
  into NEAR Intents.

MIT or Apache-2.0, at your option.
