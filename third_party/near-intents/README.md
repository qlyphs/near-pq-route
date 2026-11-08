# NEAR Intents verifier (upstream, unmodified)

`defuse-32cd1f97.wasm` is the verifier contract from https://github.com/near/intents at commit
`32cd1f97` ("fix(verifier): make `simulate_intents()` cache zero balances (#389)"), built with
cargo-near 0.23.0 and Rust 1.97.1:

```sh
git clone https://github.com/near/intents && cd intents && git checkout 32cd1f97
cd contracts/defuse && cargo near build non-reproducible-wasm --locked --no-abi --features contract
```

This is a non-reproducible build, so another machine may produce different bytes; the hash in
`SHA256SUMS` is the one deployed on testnet. The source is used as published: no change.
There is no official Intents deployment on NEAR testnet, so the route runs against this one.
