#!/bin/sh
# Compile yin.c to a freestanding WebAssembly module.
#
# No Emscripten, no Rust, no wasm-bindgen — clang has a wasm32 backend and
# wasm-ld built in. The result imports nothing and has no runtime, which is
# why it comes out under 2 KB.
#
# Requires: clang 15+ and wasm-ld (Debian/Ubuntu: apt install clang lld,
#           macOS: brew install llvm  -> use $(brew --prefix llvm)/bin/clang)
set -e
cd "$(dirname "$0")"

clang --target=wasm32 -O3 -nostdlib -ffreestanding \
      -Wall -Wextra \
      -Wl,--no-entry \
      -Wl,--export-dynamic \
      -Wl,--initial-memory=131072 \
      -o yin.wasm yin.c

echo "built yin.wasm ($(wc -c < yin.wasm) bytes)"
