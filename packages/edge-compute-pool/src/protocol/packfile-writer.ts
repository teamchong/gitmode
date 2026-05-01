// Pack v2 writer — the inverse of packfile-reader.ts.
//
// Builds a single packfile from a list of (type, content) objects:
//   PACK + version 2 + count
//   per-object: type+size varint header, zlib-deflated content
//   SHA-1 trailer over all preceding bytes
//
// Used by the push side of the Artifacts integration. Callers stage all
// new objects (commits + trees + blobs) for a push and feed them in
// here; the result is the body that goes inside `git-receive-pack`.

import type { WasmEngine } from "@gitmode/wasm-git";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "../pack-format";
import { writeUint32BE, writeTypeSizeHeader, typeSizeHeaderLen } from "../pack-format";

const PACK_OBJ_COMMIT = 1;
const PACK_OBJ_TREE = 2;
const PACK_OBJ_BLOB = 3;
const PACK_OBJ_TAG = 4;

export interface ObjectToPack {
  /** Internal object type code: OBJ_BLOB / OBJ_TREE / OBJ_COMMIT / OBJ_TAG. */
  type: number;
  /** Raw object content (without `<type> <size>\0` framing). */
  content: Uint8Array;
}

function objectTypeToPackType(t: number): number {
  switch (t) {
    case OBJ_COMMIT:
      return PACK_OBJ_COMMIT;
    case OBJ_TREE:
      return PACK_OBJ_TREE;
    case OBJ_BLOB:
      return PACK_OBJ_BLOB;
    case OBJ_TAG:
      return PACK_OBJ_TAG;
    default:
      throw new Error(`buildPackfile: unknown object type ${t}`);
  }
}

/**
 * Build a v2 packfile from a list of objects.
 *
 * Objects are written in the order given. No deltas — each object is
 * stored fully and zlib-deflated. Suitable for small pushes; larger
 * pushes that benefit from delta compression should use a different code
 * path (we ship objects as fully-stored which is what `git push --no-thin`
 * produces; servers accept it).
 */
export function buildPackfile(wasm: WasmEngine, objects: ObjectToPack[]): Promise<Uint8Array> {
  // Stage 1: deflate every object and compute its on-pack entry size.
  const entries: Uint8Array[] = [];
  let bodyTotal = 12; // 4 (PACK) + 4 (version) + 4 (count)

  for (const obj of objects) {
    const packType = objectTypeToPackType(obj.type);
    const headerLen = typeSizeHeaderLen(obj.content.length);
    const compressed = wasm.zlibDeflate(obj.content);
    const entry = new Uint8Array(headerLen + compressed.length);
    writeTypeSizeHeader(entry, 0, packType, obj.content.length);
    entry.set(compressed, headerLen);
    entries.push(entry);
    bodyTotal += entry.length;
  }

  // Stage 2: assemble pack body.
  const body = new Uint8Array(bodyTotal);
  body.set(new TextEncoder().encode("PACK"), 0);
  writeUint32BE(body, 4, 2);
  writeUint32BE(body, 8, objects.length);
  let offset = 12;
  for (const e of entries) {
    body.set(e, offset);
    offset += e.length;
  }

  // Stage 3: trailer = SHA-1 of body.
  return crypto.subtle.digest("SHA-1", body).then((hash) => {
    const trailer = new Uint8Array(hash);
    const out = new Uint8Array(body.length + 20);
    out.set(body, 0);
    out.set(trailer, body.length);
    return out;
  });
}
