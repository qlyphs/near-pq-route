#!/usr/bin/env bash
# Builds build/vault-<chain>.wasm and build/factory-<chain>.wasm (sandbox, testnet, mainnet) and build/pq87_near.wasm (gas spike), as MVP Wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
clang=${CLANG:-/opt/homebrew/opt/llvm/bin/clang}
export PATH="/opt/homebrew/opt/lld/bin:$PATH"
mkdir -p build
# -mcpu=mvp: no sign-ext, bulk-memory or reference types, which the NEAR runtime may reject.
cflags=(--target=wasm32 -mcpu=mvp -O2 -ffreestanding -fno-builtin -nostdlib -Wall -Wextra -Werror
  -Wno-unused-parameter -ffile-prefix-map="$PWD"=. -Icore)
ldflags=(-Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=262144
  -Wl,--initial-memory=1048576 -Wl,--max-memory=1048576)

"$clang" "${cflags[@]}" -DQP_BENCH core/pq87.c core/freestanding.c contract/near.c "${ldflags[@]}" -o build/pq87_near.wasm
for chain in sandbox testnet mainnet; do
  "$clang" "${cflags[@]}" -DQP_CHAIN="\"$chain\"" core/pq87.c core/freestanding.c contract/vault.c \
    "${ldflags[@]}" -o "build/vault-$chain.wasm"
  "$clang" "${cflags[@]}" -DQP_CHAIN="\"$chain\"" core/pq87.c core/freestanding.c contract/guardian.c \
    "${ldflags[@]}" -o "build/guardian-$chain.wasm"
  # The factory embeds the exact vault bytes it deploys (#embed, C23).
  "$clang" "${cflags[@]}" -std=c23 --embed-dir=build -DQP_CHAIN="\"$chain\"" -DVAULT_WASM="\"vault-$chain.wasm\"" \
    core/freestanding.c contract/factory.c "${ldflags[@]}" -o "build/factory-$chain.wasm"
done
# Test-only Guardian whose settlement callback always fails (unresolved-execution test). Sandbox only.
"$clang" "${cflags[@]}" -DQP_CHAIN='"sandbox"' -DFAIL_CALLBACK core/pq87.c core/freestanding.c contract/guardian.c \
  "${ldflags[@]}" -o build/guardian-sandbox-failing-callback.wasm
# Guardian reference target, V1 and V2, plus a V2 whose migrate always fails (rollback test).
for v in 1 2; do
  "$clang" "${cflags[@]}" -DTOKEN_VERSION=$v core/freestanding.c contract/token.c "${ldflags[@]}" -o "build/token-v$v.wasm"
done
"$clang" "${cflags[@]}" -DTOKEN_VERSION=2 -DFAIL_MIGRATE core/freestanding.c contract/token.c "${ldflags[@]}" -o build/token-v2-failing.wasm
# Maximum-size (131,072-byte) V2 builds for upgrade tests: the reviewed V2 and the failing V2, padded with a custom section.
node scripts/pad-wasm.mjs build/token-v2.wasm build/token-v2-max.wasm 131072
node scripts/pad-wasm.mjs build/token-v2-failing.wasm build/token-v2-failing-max.wasm 131072
# Test-only NEP-141 stand-in for the sandbox suite.
"$clang" "${cflags[@]}" tests/mock_ft.c "${ldflags[@]}" -o build/mock_ft.wasm
shasum -a 256 build/*.wasm
node scripts/check-exports.mjs
