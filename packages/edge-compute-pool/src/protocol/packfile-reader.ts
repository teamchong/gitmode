// Packfile v2 reader — decompresses each object, resolves deltas, exposes
// the unpacked stream via callback or in-memory map.
//
// Decoupled from any specific storage layer: takes a WasmEngine for the
// heavy compute (zlib inflate, delta apply, sha-1 hash) and an optional
// `onObject` callback for callers that want to write objects to storage
// as they're unpacked instead of buffering everything.
//
// Pack object types (git pack format):
//   1=commit  2=tree  3=blob  4=tag  6=ofs-delta  7=ref-delta

import type { WasmEngine } from "@gitmode/wasm-git";
import { toHex } from "@gitmode/wasm-git";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "../pack-format";

const decoder = new TextDecoder();

const PACK_OBJ_COMMIT = 1;
const PACK_OBJ_TREE = 2;
const PACK_OBJ_BLOB = 3;
const PACK_OBJ_TAG = 4;
const PACK_OBJ_OFS_DELTA = 6;
const PACK_OBJ_REF_DELTA = 7;

export interface UnpackedObject {
  /** Internal object type code: OBJ_BLOB / OBJ_TREE / OBJ_COMMIT / OBJ_TAG. */
  type: number;
  /** Raw object content (no `<type> <size>\0` framing). */
  content: Uint8Array;
}

export interface UnpackOptions {
  /** Called for each fully-resolved object as it's unpacked. */
  onObject?: (sha1Hex: string, object: UnpackedObject) => Promise<void> | void;
  /**
   * Resolver for ref-delta bases that aren't in the pack. Useful when fetching
   * a thin pack from a server — bases must come from existing storage.
   */
  resolveBase?: (sha1Hex: string) => Promise<UnpackedObject | null>;
}

export interface UnpackResult {
  objects: Map<string, UnpackedObject>;
  count: number;
}

function packTypeToObjectType(packType: number): number {
  switch (packType) {
    case PACK_OBJ_COMMIT:
      return OBJ_COMMIT;
    case PACK_OBJ_TREE:
      return OBJ_TREE;
    case PACK_OBJ_BLOB:
      return OBJ_BLOB;
    case PACK_OBJ_TAG:
      return OBJ_TAG;
    default:
      throw new Error(`Unknown pack object type: ${packType}`);
  }
}

function objectTypeToName(t: number): string {
  switch (t) {
    case OBJ_BLOB:
      return "blob";
    case OBJ_TREE:
      return "tree";
    case OBJ_COMMIT:
      return "commit";
    case OBJ_TAG:
      return "tag";
    default:
      throw new Error(`Unknown object type: ${t}`);
  }
}

function parseEntryHeader(
  data: Uint8Array,
  offset: number,
): { type: number; size: number; headerLen: number } {
  let pos = offset;
  const first = data[pos++]!;
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;

  while (data[pos - 1]! & 0x80 && pos < data.length && shift < 28) {
    size |= (data[pos]! & 0x7f) << shift;
    shift += 7;
    pos++;
  }

  return { type, size, headerLen: pos - offset };
}

function parseOfsOffset(
  data: Uint8Array,
  offset: number,
): { negOffset: number; bytesRead: number } {
  let pos = offset;
  let value = data[pos]! & 0x7f;
  const end = Math.min(offset + 10, data.length - 1);
  while (data[pos]! & 0x80 && pos < end) {
    pos++;
    value = ((value + 1) << 7) | (data[pos]! & 0x7f);
  }
  pos++;
  return { negOffset: value, bytesRead: pos - offset };
}

function parseDeltaTargetSize(delta: Uint8Array): number {
  let pos = 0;
  const limit = Math.min(delta.length, 10);
  while (pos < limit && delta[pos]! & 0x80) pos++;
  pos++;
  let targetSize = 0;
  let shift = 0;
  while (pos < delta.length && shift < 28) {
    targetSize |= (delta[pos]! & 0x7f) << shift;
    if (!(delta[pos]! & 0x80)) break;
    shift += 7;
    pos++;
  }
  return targetSize;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

async function sha1Hex(content: Uint8Array, type: number): Promise<string> {
  // Compute git object SHA: sha1("<typeName> <size>\0" + content).
  // Using crypto.subtle keeps this independent of the WASM engine for the
  // pure-data hashing step (the engine is busy with inflate / delta apply).
  const typeName = objectTypeToName(type);
  const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header, 0);
  buf.set(content, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  const bytes = new Uint8Array(digest);
  return toHex(bytes);
}

/**
 * Unpack a Git packfile v2.
 *
 * Verifies the SHA-1 trailer, parses each entry, decompresses zlib data,
 * resolves both ref-deltas (against in-pack siblings or external storage)
 * and ofs-deltas (against earlier in-pack offsets), and emits each
 * resolved object via `onObject` (if provided) and into the returned map.
 */
export async function unpackPackfile(
  wasm: WasmEngine,
  packData: Uint8Array,
  opts: UnpackOptions = {},
): Promise<UnpackResult> {
  if (packData.length < 32) throw new Error("Packfile too short");
  const sig = decoder.decode(packData.subarray(0, 4));
  if (sig !== "PACK") throw new Error("Invalid packfile signature");

  const version = readUint32BE(packData, 4);
  if (version !== 2) throw new Error(`Unsupported pack version: ${version}`);

  const trailerOffset = packData.length - 20;
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest("SHA-1", packData.subarray(0, trailerOffset)),
  );
  const actualHash = packData.subarray(trailerOffset);
  for (let i = 0; i < 20; i++) {
    if (expectedHash[i] !== actualHash[i]) {
      throw new Error("Packfile checksum mismatch — data may be corrupted");
    }
  }

  const numObjects = readUint32BE(packData, 8);

  const objectsByHash = new Map<string, { type: number; content: Uint8Array; offset: number }>();
  const objectsByOffset = new Map<number, { type: number; content: Uint8Array; sha: string }>();
  const result: Map<string, UnpackedObject> = new Map();

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

    const maxDecompressed = Math.min(Math.max(size * 4, 65536), 32 * 1024 * 1024);
    const inputCap = Math.min(packData.length - offset, 30 * 1024 * 1024);
    const compressedSlice = packData.subarray(offset, offset + inputCap);

    const inflated = wasm.zlibInflateTracked(compressedSlice, maxDecompressed);
    const decompressed = inflated.data;
    offset += inflated.consumed;

    let objType: number;
    let objContent: Uint8Array;

    if (type === PACK_OBJ_REF_DELTA && baseRef) {
      const baseHex = toHex(baseRef);
      const baseInPack = objectsByHash.get(baseHex);
      let base: UnpackedObject;
      if (baseInPack) {
        base = { type: baseInPack.type, content: baseInPack.content };
      } else {
        const external = opts.resolveBase ? await opts.resolveBase(baseHex) : null;
        if (!external) throw new Error(`Missing delta base: ${baseHex}`);
        base = external;
      }
      const targetSize = parseDeltaTargetSize(decompressed);
      const maxOutput = Math.max(targetSize + 64, 65536);
      objContent = wasm.deltaApply(base.content, decompressed, maxOutput);
      objType = base.type;
    } else if (type === PACK_OBJ_OFS_DELTA && baseDeltaOffset !== undefined) {
      const baseObj = objectsByOffset.get(baseDeltaOffset);
      if (!baseObj) throw new Error(`Missing ofs-delta base at offset ${baseDeltaOffset}`);
      const targetSize = parseDeltaTargetSize(decompressed);
      const maxOutput = Math.max(targetSize + 64, 65536);
      objContent = wasm.deltaApply(baseObj.content, decompressed, maxOutput);
      objType = baseObj.type;
    } else {
      objType = packTypeToObjectType(type);
      objContent = decompressed;
    }

    const sha = await sha1Hex(objContent, objType);
    const unpacked: UnpackedObject = { type: objType, content: objContent };
    objectsByHash.set(sha, { type: objType, content: objContent, offset: entryOffset });
    objectsByOffset.set(entryOffset, { type: objType, content: objContent, sha });
    result.set(sha, unpacked);

    if (opts.onObject) {
      await opts.onObject(sha, unpacked);
    }
  }

  return { objects: result, count: numObjects };
}
