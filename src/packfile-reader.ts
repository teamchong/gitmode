// Unpack a received packfile — extract objects and store in R2
//
// Reads packfile v2 format, decompresses each object with Zig WASM,
// resolves deltas, and stores loose objects.
//
// Optimization: prepares all objects (hash + compress) first, then
// flushes to R2 in batched parallel writes instead of one-at-a-time.

import type { GitEngine } from "./git-engine";
import { WasmEngine } from "./wasm-engine";

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
  const sig = new TextDecoder().decode(packData.slice(0, 4));
  if (sig !== "PACK") throw new Error("Invalid packfile signature");

  const version = readUint32BE(packData, 4);
  if (version !== 2) throw new Error(`Unsupported pack version: ${version}`);

  const numObjects = readUint32BE(packData, 8);

  // Phase 1: Parse all objects (CPU-only, no R2)
  const objects: PackObject[] = [];
  const pendingWrites: Array<{ sha1Hex: string; compressed: Uint8Array }> = [];
  let offset = 12;

  for (let i = 0; i < numObjects; i++) {
    const entryOffset = offset;
    const { type, size, headerLen } = parseEntryHeader(packData, offset);
    offset += headerLen;

    let baseRef: Uint8Array | undefined;
    let baseDeltaOffset: number | undefined;

    if (type === PACK_OBJ_REF_DELTA) {
      baseRef = packData.slice(offset, offset + 20);
      offset += 20;
    } else if (type === PACK_OBJ_OFS_DELTA) {
      const { negOffset, bytesRead } = parseOfsOffset(packData, offset);
      baseDeltaOffset = entryOffset - negOffset;
      offset += bytesRead;
    }

    // Decompress zlib data
    const maxDecompressed = Math.max(size * 2, 65536);
    const remaining = packData.slice(offset);
    const { data: decompressed, consumed } = wasm.zlibInflateTracked(remaining, maxDecompressed);
    offset += consumed;

    if (type === PACK_OBJ_REF_DELTA && baseRef) {
      const targetSize = parseDeltaTargetSize(decompressed);
      const maxOutput = Math.max(targetSize + 64, 65536);
      const baseHex = Array.from(baseRef)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const baseObj = objects.find((o) => o.sha1Hex === baseHex);
      if (!baseObj) {
        // Base might already be in storage — need R2 read for this one
        const stored = await engine.readObject(baseHex);
        if (!stored) throw new Error(`Missing delta base: ${baseHex}`);
        const resolved = wasm.deltaApply(stored.content, decompressed, maxOutput);
        const prepared = engine.prepareObject(wasm, stored.type, resolved);
        pendingWrites.push(prepared);
        objects.push({ type: stored.type, data: resolved, sha1Hex: prepared.sha1Hex, offset: entryOffset });
      } else {
        const resolved = wasm.deltaApply(baseObj.data, decompressed, maxOutput);
        const prepared = engine.prepareObject(wasm, baseObj.type, resolved);
        pendingWrites.push(prepared);
        objects.push({ type: baseObj.type, data: resolved, sha1Hex: prepared.sha1Hex, offset: entryOffset });
      }
    } else if (type === PACK_OBJ_OFS_DELTA && baseDeltaOffset !== undefined) {
      const targetSize = parseDeltaTargetSize(decompressed);
      const maxOutput = Math.max(targetSize + 64, 65536);
      const baseObj = objects.find((o) => o.offset === baseDeltaOffset);
      if (!baseObj) throw new Error(`Missing ofs-delta base at offset ${baseDeltaOffset}`);
      const resolved = wasm.deltaApply(baseObj.data, decompressed, maxOutput);
      const prepared = engine.prepareObject(wasm, baseObj.type, resolved);
      pendingWrites.push(prepared);
      objects.push({ type: baseObj.type, data: resolved, sha1Hex: prepared.sha1Hex, offset: entryOffset });
    } else {
      const objType = packTypeToObjectType(type);
      const prepared = engine.prepareObject(wasm, objType, decompressed);
      pendingWrites.push(prepared);
      objects.push({ type: objType, data: decompressed, sha1Hex: prepared.sha1Hex, offset: entryOffset });
    }
  }

  // Phase 2: Batch write all objects to R2 in parallel
  await engine.putObjects(pendingWrites);

  // Return in-memory cache for optimistic worktree writes
  const cache: ObjectCache = new Map();
  for (const obj of objects) {
    cache.set(obj.sha1Hex, { type: obj.type, data: obj.data });
  }
  return cache;
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
