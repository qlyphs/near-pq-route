#!/usr/bin/env bash
# Builds every contract (vault, factory, Guardian, reference token) as MVP Wasm, prints their SHA-256 and checks the
# release exports. Toolchain: LLVM clang and wasm-ld 19 or later (C23 #embed). The accepted release hashes in
# deployments/ were produced with LLVM 23.1.4; another LLVM version builds working contracts but may not
# reproduce those bytes. Override with CLANG=<clang> and WASM_LD_DIR=<folder holding wasm-ld>.
set -euo pipefail
cd "$(dirname "$0")/.."
find_tool() { for c in "$@"; do if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return; fi; done; }
clang=${CLANG:-$(find_tool /opt/homebrew/opt/llvm/bin/clang clang-23 clang-22 clang-21 clang-20 clang-19 clang)}
[ -n "$clang" ] || { echo "no clang found: install LLVM 19+ or set CLANG" >&2; exit 1; }
ld_dir=${WASM_LD_DIR:-$(dirname "$(find_tool /opt/homebrew/opt/lld/bin/wasm-ld wasm-ld-23 wasm-ld-22 wasm-ld-21 wasm-ld-20 wasm-ld-19 wasm-ld)" 2>/dev/null || true)}
[ -n "$ld_dir" ] && [ -x "$ld_dir/wasm-ld" ] || { echo "no wasm-ld found: install lld 19+ or set WASM_LD_DIR" >&2; exit 1; }
export PATH="$ld_dir:$PATH"
major=$("$clang" -dumpversion | cut -d. -f1)
[ "$major" -ge 19 ] || { echo "clang $major is too old: #embed needs 19+" >&2; exit 1; }
echo "toolchain: $("$clang" --version | head -1); $("$ld_dir/wasm-ld" --version | head -1)"
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
