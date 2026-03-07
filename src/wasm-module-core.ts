// Core WASM module import — lightweight client-side module (no libgit2)
// @ts-expect-error Wrangler handles .wasm imports as WebAssembly.Module
import wasmModule from "./wasm/gitmode-core.wasm";

export default wasmModule as WebAssembly.Module;
