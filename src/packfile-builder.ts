// Build a packfile from a list of object SHA-1s
//
// Fetches each object from R2, compresses with zlib via Zig WASM,
// and assembles into packfile v2 format.

import type { GitEngine } from "./git-engine";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";
import { WasmEngine } from "./wasm-engine";

const PACK_SIGNATURE = new Uint8Array([0x50, 0x41, 0x43, 0x4b]); // "PACK"

/** Convert internal object type to packfile type number. */
function objectToPackType(objType: number): number {
  switch (objType) {
    case OBJ_COMMIT: return 1; // PACK_OBJ_COMMIT
    case OBJ_TREE: return 2;   // PACK_OBJ_TREE
    case OBJ_BLOB: return 3;   // PACK_OBJ_BLOB
    case OBJ_TAG: return 4;    // PACK_OBJ_TAG
    default: throw new Error(`Unknown object type: ${objType}`);
  }
}

export async function buildPackfile(
  engine: GitEngine,
  objectShas: string[]
): Promise<Uint8Array> {
  const wasm = await WasmEngine.create();
  const objects: { packType: number; uncompressedSize: number; compressed: Uint8Array }[] = [];

  // Fetch and compress all objects
  for (const sha1 of objectShas) {
    const obj = await engine.readObject(sha1);
    if (!obj) continue;

    const compressed = wasm.zlibDeflate(obj.content);
    objects.push({
      packType: objectToPackType(obj.type),
      uncompressedSize: obj.content.length,
      compressed,
    });
  }

  // Calculate total size
  let totalSize = 12; // header
  for (const obj of objects) {
    totalSize += typeSizeHeaderLen(obj.packType, obj.uncompressedSize);
    totalSize += obj.compressed.length;
  }
  totalSize += 20; // trailer SHA-1

  // Build packfile
  const pack = new Uint8Array(totalSize + 64); // extra room
  let offset = 0;

  // Header: "PACK" + version(2) + count
  pack.set(PACK_SIGNATURE, 0);
  offset += 4;
  writeUint32BE(pack, offset, 2); // version
  offset += 4;
  writeUint32BE(pack, offset, objects.length);
  offset += 4;

  // Objects
  for (const obj of objects) {
    offset += writeTypeSizeHeader(pack, offset, obj.packType, obj.uncompressedSize);
    pack.set(obj.compressed, offset);
    offset += obj.compressed.length;
  }

  // Trailer: SHA-1 of pack content (use crypto API to avoid copying
  // the entire packfile into the 32MB WASM arena)
  const hashBuf = await crypto.subtle.digest("SHA-1", pack.slice(0, offset));
  const digest = new Uint8Array(hashBuf);
  pack.set(digest, offset);
  offset += 20;

  return pack.slice(0, offset);
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 24) & 0xff;
  buf[offset + 1] = (value >> 16) & 0xff;
  buf[offset + 2] = (value >> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function writeTypeSizeHeader(
  buf: Uint8Array,
  offset: number,
  type: number,
  size: number
): number {
  let s = size;
  let byte = ((type & 0x07) << 4) | (s & 0x0f);
  s >>= 4;

  let pos = 0;
  if (s > 0) byte |= 0x80;
  buf[offset + pos] = byte;
  pos++;

  while (s > 0) {
    byte = s & 0x7f;
    s >>= 7;
    if (s > 0) byte |= 0x80;
    buf[offset + pos] = byte;
    pos++;
  }

  return pos;
}

function typeSizeHeaderLen(type: number, size: number): number {
  let s = size >> 4;
  let len = 1;
  while (s > 0) {
    s >>= 7;
    len++;
  }
  return len;
}
