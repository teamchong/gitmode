# `@gitmode/wasm-git`

Zig-based WASM engine for git primitives: SHA-1 with SIMD128, zlib via libdeflate, delta compression, packfile read/write. Two flavors:

- **`WasmEngine`** — full module with libgit2 statically linked (diff, blame, revwalk).
- **`WasmEngineCore`** — lightweight module without libgit2 (SHA-1, zlib, delta, packfile only).

## Usage

```ts
import { WasmEngineCore } from "@gitmode/wasm-git";

const engine = await WasmEngineCore.create();

// SHA-1 of arbitrary bytes
const sha = engine.sha1Hex(new TextEncoder().encode("hello"));

// Hash + deflate a git object in one pass (zero-copy scratch ABI)
const result = engine.hashAndDeflate(
  /* type: blob */ 3,
  content,
  new TextEncoder().encode(`blob ${content.length}\0`),
);
```

## Architecture

- Pre-allocated scratch I/O buffer at WASM init (8 MB by default), so per-call SHA / deflate operations don't pay an `alloc()` cost.
- `_resetDynamic()` uses `heapRestore()` to roll back only dynamic allocations between calls, preserving the scratch region.
- All read APIs return zero-copy `Uint8Array` views into WASM linear memory. Views are valid only until the next allocation or reset; copy if you need to retain.

See [the design rationale](https://github.com/teamchong/gitmode/blob/main/DESIGN-NOTES.md) and the [scaling docs](https://github.com/teamchong/gitmode/blob/main/docs/src/content/docs/scaling.mdx) for the broader context.

## Development

```bash
pnpm typecheck
pnpm test
```

Tests run under `vitest-pool-workers` with the `CompiledWasm` rule pointed at `src/wasm/*.wasm`.

## Building WASM from source

The `.wasm` files in `src/wasm/` are committed binaries built from the Zig sources at the repo root (`/wasm/`). Rebuild via:

```bash
# from repo root
pnpm run build:wasm        # gitmode.wasm (full + libgit2)
pnpm run build:wasm-core   # gitmode-core.wasm (lightweight)
```

Requires Zig 0.15.2. `wasm-metadce` and `wasm-opt` from binaryen.

> **Known gotcha.** The committed `gitmode-core.wasm` may lag the TypeScript wrappers if Zig exports are added without a re-build. If `WasmEngineCore.create()` throws `heapSave is not a function`, rebuild the core WASM. The full `gitmode.wasm` is rebuilt more often and is current.

## Status

This package was extracted from the original `gitmode` Git server. It's the differentiated R&D piece that survives the project's [pivot](https://github.com/teamchong/gitmode/blob/main/DESIGN-NOTES.md) — usable on its own as a Workers-friendly git primitive library, or as the WASM compute layer for [`@gitmode/edge-compute-pool`](../edge-compute-pool).
