// End-to-end engine tests: instantiate both WasmEngine flavors and
// exercise real WASM paths (SHA-1, zlib, hash-object). These verify the
// committed .wasm binaries, the WASI shims, and the pre-allocated
// scratch ABI all work together.

import { describe, expect, it, beforeAll } from "vitest";
import { WasmEngine, WasmEngineCore, toHex } from "../src/index";

let engine: WasmEngine;
let coreEngine: WasmEngineCore;

beforeAll(async () => {
  engine = await WasmEngine.create();
  coreEngine = await WasmEngineCore.create();
});

describe("WasmEngine.sha1Hex", () => {
  it("matches the empty-string fixture", () => {
    const sha = engine.sha1Hex(new Uint8Array(0));
    // sha1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
    expect(sha).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("matches the 'hello' fixture", () => {
    const sha = engine.sha1Hex(new TextEncoder().encode("hello"));
    // sha1("hello") = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    expect(sha).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });

  it("hashes a 1MB buffer without overflowing scratch", () => {
    const buf = new Uint8Array(1_000_000);
    for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;
    const sha = engine.sha1Hex(buf);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("WasmEngine.hashAndDeflate", () => {
  it("produces a git-compatible blob hash for 'hello\\n'", () => {
    const content = new TextEncoder().encode("hello\n");
    const header = new TextEncoder().encode(`blob ${content.length}\0`);
    const result = engine.hashAndDeflate(/* OBJ_BLOB */ 1, content, header);
    // git hash-object -t blob <(printf 'hello\n') = ce013625030ba8dba906f756967f9e9ca394464a
    expect(toHex(result.sha1)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(result.compressed.length).toBeGreaterThan(0);
    // compressed shouldn't be larger than input + zlib overhead (typically <input)
    expect(result.compressed.length).toBeLessThan(content.length + header.length + 32);
  });

  it("produces a git-compatible empty-blob hash", () => {
    const content = new Uint8Array(0);
    const header = new TextEncoder().encode("blob 0\0");
    const result = engine.hashAndDeflate(1, content, header);
    // git hash-object of empty file = e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    expect(toHex(result.sha1)).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

describe("WasmEngine zlib round-trip", () => {
  it("inflates what it deflates (small input)", () => {
    const original = new TextEncoder().encode("the quick brown fox jumps over the lazy dog\n");
    const deflated = engine.zlibDeflate(original);
    expect(deflated.length).toBeGreaterThan(0);

    const inflated = engine.zlibInflate(deflated, original.length);
    expect(inflated.length).toBe(original.length);
    expect(new TextDecoder().decode(inflated)).toBe(new TextDecoder().decode(original));
  });

  it("inflates what it deflates (8KB repeated pattern)", () => {
    // Note: this engine ships libdeflate at level 0 (stored, not compressed).
    // The round-trip is what matters; size invariants are environment-dependent.
    const original = new TextEncoder().encode("aaaa".repeat(2000));
    const deflated = engine.zlibDeflate(original);
    expect(deflated.length).toBeGreaterThan(0);

    const inflated = engine.zlibInflate(deflated, original.length);
    expect(inflated.length).toBe(original.length);
    expect(new TextDecoder().decode(inflated)).toBe(new TextDecoder().decode(original));
  });

  it("inflates what it deflates (incompressible)", () => {
    const original = new Uint8Array(4096);
    // Pseudo-random fill (LCG) so the test is deterministic
    let s = 0x12345678;
    for (let i = 0; i < original.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      original[i] = s & 0xff;
    }
    const deflated = engine.zlibDeflate(original);
    expect(deflated.length).toBeGreaterThan(0);

    const inflated = engine.zlibInflate(deflated, original.length + 1024);
    expect(inflated.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(inflated[i]).toBe(original[i]);
    }
  });
});

describe("WasmEngine heap management", () => {
  it("getHeapUsed reports a non-zero footprint after init", () => {
    const used = engine.getHeapUsed();
    expect(used).toBeGreaterThan(0);
  });

  it("repeated operations don't unboundedly grow the heap (scratch ABI working)", () => {
    const before = engine.getHeapUsed();
    for (let i = 0; i < 50; i++) {
      engine.sha1Hex(new TextEncoder().encode(`iteration ${i}`));
    }
    const after = engine.getHeapUsed();
    // Heap may have grown by some constant (e.g., one allocation that escaped),
    // but should not have grown by 50x the per-call work.
    expect(after - before).toBeLessThan(1024 * 1024);
  });
});

describe("WasmEngineCore (lightweight, no libgit2)", () => {
  it("instantiates without the libgit2 host imports", () => {
    expect(coreEngine).toBeDefined();
  });

  it("computes SHA-1 of empty input", () => {
    const sha = coreEngine.sha1Hex(new Uint8Array(0));
    expect(sha).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("computes SHA-1 of 'hello'", () => {
    const sha = coreEngine.sha1Hex(new TextEncoder().encode("hello"));
    expect(sha).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });

  it("hashAndDeflate produces a git-compatible blob hash", () => {
    const content = new TextEncoder().encode("hello\n");
    const header = new TextEncoder().encode(`blob ${content.length}\0`);
    const result = coreEngine.hashAndDeflate(/* OBJ_BLOB */ 1, content, header);
    expect(toHex(result.sha1)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("zlib round-trip on small text", () => {
    const original = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz\n");
    const deflated = coreEngine.zlibDeflate(original);
    const inflated = coreEngine.zlibInflate(deflated, original.length);
    expect(new TextDecoder().decode(inflated)).toBe(new TextDecoder().decode(original));
  });
});
