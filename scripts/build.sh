#!/usr/bin/env bash
# Builds build/pq87_near.wasm: the core/ verifier plus the NEAR host glue, as MVP Wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
clang=${CLANG:-/opt/homebrew/opt/llvm/bin/clang}
export PATH="/opt/homebrew/opt/lld/bin:$PATH"
mkdir -p build
# -mcpu=mvp: no sign-ext, bulk-memory or reference types, which the NEAR runtime may reject.
"$clang" --target=wasm32 -mcpu=mvp -O2 -ffreestanding -fno-builtin -nostdlib -DQP_BENCH \
  -ffile-prefix-map="$PWD"=. -Icore \
  core/pq87.c core/freestanding.c contract/near.c \
  -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=262144 \
  -Wl,--initial-memory=1048576 -Wl,--max-memory=1048576 \
  -o build/pq87_near.wasm
shasum -a 256 build/pq87_near.wasm
