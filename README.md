# Qlyphs ML-DSA-87 vault on NEAR

A NEAR contract that verifies an **ML-DSA-87 signature (FIPS 204, the scheme Quantus uses) on-chain, in a
single call**, before it moves NEAR or NEP-141 tokens out of a vault. The vault account has no access key:
only a post-quantum signature from its owner can spend from it. Anyone can relay the signed payment and pay
the gas, but cannot change it.

It reuses, byte for byte, the C verifier of the Qlyphs Solana vault. Solana needs about 21 transactions per
verification. NEAR needs one call of about 7 Tgas, 2 % of the per-call limit.

**Status: research proof of concept. Not audited. No real funds.** Testnet only. Read
[SECURITY.md](SECURITY.md) for what this does and does not protect, and [docs/PROTOCOL.md](docs/PROTOCOL.md)
for the exact rules.

## What is shown, and where the proof is

| Claim | Evidence |
|---|---|
| Testnet: vault created by a keyless, audited factory; preflight passes; 0.1 NEAR and 0.05 wNEAR (`wrap.testnet`, a real NEP-141) paid by one ML-DSA-87 signature each; replay, tampered amount and foreign key refused on-chain | `evidence/vault-testnet.json` (every tx hash), `deployments/testnet.json` |
| Sandbox: 49 checks: factory creation, registry and refunds (failed creation, third-party refund, no double refund); the two attacks found in review (a vault made outside the factory, a vault planted by an earlier life of the factory id) refused by the preflight; every message-field refusal; u128 edge cases; exact `ft_transfer` arguments; failed-delivery refund | `evidence/vault-sandbox.json` |
| The verifier is the Solana POC's, unchanged | `core/SOURCE.sha256` |
| Relayer on testnet: a payment signed with noble (as the wallet will) relayed and followed to delivery; a repeat answered with the same hash and no second transaction; a tampered signature refused before any transaction | `evidence/relayer-testnet.json` |
| Verification alone costs 6.47 Tgas on testnet, one call, 9/9 vectors | `evidence/testnet.json`, `evidence/gas.json` |

Testnet accounts: factory `pq87-vaults-r2.qlyphs-grad-c48a-parent.testnet`, vault
`1decab283ca92482.pq87-vaults-r2.qlyphs-grad-c48a-parent.testnet`. Earlier deployments predate review
fixes and are not trusted: `pq87-vault.…` and `pq87-factory.…` (`deployments/superseded-testnet-r1.json`),
and `pq87-vaults.…`, whose factory refunded failed creations from its callback
(`deployments/superseded-testnet-r2.json`).

## How it works

1. The **factory** is created by one transaction with no `FunctionCall`, so it never had a key and nothing
   could be scheduled before its code ran. `auditFactoryCreation` checks that once per release.
2. `factory.create(public key)` with at least 0.25 NEAR records the vault in the factory's registry and
   creates it at an address derived from the key, in one atomic receipt: create, fund, deploy the vault
   code embedded in the factory, `init`. If creation fails, the record is marked failed and
   `refund`, which anyone may call, pays the recorded deposit back to the recorded caller.
3. Before signing, the wallet runs `checkVault`. At one final block it checks the pinned factory and its
   code, the registry record, the vault code, zero access keys on both, and that the vault storage is
   exactly the owner's key and a usable nonce.
4. The owner signs a 256-byte message: network, vault, NEAR or token, receiver, amount, nonce, validity
   window, `ft_transfer` gas.
5. Anyone calls `execute(signature ‖ message)`. The contract checks every field, verifies the signature,
   spends the nonce, then sends the NEAR or calls `ft_transfer` with 1 yoctoNEAR.

## Gas

| | Tgas (testnet) |
|---|---|
| `execute`, NEAR transfer | 6.98 |
| `execute`, NEP-141 transfer (plus the signed `ft_transfer` gas) | 7.07 |
| Signature verification alone | 6.47 |
| Of which ExpandA (8 rows of the matrix) | about 85 % |

At the minimum gas price a payment costs about 0.0007 NEAR. Gas is metered per Wasm instruction, so
re-measure on the target network after protocol upgrades.

## Relayer

`relayer/` is a small HTTP service that pays the gas for `execute`. It is untrusted transport: the vault
checks everything again, so a relayer can delay or drop a payment but never change it. Its own checks
exist so that it does not burn gas on requests the vault would refuse, and so it cannot be made to pay
twice for one authorization.

- `POST /execute`, raw body of exactly 4,883 bytes: signature (4,627) ‖ message (256). Answers
  `{"transaction": <hash>}` once RPC has accepted the transaction. That is not delivery.
- `GET /outcome/<hash>`: `submitted`, `accepted` (nonce spent), `delivered` (the Transfer or
  `ft_transfer` receipt succeeded), `failed` (refused, or the payment receipt failed), or `unknown`.
  A timeout is `unknown`, never `failed`.
- `GET /health`: network, factory, relayer account, spend so far and the cap.

Before any gas, in this order: strict parse of the message (`docs/PROTOCOL.md`), vault a direct child of
the pinned factory, `checkVault` at a final block, nonce equal to the vault's, window containing the final
height, and the ML-DSA-87 signature verified locally with `@noble/post-quantum` against the stored key.
Then quotas (per vault and per client address, counted only for valid signatures), then the spend cap.
It sends `execute` with 30 Tgas, or 30 Tgas plus the signed `ft_transfer` gas, and no deposit.

| File | Role |
|---|---|
| `server.mjs` | HTTP, body size cap, routes; `node relayer/server.mjs` starts it |
| `config.mjs` | environment, testnet-only guard |
| `message.mjs` | strict parsing of the request |
| `chain.mjs` | vault key, `checkVault`, final height |
| `signature.mjs` | local ML-DSA-87 verification |
| `ledger.mjs` | idempotence by message hash and (vault, nonce) |
| `limits.mjs` | quotas, spend cap, bounded queue |
| `submitter.mjs` | signs and sends `execute` |
| `outcome.mjs` | reads a final outcome |
| `relay.mjs` | the order of the checks |

Environment: `RELAYER_ACCOUNT` and `RELAYER_KEY_FILE` (one line, `ed25519:<base58>`), `HOST` (default
`127.0.0.1`), `PORT` (8787), `NEAR_RPC`, `RELAYER_SPEND_CAP_YOCTO` (default 0.3 NEAR of prepaid gas),
`RELAYER_GAS_PRICE_YOCTO` (1e9, the testnet prepaid price), `RELAYER_VAULT_PER_HOUR` (10),
`RELAYER_IP_PER_HOUR` (30), `RELAYER_CONCURRENCY` (4), `RELAYER_QUEUE` (32). It refuses to start unless the
pinned deployment is testnet (`RELAYER_ALLOW_NETWORK` must name any other network explicitly).

## Layout

- `core/`: the ML-DSA-87 verifier, byte-identical to the Solana POC.
- `contract/vault.c`: the vault. `contract/factory.c`: the factory. Raw NEAR host ABI in C, no Rust.
- `contract/near.c`: the gas-measurement contract (`verify`, `verify_profile`, `bench`), never a vault.
- `relayer/`: the gas relayer (see above) and its unit tests.
- `sdk/vault.mjs`: message encoding, a local OpenSSL test signer, `checkVault`, `auditFactoryCreation`.
- `tests/`: sandbox suite, testnet runs, a test-only NEP-141 stand-in (`mock_ft.c`).
- `deployments/testnet.json`: the pinned testnet release (factory id, code hashes, factory creation tx).

## Reproduce

Requirements: Homebrew `llvm` and `lld` (Apple clang has no Wasm target), Node 20+, OpenSSL ≥ 3.5.

```bash
npm install
(cd node_modules/near-sandbox && node install.js)   # official nearcore sandbox binary
bash scripts/build.sh                               # prints every wasm sha256
export NEAR_SANDBOX_BIN_PATH=$PWD/node_modules/near-sandbox/bin/near-sandbox
node tests/vault.sandbox.mjs                        # 45 checks
node tests/measure.mjs                              # verification gas profile
node --test relayer/                                # relayer unit tests
```

Testnet (needs two funded testnet accounts; the owner key file is created if absent):

```bash
PARENT_ACCOUNT=<id> PARENT_KEY_FILE=<file> RELAYER_ACCOUNT=<id> RELAYER_KEY_FILE=<file> \
  OWNER_KEY_FILE=<file.pem> node tests/vault.testnet.mjs

# relayer, end to end against the pinned deployment (the owner's vault must exist and hold NEAR)
RELAYER_ACCOUNT=<id> RELAYER_KEY_FILE=<file> OWNER_KEY_FILE=<file.pem> node tests/relayer.testnet.mjs
```

## Not done yet

- An audit, and NIST ACVP vectors (the vectors here come from OpenSSL).
- Signing in the Qlyphs wallet (today a local OpenSSL key signs).
- Moving NFTs, multi-tokens or calling `ft_transfer_call` from a vault.
- A mainnet release.
