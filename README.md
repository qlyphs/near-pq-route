# ML-DSA-87 verification on NEAR (gas spike)

Can a NEAR contract verify an ML-DSA-87 signature (FIPS 204, the scheme Quantus uses) on-chain, and at
what cost? This spike answers that with the same C verifier as the Solana vault POC, compiled to Wasm.

**Status: research spike. Not a vault, not audited, no real funds.**

## Result

| | NEAR testnet | Local sandbox (nearcore 2.6.2) |
|---|---|---|
| Full verification, one function call | **6.47 Tgas** (whole tx 6.80 Tgas) | 6.50 Tgas (tx 7.17 Tgas) |
| Share of the 300 Tgas call limit | ~2 % | ~2 % |
| Vectors (1 valid, 8 invalid) | 9/9 | 9/9 |
| Contract size | 14,591 bytes | same bytes |

The whole verification fits in a single call, with no session, no relay splitting and no extra
transactions: one signed payload, one receipt, about 1–2 s to finality. At the minimum gas price
(100 Mgas price, 10⁻⁴ NEAR per Tgas) one verification costs about 0.0007 NEAR.

Cost breakdown (sandbox, cumulative Tgas inside the call, `verify_profile`):

| Stage | Tgas |
|---|---|
| Input read and parse | 0.08 |
| Hint check, challenge, μ = H(tr ‖ M′) | 0.33 |
| Seven z polynomials, decode, norm check, NTT | 0.51 |
| Eight rows of Az − c·t₁ (ExpandA dominates, ~0.61 per row) | 4.89 |
| **Total** | **5.81** (+ host-call overhead = 6.5) |

Primitives (`bench`, one call each, minus the empty-call baseline): Keccak-f[1600] ≈ 0.008 Tgas,
one ExpandA entry ≈ 0.053, NTT ≈ 0.048, inverse NTT ≈ 0.056, SHAKE256 over a 2,592-byte key ≈ 0.19.

Testnet contract `pq87-spike.qlyphs-grad-c48a-parent.testnet`, deploy tx
`696LKVe5rXryvDraJWpFW5kCRW3qhFHYzwKFv9mCagtC`. Every vector's transaction hash is in
`evidence/testnet.json`; sandbox numbers are in `evidence/gas.json`.

## What this does and does not show

- It shows that the verifier runs unchanged on NEAR's Wasm runtime and accepts and refuses the same
  vectors as on the host and on Solana.
- The vectors come from OpenSSL 3.5 (`fixtures/vectors.json`, copied from the Solana POC). They are not
  the NIST ACVP set.
- `contract/near.c` only verifies. It holds no funds, keeps no nonce, binds no domain and moves nothing.
  A vault needs those, plus account locking (no full-access key on the vault account).
- Gas is metered per Wasm instruction, so these numbers move with NEAR protocol upgrades. Re-measure on
  the target network before relying on a figure.

## Layout

- `core/`: the verifier, byte-identical to the Solana POC (`core/SOURCE.sha256`).
- `contract/near.c`: raw NEAR host ABI glue, three methods: `verify`, `verify_profile`, `bench`.
- `tests/measure.mjs`: local sandbox run, writes `evidence/gas.json`.
- `tests/testnet.mjs`: testnet deploy and run, writes `evidence/testnet.json`.

## Reproduce

Requirements: Homebrew `llvm` and `lld` (Apple clang has no Wasm target), Node 20+.

```bash
npm install
(cd node_modules/near-sandbox && node install.js)   # downloads the official nearcore sandbox
bash scripts/build.sh                               # prints the wasm sha256
NEAR_SANDBOX_BIN_PATH=$PWD/node_modules/near-sandbox/bin/near-sandbox node tests/measure.mjs
```

Testnet (needs a funded testnet account):

```bash
NEAR_RPC=https://test.rpc.fastnear.com PARENT_ACCOUNT=<id> PARENT_KEY_FILE=<file> \
  SPIKE_KEY_FILE=<file> node tests/testnet.mjs
```
