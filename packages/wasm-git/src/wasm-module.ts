// WASM module import — Wrangler handles .wasm as CompiledWasm
// @ts-expect-error Wrangler handles .wasm imports as WebAssembly.Module
import wasmModule from "./wasm/gitmode.wasm";

export default wasmModule as WebAssembly.Module;
