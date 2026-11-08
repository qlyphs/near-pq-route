# Qlyphs: a post-quantum route for NEAR Intents

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

It reads NEAR testnet and checks 17 things. Among them:
- the bridge and the Intents verifier have **no access key** and run the published code;
- the relayer's only key is ML-DSA-65;
- for **every mint**, it fetches the transaction, decodes the attestation and **verifies both ML-DSA-87
  signatures on your machine** against the attester keys in `deployments/route-attesters.json`;
- every withdrawal from Intents was signed with ML-DSA-65 by an account whose only key is ML-DSA-65.

Its output is `evidence/route-onchain.json`.

## Try it in the app

`/bridge/quantum` in the Qlyphs app (test network build, pull request #353 of the app; the hosted address is in
`docs/hackathon/SUBMISSION.md`):

1. **Request.** Paste the payer's route card and an amount. Your browser makes a fresh ML-DSA-65 NEAR account
   for this payment, signs the request with ML-DSA-87 and seals it to the payer with ML-KEM-1024.
2. **Pay.** The payer opens the link. Their Qlyphs wallet sends the QTC to the 2-of-3 lock, then signs the
   route: a site session whose nonce is SHA-256 of the exact destination. About two minutes later the QTC is
   inside NEAR Intents for the recipient.
3. **My payments.** From the backup alone, the browser reads every public receipt, keeps the ones it can open,
   and withdraws from NEAR Intents to a Quantus address with that payment's ML-DSA-65 key.

## On-chain evidence (NEAR testnet)

| What | Where |
|---|---|
| Intents verifier, upstream `near/intents@32cd1f97`, unmodified, no key | [`intents.qlyphs-pqroute-b.testnet`](https://testnet.nearblocks.io/address/intents.qlyphs-pqroute-b.testnet) |
| Bridge token for the Qlyphs app's test chain, no key | [`pqqtc.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/pqqtc.qlyphs-pqroute-a.testnet) |
| Bridge token for the Quantus development network, no key | [`qtc.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/qtc.qlyphs-pqroute-a.testnet) |
| Relayer, ML-DSA-65 key only (pays gas, no authority) | [`relay.qlyphs-pqroute-a.testnet`](https://testnet.nearblocks.io/address/relay.qlyphs-pqroute-a.testnet) |
| A full round trip from the app (request, pay, mint into Intents, ML-DSA-65 withdrawal, 2-of-3 release) | `evidence/route-app-run-1.json` |
| Full round trips from the command line, on both Quantus test chains | `evidence/route-cycle-curve.json`, `evidence/route-cycle-devnet.json` |
| The existing route's minting key, at a pinned mainnet block | `evidence/bridge-mng-snapshot.json` |

## Reproduce the code

```sh
bash scripts/build.sh                 # contracts (LLVM 19+); build/bridge-testnet.wasm is the deployed bridge
node tests/bridge.sandbox.mjs         # 34 checks: quorum, every signed field, one mint per deposit, receipts, Intents mode, redeem
node --test tests/route-crypto.unit.mjs   # 10 tests: sealing, tampering, fresh accounts, restore from the seed
```

`tests/intents.sandbox.mjs` runs the bridge against the verifier, but the sandbox node that near-workspaces
ships is older than the verifier build, so that part runs on testnet (the evidence above). The attester
service is in a separate repository; its formats are in [docs/ROUTE.md](docs/ROUTE.md).

## What this is, and is not

- **Trust.** The demo uses three separately keyed signer processes, all operated by the Qlyphs team. It
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
