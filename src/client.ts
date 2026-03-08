// gitmode/client — Lightweight Git engine for client-side use (83KB WASM)
//
// Pure computation: SHA-1, zlib, delta, packfile, object parsing, protocol, SIMD.
// No libgit2, no server dependencies. Runs anywhere WASM runs.
//
// Usage:
//   import { WasmEngineCore } from "gitmode/client";
//   const engine = await WasmEngineCore.create();

export { WasmEngineCore } from "./wasm-engine-core";
export type { CoreWasmExports } from "./wasm-engine-core";
