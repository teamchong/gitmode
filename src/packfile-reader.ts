// Unpack a received packfile — extract objects and store in R2
//
// Reads packfile v2 format, decompresses each object with Zig WASM/libdeflate,
// resolves deltas, and stores loose objects.
//
// Streaming: flushes compressed objects to R2 in batches during parsing
// instead of buffering all writes until the end, reducing peak memory.

import type { GitEngine } from "./git-engine";
import { toHex } from "./hex";

// Packfile object types (git pack format)
const PACK_OBJ_COMMIT = 1;
const PACK_OBJ_TREE = 2;
const PACK_OBJ_BLOB = 3;
const PACK_OBJ_TAG = 4;
const PACK_OBJ_OFS_DELTA = 6;
const PACK_OBJ_REF_DELTA = 7;

// Internal object types (matching Zig enum: blob=1, tree=2, commit=3, tag=4)
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";

function packTypeToObjectType(packType: number): number {
  switch (packType) {
    case PACK_OBJ_COMMIT: return OBJ_COMMIT;
    case PACK_OBJ_TREE: return OBJ_TREE;
    case PACK_OBJ_BLOB: return OBJ_BLOB;
    case PACK_OBJ_TAG: return OBJ_TAG;
    default: throw new Error(`Unknown pack object type: ${packType}`);
  }
}

function parseDeltaTargetSize(delta: Uint8Array): number {
  let pos = 0;
  // Skip source size varint
  while (pos < delta.length && delta[pos] & 0x80) pos++;
  pos++;
  // Read target size varint
  let targetSize = 0;
  let shift = 0;
  while (pos < delta.length) {
    targetSize |= (delta[pos] & 0x7f) << shift;
    if (!(delta[pos] & 0x80)) break;
    shift += 7;
    pos++;
  }
  return targetSize;
}

interface PackObject {
  type: number;
  data: Uint8Array;
  sha1Hex: string;
  offset: number;
}

/** In-memory object cache from unpacking — avoids R2 re-reads for worktree materialization. */
export type ObjectCache = Map<string, { type: number; data: Uint8Array }>;

export async function unpackPackfile(
  engine: GitEngine,
  packData: Uint8Array
): Promise<ObjectCache> {
  const wasm = await engine.getWasmPublic();

  // Verify header
  if (packData.length < 12) throw new Error("Packfile too short");
  const sig = new TextDecoder().decode(packData.subarray(0, 4));
  if (sig !== "PACK") throw new Error("Invalid packfile signature");

  const version = readUint32BE(packData, 4);
  if (version !== 2) throw new Error(`Unsupported pack version: ${version}`);

  const numObjects = readUint32BE(packData, 8);

  // Object lookup tables for delta resolution (O(1) instead of O(n) find)
  const objectsByHash = new Map<string, PackObject>();
  const objectsByOffset = new Map<number, PackObject>();

  // Streaming write buffer — flush to R2 every FLUSH_BATCH objects
  const FLUSH_BATCH = 200;
  const pendingWrites: Array<{ sha1Hex: string; compressed: Uint8Array }> = [];
  const cache: ObjectCache = new Map();
  let offset = 12;

  for (let i = 0; i < numObjects; i++) {
    const entryOffset = offset;
    const { type, size, headerLen } = parseEntryHeader(packData, offset);
    offset += headerLen;

    let baseRef: Uint8Array | undefined;
    let baseDeltaOffset: number | undefined;

    if (type === PACK_OBJ_REF_DELTA) {
      baseRef = packData.subarray(offset, offset + 20);
      offset += 20;
    } else if (type === PACK_OBJ_OFS_DELTA) {
      const { negOffset, bytesRead } = parseOfsOffset(packData, offset);
      baseDeltaOffset = entryOffset - negOffset;
      offset += bytesRead;
    }

    // Decompress zlib data — pass a bounded slice to avoid copying the entire
    // remaining packfile into the WASM arena.
    const maxDecompressed = Math.max(size * 4, 65536);
    const inputCap = Math.min(packData.length - offset, 30 * 1024 * 1024);
    const compressedSlice = packData.subarray(offset, offset + inputCap);
    let decompressed: Uint8Array;
    let consumed: number;
    try {
      const result = wasm.zlibInflateTracked(compressedSlice, maxDecompressed);
      decompressed = result.data;
      consumed = result.consumed;
    } catch {
      // libdeflate can fail on rare edge cases — fallback to node:zlib
      const result = await jsInflateTracked(packData, offset, size);
      decompressed = result.data;
      consumed = result.consumed;
    }
    offset += consumed;

    let objType: number;
    let objData: Uint8Array;

    if (type === PACK_OBJ_REF_DELTA && baseRef) {
      const targetSize = parseDeltaTargetSize(decompressed);
      const maxOutput = Math.max(targetSize + 64, 65536);
      const baseHex = toHex(baseRef);
      const baseObj = objectsByHash.get(baseHex);
      if (!baseObj) {
        // Base might already be in storage — need R2 read for this one
        const stored = await engine.readObject(baseHex);
        if (!stored) throw new Error(`Missing delta base: ${baseHex}`);
        objData = wasm.deltaApply(stored.content, decompressed, maxOutput);
        objType = stored.type;
      } else {
        objData = wasm.deltaApply(baseObj.data, decompressed, maxOutput);
        objType = baseObj.type;
      }
    } else if (type === PACK_OBJ_OFS_DELTA && baseDeltaOffset !== undefined) {
      const targetSize = parseDeltaTargetSize(decompressed);
      const maxOutput = Math.max(targetSize + 64, 65536);
      const baseObj = objectsByOffset.get(baseDeltaOffset);
      if (!baseObj) throw new Error(`Missing ofs-delta base at offset ${baseDeltaOffset}`);
      objData = wasm.deltaApply(baseObj.data, decompressed, maxOutput);
      objType = baseObj.type;
    } else {
      objType = packTypeToObjectType(type);
      objData = decompressed;
    }

    const prepared = engine.prepareObject(wasm, objType, objData);
    pendingWrites.push(prepared);

    const packObj: PackObject = { type: objType, data: objData, sha1Hex: prepared.sha1Hex, offset: entryOffset };
    objectsByHash.set(prepared.sha1Hex, packObj);
    objectsByOffset.set(entryOffset, packObj);
    cache.set(prepared.sha1Hex, { type: objType, data: objData });

    // Streaming flush: write batch to R2 while continuing to parse
    if (pendingWrites.length >= FLUSH_BATCH) {
      await engine.putObjects(pendingWrites.splice(0));
    }
  }

  // Log peak WASM heap usage for diagnostics
  console.log(`unpackPackfile: ${numObjects} objects, peak WASM heap ${(wasm.getHeapUsed() / 1024).toFixed(0)}KB`);

  // Flush remaining objects
  if (pendingWrites.length > 0) {
    await engine.putObjects(pendingWrites);
  }

  return cache;
}

/**
 * JS-based zlib inflate fallback using node:zlib (available via nodejs_compat).
 * Only invoked when the WASM decompressor fails on a specific deflate stream.
 *
 * Uses node:zlib.createInflate which handles trailing bytes gracefully and
 * tracks exact consumed byte count via bytesWritten.
 */
async function jsInflateTracked(
  packData: Uint8Array,
  offset: number,
  expectedSize: number,
): Promise<{ data: Uint8Array; consumed: number }> {
  const { createInflate } = await import("node:zlib");

  // Feed generous input — createInflate handles trailing bytes correctly
  const inputLen = Math.min(packData.length - offset, expectedSize + 4096);
  const input = packData.subarray(offset, offset + inputLen);

  const inflate = createInflate();
  const chunks: Buffer[] = [];

  const result = await new Promise<{ data: Uint8Array; consumed: number }>((resolve, reject) => {
    inflate.on("data", (chunk: Buffer) => chunks.push(chunk));
    inflate.on("end", () => {
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const data = new Uint8Array(totalLen);
      let pos = 0;
      for (const c of chunks) {
        data.set(c, pos);
        pos += c.length;
      }
      resolve({ data, consumed: inflate.bytesWritten });
    });
    inflate.on("error", reject);
    inflate.end(Buffer.from(input));
  });

  return result;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] << 24) |
    (buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) |
    buf[offset + 3]
  );
}

function parseEntryHeader(
  data: Uint8Array,
  offset: number
): { type: number; size: number; headerLen: number } {
  let pos = offset;
  const first = data[pos++];
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;

  while (data[pos - 1] & 0x80) {
    size |= (data[pos] & 0x7f) << shift;
    shift += 7;
    pos++;
  }

  return { type, size, headerLen: pos - offset };
}

function parseOfsOffset(
  data: Uint8Array,
  offset: number
): { negOffset: number; bytesRead: number } {
  let pos = offset;
  let value = data[pos] & 0x7f;
  while (data[pos] & 0x80) {
    pos++;
    value = ((value + 1) << 7) | (data[pos] & 0x7f);
  }
  pos++;
  return { negOffset: value, bytesRead: pos - offset };
}
