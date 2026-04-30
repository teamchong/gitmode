// @gitmode/wasm-git — WASM engine wrappers for git primitives.
//
// Exports two engines:
//   - WasmEngine: full module with libgit2 (diff, blame, revwalk)
//   - WasmEngineCore: lightweight module (SHA-1, zlib, delta, packfile only)
//
// Usage in a Worker:
//   import { WasmEngineCore } from "@gitmode/wasm-git";
//   const engine = await WasmEngineCore.create();
//   const sha = engine.sha1Hex(new TextEncoder().encode("hello"));

export { WasmEngine, type WasmExports } from "./wasm-engine";
export { WasmEngineCore, type CoreWasmExports } from "./wasm-engine-core";
export { toHex } from "./hex";
export { default as wasmModule } from "./wasm-module";
export { default as wasmModuleCore } from "./wasm-module-core";

// Required by vitest-pool-workers / wrangler entry resolution.
// This package is consumed as a library; the fetch handler returns 404 because
// the package is not deployed as its own Worker.
export default {
  fetch: () => new Response("not found", { status: 404 }),
} satisfies ExportedHandler;
