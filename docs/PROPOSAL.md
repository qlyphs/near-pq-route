# Draft proposal: post-quantum authorized routes for NEAR Intents

Status: draft for discussion, by the Qlyphs team. Not a NEP, not adopted by anyone. A working prototype is in
this repository (`contract/bridge.c`, `docs/ROUTE.md`, `scripts/verify-route.mjs`).

## Problem

NEAR accounts can hold ML-DSA-65 keys since protocol 88, and chains such as Quantus sign every transaction with
ML-DSA. The routes that carry their assets into NEAR Intents are still authorized classically. For example, the
token that represents QTC on NEAR mainnet is minted by an account whose only key is one ed25519 key
(`evidence/bridge-mng-snapshot.json`). NEAR's roadmap names threshold ML-DSA signing as research, and
post-quantum verification of foreign chains as 2027 work. A user can hold QTC post-quantum on Quantus and on
NEAR, and still depend on one classical key in between.

## Proposal

For chains whose native accounts support an ML-DSA multisig, a route can be fully post-quantum **today**,
without threshold ML-DSA and without new host functions:

1. **Custody on the source chain:** a native k-of-n multisig of route operators, each with its own ML-DSA key.
   The quorum is enforced by the source chain itself, so no key needs to be split.
2. **Minting on NEAR:** a keyless NEP-141 token contract that mints only on k-of-n ML-DSA-87 operator
   attestations, verified on-chain (about 7 Tgas per signature in this prototype). Each source deposit id mints
   at most once, recorded before crediting.
3. **The Intents interface, unchanged:** the token can mint straight into the verifier for a receiver
   (`ft_on_transfer` with the receiver as message, like a PoA deposit). It burns on `ft_transfer` to itself with
   memo `WITHDRAW_TO:<destination>`, so the verifier's existing `ft_withdraw` works as it does for PoA tokens.
4. **Withdrawal authority:** the holder's NEAR account signs `ft_withdraw` with its native ML-DSA-65 key.
5. **Release on the source chain:** the operators read finalized burn records and release through the native
   multisig, journaled per burn id so a restart never pays twice.

## Interface (what another chain would implement)

- Attestation: 288 bytes, ML-DSA-87 with context `qlyphs/near-bridge/v1`. It binds the NEAR network, the token
  account, the source genesis, the deposit id, the raw amount, the receiver, the receipt commitment and the
  mint mode. Layout in `docs/ROUTE.md`.
- Token methods beyond NEP-141: `mint(binary attestation bundle)`, `deposit({deposit_id})`, `redemption({id})`,
  `state()`, `receipts({from, limit})`.
- Deployment rule: the token is created, deployed and initialized in one batch by its parent and never holds
  an access key, so its code and its operator keys cannot change.

## What it does not solve

- The operators are trusted as a k-of-n quorum: two compromised operators can mint unbacked tokens or release
  the reserve. Light-client verification of the source chain would remove that, and it is out of scope here.
- Chains without native ML-DSA multisig (Bitcoin, Ethereum) still need threshold ML-DSA or another design.
- Intents signed inside the verifier (swaps, transfers between Intents accounts) still use classical schemes. A
  verifier-side ML-DSA signing standard would be the natural next proposal.

## Open questions for the NEAR Intents team

1. Would a route token that mints into the verifier this way be acceptable in listings (1Click), next to PoA routes?
2. Should the attestation format be shared across routes, so that solvers and explorers can verify mints themselves?
3. Is there interest in ML-DSA-65 as a signing standard inside the verifier, so that intents themselves are post-quantum?
