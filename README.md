# Qlyphs: a post-quantum route for NEAR Intents

**0 classical keys in the authorization path · 55/55 on-chain checks you can rerun · 7/7 live attacks refused.**

**QTC enters and leaves NEAR Intents with no classical key in the authorization path.** QTC is the coin of
Quantus, a chain that signs every transaction with ML-DSA. Today the route that brings it to NEAR mints on the
word of one ed25519 key. On this route, every authorization is post-quantum:

| Step | Who authorizes | Scheme |
|---|---|---|
| Lock QTC on Quantus | the payer's Qlyphs wallet | ML-DSA-87 |
| Choose the destination on NEAR | the same key, signing the route | ML-DSA-87 |
| Mint on NEAR, straight into NEAR Intents | 2 of 3 attesters, verified on-chain by a keyless contract | ML-DSA-87 |
| Withdraw from NEAR Intents to Quantus | the recipient's NEAR account, whose only key is native | ML-DSA-65 |
| Release from the Quantus lock | 2 of 3 attesters, enforced by Quantus's native multisig | ML-DSA-87 |

Payment requests and receipts are encrypted with **ML-KEM-1024**: the recipient gets a fresh NEAR account
for every payment and finds them all again from one backup.

Test networks only (the Quantus test chain the Qlyphs app uses, and NEAR testnet). Unaudited prototype.

## Check it yourself (2 minutes, read-only)

```sh
npm ci
node scripts/verify-route.mjs
```

It reads NEAR testnet and checks 55 things. Among them:
- the bridge and the Intents verifier have **no access key** and run the published code;
- the relayer's and the sponsor's only key is ML-DSA-65;
- every forged or replayed mint ever sent to a bridge was refused;
- for **every mint**, it fetches the transaction, decodes the attestation and **verifies both ML-DSA-87
  signatures on your machine** against the attester keys in `deployments/route-attesters.json`;
- every withdrawal from Intents was signed with ML-DSA-65 by an account whose only key is ML-DSA-65.

Its output is `evidence/route-onchain.json`.

## Try it in the app

`/bridge/quantum` in the Qlyphs app, test network build: **https://qlyphs-pqroute-app.qlyphs.workers.dev/bridge/quantum**
(Request and My payments work there in any browser; the payer's Qlyphs wallet connects only on the app's own test
address, app-testnet.qlyphs.com, once this page ships there):

1. **Request.** Paste the payer's route card and an amount. Your browser derives a fresh ML-DSA-65 key, has the
   sponsor open its NEAR account with only that key, signs the request with ML-DSA-87 and seals it to the payer
   with ML-KEM-1024.
2. **Pay.** The payer pins the recipient's card, opens the link, and the page checks the account has only the
   requested key. Their Qlyphs wallet sends the QTC to the 2-of-3 lock, then signs the
   route: a site session whose nonce is SHA-256 of the exact destination. About two minutes later the QTC is
   inside NEAR Intents for the recipient.
3. **My payments.** From the backup alone, the browser reads every public receipt, keeps the ones it can open,
   and withdraws from NEAR Intents to a Quantus address with that payment's ML-DSA-65 key.

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

Live attacks 3 to 6 change the deposit id so the contract reaches its signature check; one-field-at-a-time
mutations of an unused attestation are in the sandbox: 46 refusals and edge cases in `tests/bridge.sandbox.mjs`. Attester service: fault injection shows a
crash after a proposal or an approval reached the chain still pays exactly once.

## On-chain evidence (NEAR testnet)

| What | Where |
|---|---|
| Intents verifier, upstream `near/intents@32cd1f97`, unmodified, no key | [`intents.qlyphs-pqroute-b.testnet`](https://testnet.nearblocks.io/address/intents.qlyphs-pqroute-b.testnet) |
| Bridge token for the Qlyphs app's test chain, no key (current) | [`qtc-pq.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/qtc-pq.qlyphs-pqroute-a.testnet) |
| Earlier bridge token (its attestations named the wrong Quantus genesis) | [`qtcpq.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/qtcpq.qlyphs-pqroute-a.testnet) |
| Earlier bridge token, before the contract enforced the minimum withdrawal | [`pqqtc.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/pqqtc.qlyphs-pqroute-a.testnet) |
| Bridge token for the Quantus development network, no key | [`qtc.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/qtc.qlyphs-pqroute-a.testnet) |
| Relayer, ML-DSA-65 key only (pays gas, no authority) | [`relay.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/relay.qlyphs-pqroute-a.testnet) |
| Sponsor that opens recipients' accounts, ML-DSA-65 key only | [`qlyphs-pqroute-c.testnet`](https://testnet.nearblocks.io/address/qlyphs-pqroute-c.testnet) |
| A round trip through the app, every step in a browser: encrypted request, payment approved in the Qlyphs wallet extension (testnet build, fresh test wallet), found from the route backup, ML-DSA-65 withdrawal, 2-of-3 release | `evidence/route-app-run.json` |
| Releases killed with SIGKILL after the proposal, the approval, and the payment-bearing execution were sent: each paid exactly once after restart | `evidence/route-crash-drills.json` |
| Full round trips from the command line (earlier deployments, on both Quantus test chains) | `evidence/superseded-route-cycle-curve-r2.json`, `evidence/route-cycle-devnet.json` |
| The existing route's minting key, at a pinned mainnet block | `evidence/bridge-mng-snapshot.json` |

## Reproduce the code

```sh
bash scripts/build.sh                 # contracts (LLVM 19+); build/bridge-testnet.wasm is the deployed bridge
node tests/bridge.sandbox.mjs         # 46 checks: quorum, every signed field, one mint per deposit, receipts, Intents mode, minimum withdrawal, NEP-145 storage
node --test tests/route-crypto.unit.mjs   # 13 tests: sealing, tampering, pinned recipient, validation, fresh accounts, restore
```

`tests/intents.sandbox.mjs` runs the bridge against the verifier, but the sandbox node that near-workspaces
ships is older than the verifier build, so that part runs on testnet (the evidence above). The attester
service is in a separate repository; its formats are in [docs/ROUTE.md](docs/ROUTE.md).

## What this is, and is not

- **Confirmation.** The attesters sign a deposit once it is 8 blocks deep on the test chain's best chain (the
  demo policy). That is a confirmation depth, not Quantus's default finality rule (100 blocks).
- **Trust.** The demo uses three separate ML-DSA-87 attester keys, all operated by the Qlyphs team in one service. It
  demonstrates 2-of-3 post-quantum authorization, not independent operators or decentralized custody. The
  attesters check Quantus deposits themselves; NEAR does not verify Quantus consensus.
- **Scope.** User accounts, attestations and the lock are post-quantum. NEAR's validators and consensus, and
  the RPC transport, are not.
- **Privacy.** Requests, notes and the link between a recipient and each fresh account are encrypted.
  Amounts, times and accounts are public on both chains, and the payer knows who they paid.
- **NEAR Intents.** Deposits and withdrawals run on the unmodified upstream verifier. Intents signed inside the
  verifier (swaps) still use classical schemes today; this route does not change that.
- **The existing route** already serves users. This is a separate test-network prototype of quorum-enforced
  post-quantum authorization. We do not claim that any partner uses or endorses it.

## Docs

- [docs/ROUTE.md](docs/ROUTE.md): formats, trust model, privacy limits.
- [docs/PROPOSAL.md](docs/PROPOSAL.md): a draft interface any post-quantum chain can use to plug into NEAR Intents.
- [docs/GUARDIAN-README.md](docs/GUARDIAN-README.md): the earlier admin-control prototype this repository started from.

MIT or Apache-2.0, at your option.
