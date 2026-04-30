import { describe, expect, it } from "vitest";
// Importing individual modules avoids pulling pack-worker (and its transitive
// @gitmode/wasm-git WASM dependency) into the smoke test bundle. Cross-package
// .wasm resolution under vitest-pool-workers requires extra miniflare config;
// these tests cover the pure-JS surface that doesn't need a WASM engine.
import {
  OBJ_BLOB,
  OBJ_TREE,
  OBJ_COMMIT,
  OBJ_TAG,
  objectToPackType,
  typeSizeHeaderLen,
  writeTypeSizeHeader,
  writeUint32BE,
} from "../src/pack-format";
import { isBinary, unifiedDiff } from "../src/diff-engine";
import {
  batchForPool,
  resolveMaxSlots,
} from "../src/compute-pool";

describe("module surface", () => {
  it("exports pack-format helpers", () => {
    expect(objectToPackType).toBeTypeOf("function");
    expect(typeSizeHeaderLen).toBeTypeOf("function");
    expect(writeTypeSizeHeader).toBeTypeOf("function");
    expect(writeUint32BE).toBeTypeOf("function");
  });

  it("exports diff-engine helpers", () => {
    expect(unifiedDiff).toBeTypeOf("function");
    expect(isBinary).toBeTypeOf("function");
  });

  it("exports compute-pool helpers", () => {
    expect(batchForPool).toBeTypeOf("function");
    expect(resolveMaxSlots).toBeTypeOf("function");
  });
});

describe("pack-format", () => {
  it("maps object types to pack types correctly", () => {
    expect(objectToPackType(OBJ_COMMIT)).toBe(1);
    expect(objectToPackType(OBJ_TREE)).toBe(2);
    expect(objectToPackType(OBJ_BLOB)).toBe(3);
    expect(objectToPackType(OBJ_TAG)).toBe(4);
  });

  it("throws on unknown object type", () => {
    expect(() => objectToPackType(99)).toThrow(/Unknown object type/);
  });

  it("computes header length for various sizes", () => {
    // First byte holds 4 bits of size (after 3-bit type). Each continuation
    // byte holds 7 bits. So sizes 0..15 fit in 1 byte, 16..2047 in 2 bytes,
    // 2048..(2^18 - 1) in 3 bytes, etc.
    expect(typeSizeHeaderLen(0)).toBe(1);
    expect(typeSizeHeaderLen(15)).toBe(1);
    expect(typeSizeHeaderLen(16)).toBe(2);
    expect(typeSizeHeaderLen(2047)).toBe(2);
    expect(typeSizeHeaderLen(2048)).toBe(3);
    expect(typeSizeHeaderLen(1 << 20)).toBe(4);
  });

  it("writes type-size header round-trips with header length", () => {
    const sizes = [0, 1, 15, 16, 100, 2047, 2048, 1 << 20];
    for (const size of sizes) {
      const buf = new Uint8Array(8);
      const written = writeTypeSizeHeader(buf, 0, 3 /* blob */, size);
      expect(written).toBe(typeSizeHeaderLen(size));
    }
  });

  it("writeUint32BE encodes big-endian 4 bytes", () => {
    const buf = new Uint8Array(4);
    writeUint32BE(buf, 0, 0x12345678);
    expect(Array.from(buf)).toEqual([0x12, 0x34, 0x56, 0x78]);
  });
});

describe("diff-engine.isBinary", () => {
  it("flags content with NUL bytes as binary", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100]);
    expect(isBinary(data)).toBe(true);
  });

  it("treats plain ASCII text as non-binary", () => {
    const data = new TextEncoder().encode("hello world\nthis is text\n");
    expect(isBinary(data)).toBe(false);
  });
});

describe("diff-engine.unifiedDiff", () => {
  it("produces an empty diff for identical inputs", () => {
    const diff = unifiedDiff("line1\nline2\n", "line1\nline2\n", "a.txt", "a.txt");
    expect(diff).toBe("");
  });

  it("produces a non-empty diff for changed inputs", () => {
    const diff = unifiedDiff("line1\nline2\n", "line1\nLINE2\n", "a.txt", "a.txt");
    expect(diff).toContain("-line2");
    expect(diff).toContain("+LINE2");
  });
});

describe("compute-pool.batchForPool", () => {
  it("splits items into batches of given size, round-robin across slots", () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const tasks = batchForPool(items, 10, 4);
    // 25 items / 10 = 3 batches
    expect(tasks.length).toBe(3);
    expect(tasks[0]?.payload.length).toBe(10);
    expect(tasks[1]?.payload.length).toBe(10);
    expect(tasks[2]?.payload.length).toBe(5);
    // round-robin slot indices
    expect(tasks[0]?.slotIndex).toBe(0);
    expect(tasks[1]?.slotIndex).toBe(1);
    expect(tasks[2]?.slotIndex).toBe(2);
  });

  it("wraps slot indices when batches exceed maxSlots", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const tasks = batchForPool(items, 10, 3);
    expect(tasks.length).toBe(10);
    expect(tasks.map((t) => t.slotIndex)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]);
  });

  it("returns a single batch when input fits in one batch", () => {
    const tasks = batchForPool([1, 2, 3], 10);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.payload).toEqual([1, 2, 3]);
    expect(tasks[0]?.slotIndex).toBe(0);
  });
});
