// gitmode/server — Full Git server engine for Cloudflare Workers (865KB WASM)
//
// Includes everything in client plus libgit2 (diff, revwalk, blame)
// and host imports for R2/filesystem access.
//
// Usage:
//   import { WasmEngine } from "gitmode/server";
//   const engine = await WasmEngine.create();

export { WasmEngine } from "./wasm-engine";
export type { WasmExports } from "./wasm-engine";
