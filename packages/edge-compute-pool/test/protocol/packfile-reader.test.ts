// Tests for the packfile-reader. Builds synthetic v2 packfiles in JS
// (zlib via node:zlib), passes them through unpackPackfile, and verifies
// each object round-trips with the expected SHA-1 and content.

import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { WasmEngine, toHex } from "@gitmode/wasm-git";
import { unpackPackfile } from "../../src/protocol/packfile-reader";

// Pack object types
const T_COMMIT = 1;
const T_TREE = 2;
const T_BLOB = 3;

function writeTypeSizeHeader(type: number, size: number): Uint8Array {
  // First byte: type (3 bits, shifted left 4) + low-4 of size + continuation bit
  const out: number[] = [];
  let s = size;
  let byte = ((type & 0x07) << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) byte |= 0x80;
  out.push(byte);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    out.push(b);
  }
  return new Uint8Array(out);
}

function writeUint32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
}

async function sha1Bytes(buf: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
}

interface PackObjectInput {
  type: number; // pack type 1=commit 2=tree 3=blob
  content: Uint8Array;
}

async function buildPackfile(objects: PackObjectInput[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  parts.push(new TextEncoder().encode("PACK"));
  parts.push(writeUint32BE(2));
  parts.push(writeUint32BE(objects.length));

  for (const obj of objects) {
    parts.push(writeTypeSizeHeader(obj.type, obj.content.length));
    const deflated = deflateSync(obj.content);
    parts.push(new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength));
  }

  // Concatenate, then append SHA-1 trailer
  let total = 0;
  for (const p of parts) total += p.length;
  const body = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    body.set(p, pos);
    pos += p.length;
  }
  const trailer = await sha1Bytes(body);
  const result = new Uint8Array(body.length + 20);
  result.set(body, 0);
  result.set(trailer, body.length);
  return result;
}

async function gitObjectSha(type: number, content: Uint8Array): Promise<string> {
  const typeName =
    type === T_COMMIT ? "commit" : type === T_TREE ? "tree" : type === T_BLOB ? "blob" : "tag";
  const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header, 0);
  buf.set(content, header.length);
  return toHex(await sha1Bytes(buf));
}

describe("unpackPackfile", () => {
  it("unpacks a single-blob pack", async () => {
    const wasm = await WasmEngine.create();
    const blobContent = new TextEncoder().encode("hello\n");
    const expectedSha = await gitObjectSha(T_BLOB, blobContent);

    const pack = await buildPackfile([{ type: T_BLOB, content: blobContent }]);
    const result = await unpackPackfile(wasm, pack);

    expect(result.count).toBe(1);
    expect(result.objects.size).toBe(1);
    const obj = result.objects.get(expectedSha);
    expect(obj).toBeDefined();
    expect(obj!.content.length).toBe(blobContent.length);
    expect(new TextDecoder().decode(obj!.content)).toBe("hello\n");
    // expected sha matches what `git hash-object <(printf 'hello\n')` would give:
    expect(expectedSha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("unpacks a multi-object pack with mixed types", async () => {
    const wasm = await WasmEngine.create();
    const blob = new TextEncoder().encode("file content\n");
    const tree = new Uint8Array([
      // mode=100644, name="foo", sha=20-zero-bytes (fake sha is fine; we're just testing parsing)
      ...new TextEncoder().encode("100644 foo\0"),
      ...new Uint8Array(20),
    ]);
    const commit = new TextEncoder().encode(
      `tree ${"0".repeat(40)}\nauthor T <t@t> 1 +0000\ncommitter T <t@t> 1 +0000\n\nx`,
    );

    const pack = await buildPackfile([
      { type: T_BLOB, content: blob },
      { type: T_TREE, content: tree },
      { type: T_COMMIT, content: commit },
    ]);
    const result = await unpackPackfile(wasm, pack);

    expect(result.count).toBe(3);
    expect(result.objects.size).toBe(3);

    const blobSha = await gitObjectSha(T_BLOB, blob);
    const treeSha = await gitObjectSha(T_TREE, tree);
    const commitSha = await gitObjectSha(T_COMMIT, commit);

    expect(result.objects.get(blobSha)!.type).toBe(1); // OBJ_BLOB
    expect(result.objects.get(treeSha)!.type).toBe(2); // OBJ_TREE
    expect(result.objects.get(commitSha)!.type).toBe(3); // OBJ_COMMIT
  });

  it("calls onObject for each unpacked object in order", async () => {
    const wasm = await WasmEngine.create();
    const blobs = ["alpha", "beta", "gamma"].map((s) => new TextEncoder().encode(s));
    const pack = await buildPackfile(blobs.map((b) => ({ type: T_BLOB, content: b })));

    const seen: Array<{ sha: string; content: string }> = [];
    await unpackPackfile(wasm, pack, {
      onObject: (sha, obj) => {
        seen.push({ sha, content: new TextDecoder().decode(obj.content) });
      },
    });

    expect(seen.length).toBe(3);
    expect(seen.map((s) => s.content)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("rejects non-PACK signature", async () => {
    const wasm = await WasmEngine.create();
    const bogus = new Uint8Array(40); // 32 bytes header + 20 trailer space
    bogus.set(new TextEncoder().encode("NOPE"), 0);
    await expect(unpackPackfile(wasm, bogus)).rejects.toThrow(/Invalid packfile signature/);
  });

  it("rejects unsupported version", async () => {
    const wasm = await WasmEngine.create();
    const pack = await buildPackfile([{ type: T_BLOB, content: new TextEncoder().encode("x") }]);
    // Replace version (bytes 4-7) with v3
    pack.set(writeUint32BE(3), 4);
    // Recompute trailer to keep checksum valid
    const newTrailer = await sha1Bytes(pack.subarray(0, pack.length - 20));
    pack.set(newTrailer, pack.length - 20);
    await expect(unpackPackfile(wasm, pack)).rejects.toThrow(/Unsupported pack version/);
  });

  it("rejects packs with corrupted trailer (checksum mismatch)", async () => {
    const wasm = await WasmEngine.create();
    const pack = await buildPackfile([{ type: T_BLOB, content: new TextEncoder().encode("x") }]);
    // Flip a bit in the trailer
    pack[pack.length - 1] = pack[pack.length - 1]! ^ 0x01;
    await expect(unpackPackfile(wasm, pack)).rejects.toThrow(/checksum mismatch/);
  });

  it("rejects too-short input", async () => {
    const wasm = await WasmEngine.create();
    await expect(unpackPackfile(wasm, new Uint8Array(10))).rejects.toThrow(/too short/);
  });
});
