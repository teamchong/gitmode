import { describe, expect, it } from "vitest";
import * as wasmGit from "../src/index";
import { toHex } from "../src/index";

// NOTE: full WasmEngine / WasmEngineCore instantiation requires the .wasm
// binaries to be in sync with src/wasm-engine*.ts. The pre-allocated scratch
// ABI added `heapSave`/`heapRestore` exports; the core .wasm shipped in this
// repo predates that change, so `WasmEngineCore.create()` will fail until
// `pnpm run build:wasm-core` is re-run from the repo root. The full
// `gitmode.wasm` is current and works.
//
// These smoke tests verify the package boundary itself: exports resolve, types
// compile, and the pure-JS utilities run. End-to-end engine tests live with
// callers that have a guaranteed-fresh build pipeline.

describe("package exports", () => {
  it("exports the public API surface", () => {
    expect(wasmGit.WasmEngine).toBeDefined();
    expect(wasmGit.WasmEngineCore).toBeDefined();
    expect(wasmGit.toHex).toBeTypeOf("function");
    expect(wasmGit.wasmModule).toBeDefined();
    expect(wasmGit.wasmModuleCore).toBeDefined();
  });

  it("WasmEngine static create exists", () => {
    expect(wasmGit.WasmEngine.create).toBeTypeOf("function");
  });

  it("WasmEngineCore static create exists", () => {
    expect(wasmGit.WasmEngineCore.create).toBeTypeOf("function");
  });
});

describe("toHex", () => {
  it("converts bytes to lowercase hex", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(toHex(bytes)).toBe("deadbeef");
  });

  it("converts a 20-byte SHA buffer", () => {
    const sha = new Uint8Array(20);
    for (let i = 0; i < 20; i++) sha[i] = i;
    expect(toHex(sha)).toBe("000102030405060708090a0b0c0d0e0f10111213");
  });

  it("handles empty input", () => {
    expect(toHex(new Uint8Array(0))).toBe("");
  });

  it("zero-pads single-digit values", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe("000fff");
  });
});
