# Third-party code and attribution

- `core/` is the ML-DSA-87 verifier. It was written in October 2026, before the hackathon, for an earlier Qlyphs
  prototype of the same verifier on Solana, which is why its comments mention SBF, the Solana virtual machine. It
  is reused here unchanged (hashes in `core/SOURCE.sha256`). The files that existed only for Solana are not in this
  repository: the Solana ABI headers and linker script, the Keccak round generator and the test-vector generator.
  - `core/pq87.c` follows FIPS 204 and the structure of the pq-crystals reference (commit
    `d35ba3fe5449bee3e6d43e1f296c3ca818bd36be`, public domain / CC0, Apache-2.0 or GPL-2.0; the public-domain
    option is used).
  - The zetas (`core/zetas.inc`) are generated mathematically.
  - The Keccak rounds (`core/keccak_round.inc`) were generated from the FIPS 202 round definition.
  - The verifier is checked against the vectors in `fixtures/vectors.json`.
- `third_party/near-intents/` pins the unmodified `near/intents` verifier wasm the route deploys (commit
  `32cd1f97`, checksums in `SHA256SUMS`).
- The Guardian demo Worker (`demo/`) bundles three libraries, all MIT, by Paul Miller:
  - `@noble/post-quantum` 0.7.1, for ML-DSA-87 signing by the demo signers;
  - `@noble/curves` 1.8.1, for ed25519;
  - `@noble/hashes` 1.7.1.
- The tests use `near-workspaces` and `near-api-js` (MIT/Apache-2.0). They are not redistributed.

Original files in this repository are MIT unless a header says otherwise.
