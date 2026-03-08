// Build a packfile from a list of object SHA-1s
//
// Fetches each object from R2, compresses with zlib via Zig WASM,
// and assembles into packfile v2 format.

import type { GitEngine } from "./git-engine";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";

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
  const wasm = await engine.getWasmPublic();

  // Collect output as array of chunks to avoid buffer-doubling memory spikes.
  // Each batch produces one chunk; final concatenation happens once at the end.
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  let objectCount = 0;

  // Reserve 12 bytes for the header (patched after all objects are counted)
  const header = new Uint8Array(12);
  header.set(PACK_SIGNATURE, 0);
  writeUint32BE(header, 4, 2); // version
  // bytes 8-11 (count) written after loop
  chunks.push(header);
  totalSize += 12;

  // Read objects in batches of 500 to bound memory
  const BATCH = 500;
  for (let i = 0; i < objectShas.length; i += BATCH) {
    const batchShas = objectShas.slice(i, i + BATCH);
    const batchObjects = await engine.readObjects(batchShas);

    for (const sha1 of batchShas) {
      const obj = batchObjects.get(sha1);
      if (!obj) {
        console.error(`buildPackfile: missing object ${sha1}, skipping`);
        continue;
      }

      let compressed: Uint8Array;
      try {
        compressed = wasm.zlibDeflate(obj.content);
      } catch {
        console.error(`buildPackfile: deflate crashed for ${sha1} (${obj.content.length} bytes)`);
        continue;
      }
      if (compressed.length === 0) {
        console.error(`buildPackfile: deflate returned 0 bytes for ${sha1} (${obj.content.length} bytes)`);
        continue;
      }

      const packType = objectToPackType(obj.type);
      const headerLen = typeSizeHeaderLen(obj.content.length);
      const entry = new Uint8Array(headerLen + compressed.length);
      writeTypeSizeHeader(entry, 0, packType, obj.content.length);
      entry.set(compressed, headerLen);
      chunks.push(entry);
      totalSize += entry.length;
      objectCount++;
    }
    // batchObjects goes out of scope here — GC can reclaim decompressed data
  }

  // Write final object count into header
  writeUint32BE(header, 8, objectCount);

  // Concatenate all chunks into final packfile buffer
  const pack = new Uint8Array(totalSize + 20); // +20 for SHA-1 trailer
  let offset = 0;
  for (const chunk of chunks) {
    pack.set(chunk, offset);
    offset += chunk.length;
  }

  // Trailer: SHA-1 of pack content
  const hashBuf = await crypto.subtle.digest("SHA-1", pack.subarray(0, offset));
  pack.set(new Uint8Array(hashBuf), offset);
  offset += 20;

  return pack.subarray(0, offset);
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

function typeSizeHeaderLen(size: number): number {
  let s = size >> 4;
  let len = 1;
  while (s > 0) {
    s >>= 7;
    len++;
  }
  return len;
}
