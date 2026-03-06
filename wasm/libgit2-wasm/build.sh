#!/bin/bash
# Build libgit2 as a static library for wasm32-wasi using zig cc
# Uses WASI target for libc headers (sys/types.h, string.h, etc.)
# Actual I/O is handled by host imports, not WASI syscalls
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIBGIT2="$SCRIPT_DIR/../../deps/libgit2"
OUT="$SCRIPT_DIR/out"
SHIM="$SCRIPT_DIR"

rm -rf "$OUT"
mkdir -p "$OUT/obj"

CC="zig cc"
AR="zig ar"
TARGET="--target=wasm32-wasi"

CFLAGS=(
    $TARGET
    -O2
    -DWASM_BUILD=1
    -D_GNU_SOURCE
    -D_WASI_EMULATED_SIGNAL
    -D_WASI_EMULATED_MMAN
    -D_WASI_EMULATED_PROCESS_CLOCKS

    # libgit2 feature flags — minimal config for WASM
    -DGIT_SHA1_BUILTIN=1
    -DGIT_SHA256_BUILTIN=1
    -DGIT_COMPRESSION_BUILTIN=1
    -DGIT_REGEX_BUILTIN=1
    -DGIT_HTTPPARSER_BUILTIN=1
    -DGIT_ARCH_32=1
    -DSHA1DC_NO_STANDARD_INCLUDES=1
    '-DSHA1DC_CUSTOM_INCLUDE_SHA1_C="git2_util.h"'
    '-DSHA1DC_CUSTOM_INCLUDE_UBC_CHECK_C="git2_util.h"'

    # pcre config
    -DHAVE_CONFIG_H

    # Disable features that need OS support
    -DNO_MMAP
    -DGIT_IO_SELECT=1

    # Include paths (our shim dir first to override headers)
    -I"$OUT"
    -I"$SHIM"
    -I"$LIBGIT2/include"
    -I"$LIBGIT2/src/util"
    -I"$LIBGIT2/src/libgit2"
    -I"$LIBGIT2/deps/pcre"
    -I"$LIBGIT2/deps/zlib"
    -I"$LIBGIT2/deps/xdiff"
    -I"$LIBGIT2/deps/llhttp"

    # Suppress warnings in third-party code
    -Wno-implicit-function-declaration
    -Wno-int-conversion
    -Wno-incompatible-pointer-types
    -Wno-builtin-requires-header
    -Wno-implicit-int
    -Wno-unused-parameter
    -Wno-sign-compare
)

# Copy our features header where libgit2 expects it
cp "$SHIM/git2_features.h" "$OUT/git2_features.h"

# Generate pcre config.h in the pcre source directory
cp "$SHIM/pcre_config.h" "$LIBGIT2/deps/pcre/config.h"

echo "=== Compiling libgit2 for wasm32 ==="

compile_file() {
    local src="$1"
    local obj="$OUT/obj/$(basename "$src" .c).o"
    echo "  CC $src"
    $CC "${CFLAGS[@]}" -c "$src" -o "$obj" 2>&1
}

# === Bundled dependencies ===

echo "--- zlib ---"
for f in "$LIBGIT2"/deps/zlib/*.c; do
    compile_file "$f"
done

echo "--- pcre ---"
for f in "$LIBGIT2"/deps/pcre/*.c; do
    compile_file "$f"
done

echo "--- xdiff ---"
for f in "$LIBGIT2"/deps/xdiff/*.c; do
    compile_file "$f"
done

echo "--- llhttp ---"
for f in "$LIBGIT2"/deps/llhttp/*.c; do
    compile_file "$f"
done

# === util layer ===

echo "--- util ---"
for f in "$LIBGIT2"/src/util/*.c; do
    # Skip posix.c — our posix_shim.c provides WASM-compatible replacements
    case "$(basename "$f")" in
        posix.c) continue ;;
    esac
    compile_file "$f"
done

# util allocators
compile_file "$LIBGIT2/src/util/allocators/stdalloc.c"
compile_file "$LIBGIT2/src/util/allocators/failalloc.c"

# SHA1 — collision-detecting builtin
echo "--- sha1 (collision-detect) ---"
compile_file "$LIBGIT2/src/util/hash/collisiondetect.c"
for f in "$LIBGIT2"/src/util/hash/sha1dc/*.c; do
    compile_file "$f"
done

# SHA256 — builtin (rfc6234)
echo "--- sha256 (rfc6234) ---"
compile_file "$LIBGIT2/src/util/hash/builtin.c"
for f in "$LIBGIT2"/src/util/hash/rfc6234/*.c; do
    compile_file "$f"
done

# Unix platform — only realpath (skip process.c and map.c which need signals/mmap)
echo "--- unix platform ---"
compile_file "$LIBGIT2/src/util/unix/realpath.c"

# === libgit2 core ===

echo "--- libgit2 core ---"
for f in "$LIBGIT2"/src/libgit2/*.c; do
    compile_file "$f"
done

# Transports — only local transport, skip ssh/http/winhttp
echo "--- transports (local only) ---"
compile_file "$LIBGIT2/src/libgit2/transports/local.c"
compile_file "$LIBGIT2/src/libgit2/transports/auth.c"
compile_file "$LIBGIT2/src/libgit2/transports/credential.c"
compile_file "$LIBGIT2/src/libgit2/transports/credential_helpers.c"

# Streams — registry only (no TLS/socket)
echo "--- streams (registry only) ---"
compile_file "$LIBGIT2/src/libgit2/streams/registry.c"

# === POSIX shim and WASM platform layer ===
echo "--- posix shim ---"
compile_file "$SHIM/posix_shim.c"
compile_file "$SHIM/wasm_platform.c"

# === Archive ===

echo "=== Creating static library ==="
$AR rcs "$OUT/libgit2.a" "$OUT"/obj/*.o

echo "=== Done: $OUT/libgit2.a ==="
ls -lh "$OUT/libgit2.a"
