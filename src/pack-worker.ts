// PackWorkerDO — fan-out worker for parallel packfile assembly
//
// Receives a batch of object descriptors (SHA + R2 location),
// reads and decompresses each from R2, re-compresses for packfile
// format, and returns the assembled packfile segment.
//
// Used by RepoStore to distribute packfile building across a pool
// of workers, keeping each under the DO memory limit (~128MB).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { WasmEngine } from "./wasm-engine";
import { objectToPackType, writeTypeSizeHeader, typeSizeHeaderLen } from "./packfile-builder";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";

const decoder = new TextDecoder();

interface ObjectDescriptor {
  sha: string;
  chunkKey?: string;
  offset?: number;
  length?: number;
  looseKey?: string;
}

interface BuildRequest {
  repoPath: string;
  objects: ObjectDescriptor[];
}

function nameToType(name: string): number {
  switch (name) {
    case "blob": return OBJ_BLOB;
    case "tree": return OBJ_TREE;
    case "commit": return OBJ_COMMIT;
    case "tag": return OBJ_TAG;
    default: return 0;
  }
}

export class PackWorkerDO extends DurableObject<Env> {
  private wasm: WasmEngine | null = null;

  private async getWasm(): Promise<WasmEngine> {
    if (!this.wasm) this.wasm = await WasmEngine.create();
    return this.wasm;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-action") !== "build-segment") {
      return new Response("Unknown action\n", { status: 400 });
    }

    const body = await request.json() as BuildRequest;
    const { objects } = body;
    if (!objects || objects.length === 0) {
      return new Response(new Uint8Array(0), {
        headers: { "content-type": "application/octet-stream", "x-object-count": "0" },
      });
    }

    const wasm = await this.getWasm();
    const r2 = this.env.OBJECTS;

    // Group objects by chunk key for efficient R2 reads
    const byChunk = new Map<string, ObjectDescriptor[]>();
    const loose: ObjectDescriptor[] = [];
    for (const desc of objects) {
      if (desc.chunkKey) {
        let list = byChunk.get(desc.chunkKey);
        if (!list) { list = []; byChunk.set(desc.chunkKey, list); }
        list.push(desc);
      } else {
        loose.push(desc);
      }
    }

    // Fetch chunks (10 concurrent)
    const chunkData = new Map<string, Uint8Array>();
    const chunkKeys = [...byChunk.keys()];
    const CONCURRENCY = 10;
    for (let i = 0; i < chunkKeys.length; i += CONCURRENCY) {
      const batch = chunkKeys.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async key => {
          const obj = await r2.get(key);
          if (!obj) return { key, data: null };
          return { key, data: new Uint8Array(await obj.arrayBuffer()) };
        })
      );
      for (const { key, data } of results) {
        if (data) chunkData.set(key, data);
      }
    }

    // Build packfile entries
    const entries: Uint8Array[] = [];
    let objectCount = 0;

    // Process chunk-indexed objects
    for (const [chunkKey, descs] of byChunk) {
      const data = chunkData.get(chunkKey);
      if (!data) continue;

      for (const desc of descs) {
        if (desc.offset === undefined || desc.length === undefined) continue;
        const compressed = data.subarray(desc.offset, desc.offset + desc.length);
        const entry = this.buildEntry(wasm, compressed);
        if (entry) { entries.push(entry); objectCount++; }
      }
    }

    // Process loose objects
    for (let i = 0; i < loose.length; i += CONCURRENCY) {
      const batch = loose.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async desc => {
          const key = desc.looseKey!;
          const obj = await r2.get(key);
          if (!obj) return null;
          return new Uint8Array(await obj.arrayBuffer());
        })
      );
      for (const compressed of results) {
        if (!compressed) continue;
        const entry = this.buildEntry(wasm, compressed);
        if (entry) { entries.push(entry); objectCount++; }
      }
    }

    // Concatenate entries
    let totalSize = 0;
    for (const e of entries) totalSize += e.length;
    const segment = new Uint8Array(totalSize);
    let offset = 0;
    for (const e of entries) {
      segment.set(e, offset);
      offset += e.length;
    }

    return new Response(segment, {
      headers: {
        "content-type": "application/octet-stream",
        "x-object-count": String(objectCount),
      },
    });
  }

  /** Decompress a git object, re-compress content for packfile format. */
  private buildEntry(wasm: WasmEngine, compressed: Uint8Array): Uint8Array | null {
    // Decompress git object
    let raw: Uint8Array | null = null;
    const sizes = [4, 16, 64, 256];
    for (const mult of sizes) {
      const maxSize = compressed.length * mult;
      if (maxSize > 32 * 1024 * 1024) break;
      try {
        raw = wasm.zlibInflate(compressed, maxSize);
        if (raw.length > 0) break;
        raw = null;
      } catch { raw = null; }
    }
    if (!raw || raw.length === 0) return null;

    // Parse "type size\0content"
    const spaceIdx = raw.indexOf(0x20);
    const nullIdx = raw.indexOf(0x00);
    if (spaceIdx === -1 || nullIdx === -1) return null;

    const typeStr = decoder.decode(raw.subarray(0, spaceIdx));
    const type = nameToType(typeStr);
    if (type === 0) return null;

    const content = raw.subarray(nullIdx + 1);

    // Re-compress raw content for packfile (different from git object compression)
    let packCompressed: Uint8Array;
    try {
      packCompressed = wasm.zlibDeflate(content);
    } catch { return null; }
    if (packCompressed.length === 0) return null;

    // Build packfile entry: type/size header + compressed content
    const packType = objectToPackType(type);
    const headerLen = typeSizeHeaderLen(content.length);
    const entry = new Uint8Array(headerLen + packCompressed.length);
    writeTypeSizeHeader(entry, 0, packType, content.length);
    entry.set(packCompressed, headerLen);
    return entry;
  }
}
