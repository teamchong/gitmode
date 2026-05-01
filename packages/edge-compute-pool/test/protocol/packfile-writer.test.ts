// Round-trip test: build a packfile with our writer, then unpack it with
// our reader and verify each object comes back identically.

import { describe, expect, it } from "vitest";
import { WasmEngine, toHex } from "@gitmode/wasm-git";
import { buildPackfile } from "../../src/protocol/packfile-writer";
import { unpackPackfile } from "../../src/protocol/packfile-reader";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT } from "../../src/pack-format";

async function gitObjectSha(typeName: string, content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header, 0);
  buf.set(content, header.length);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return toHex(new Uint8Array(hash));
}

describe("buildPackfile + unpackPackfile round-trip", () => {
  it("round-trips a single blob", async () => {
    const wasm = await WasmEngine.create();
    const content = new TextEncoder().encode("hello world\n");
    const expectedSha = await gitObjectSha("blob", content);

    const pack = await buildPackfile(wasm, [{ type: OBJ_BLOB, content }]);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");

    const result = await unpackPackfile(wasm, pack);
    expect(result.count).toBe(1);
    const obj = result.objects.get(expectedSha);
    expect(obj).toBeDefined();
    expect(obj!.type).toBe(OBJ_BLOB);
    expect(new TextDecoder().decode(obj!.content)).toBe("hello world\n");
  });

  it("round-trips multiple objects of mixed types", async () => {
    const wasm = await WasmEngine.create();
    const blob = new TextEncoder().encode("file contents\n");
    const tree = new Uint8Array([
      ...new TextEncoder().encode("100644 file\0"),
      ...new Uint8Array(20).fill(0xab),
    ]);
    const commit = new TextEncoder().encode(
      `tree ${"0".repeat(40)}\nauthor T <t@t> 1700000000 +0000\ncommitter T <t@t> 1700000000 +0000\n\nx`,
    );

    const pack = await buildPackfile(wasm, [
      { type: OBJ_BLOB, content: blob },
      { type: OBJ_TREE, content: tree },
      { type: OBJ_COMMIT, content: commit },
    ]);

    const result = await unpackPackfile(wasm, pack);
    expect(result.count).toBe(3);

    const blobSha = await gitObjectSha("blob", blob);
    const treeSha = await gitObjectSha("tree", tree);
    const commitSha = await gitObjectSha("commit", commit);

    expect(result.objects.get(blobSha)?.type).toBe(OBJ_BLOB);
    expect(result.objects.get(treeSha)?.type).toBe(OBJ_TREE);
    expect(result.objects.get(commitSha)?.type).toBe(OBJ_COMMIT);
  });

  it("produces a verifiable SHA-1 trailer", async () => {
    const wasm = await WasmEngine.create();
    const pack = await buildPackfile(wasm, [
      { type: OBJ_BLOB, content: new TextEncoder().encode("trailer test") },
    ]);
    const trailer = pack.subarray(pack.length - 20);
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.length - 20)),
    );
    for (let i = 0; i < 20; i++) {
      expect(trailer[i]).toBe(expected[i]);
    }
  });

  it("handles an empty object list (header-only pack)", async () => {
    const wasm = await WasmEngine.create();
    const pack = await buildPackfile(wasm, []);
    expect(pack.length).toBe(32); // 12 header + 0 entries + 20 trailer
    const result = await unpackPackfile(wasm, pack);
    expect(result.count).toBe(0);
    expect(result.objects.size).toBe(0);
  });

  it("scales to many small objects", async () => {
    const wasm = await WasmEngine.create();
    const objects = Array.from({ length: 50 }, (_, i) => ({
      type: OBJ_BLOB,
      content: new TextEncoder().encode(`object number ${i}`),
    }));
    const pack = await buildPackfile(wasm, objects);
    const result = await unpackPackfile(wasm, pack);
    expect(result.count).toBe(50);
    expect(result.objects.size).toBe(50);
  });
});
