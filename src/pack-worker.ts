// PackWorkerDO — general-purpose compute worker for fan-out operations
//
// Each instance is a compute unit with its own ~128MB memory budget,
// WASM engine, and R2 access. The coordinator (RepoStore) dispatches
// work to a pool of these workers via RPC.
//
// Actions:
//   build-segment   — decompress git objects, re-compress for packfile format
//   write-worktree  — read blobs from R2, write raw content to worktree paths
//
// Pool slots use deterministic IDs ("slot-{N}") for warm reuse.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { WasmEngine } from "./wasm-engine";
import { objectToPackType, writeTypeSizeHeader, typeSizeHeaderLen } from "./packfile-builder";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";

const decoder = new TextDecoder();
const MAX_OBJECTS_PER_BATCH = 1000;

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

interface WorktreeEntry {
  blobSha: string;
  r2Key: string;
  chunkKey?: string;
  offset?: number;
  length?: number;
  looseKey?: string;
}

interface WorktreeRequest {
  repoPath: string;
  entries: WorktreeEntry[];
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
    const action = request.headers.get("x-action");

    switch (action) {
      case "build-segment":
        return this.handleBuildSegment(request);
      case "write-worktree":
        return this.handleWriteWorktree(request);
      default:
        return new Response("Unknown action\n", { status: 400 });
    }
  }

  // === build-segment: decompress + re-compress objects for packfile ===

  private async handleBuildSegment(request: Request): Promise<Response> {
    const body = await request.json() as BuildRequest;
    const { repoPath, objects } = body;
    if (!repoPath || typeof repoPath !== "string") {
      return new Response("Missing repoPath\n", { status: 400 });
    }
    if (!objects || objects.length === 0) {
      return new Response(new Uint8Array(0), {
        headers: { "content-type": "application/octet-stream", "x-object-count": "0" },
      });
    }
    if (objects.length > MAX_OBJECTS_PER_BATCH) {
      return new Response("Too many objects\n", { status: 400 });
    }

    // Validate all R2 keys are scoped to this repo (prevent cross-repo reads)
    if (!this.validateKeyScope(repoPath, objects)) {
      return new Response("Invalid key scope\n", { status: 400 });
    }

    const wasm = await this.getWasm();
    const r2 = this.env.OBJECTS;

    // Group objects by chunk key for efficient R2 reads
    const { byChunk, loose } = groupByChunk(objects);

    // Fetch chunks (10 concurrent)
    const chunkData = await this.fetchChunks(r2, [...byChunk.keys()]);

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
        const entry = this.buildPackEntry(wasm, compressed);
        if (entry) { entries.push(entry); objectCount++; }
      }
    }

    // Process loose objects
    const CONCURRENCY = 10;
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
        const entry = this.buildPackEntry(wasm, compressed);
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

  // === write-worktree: read blobs from R2, write raw content to worktree paths ===

  private async handleWriteWorktree(request: Request): Promise<Response> {
    const body = await request.json() as WorktreeRequest;
    const { repoPath, entries } = body;
    if (!repoPath || typeof repoPath !== "string") {
      return new Response("Missing repoPath\n", { status: 400 });
    }
    if (!entries || entries.length === 0) {
      return Response.json({ written: 0 });
    }
    if (entries.length > MAX_OBJECTS_PER_BATCH) {
      return new Response("Too many entries\n", { status: 400 });
    }

    // Validate all keys are scoped to this repo
    const repoPrefix = repoPath + "/";
    for (const entry of entries) {
      if (entry.chunkKey && !entry.chunkKey.startsWith(repoPrefix)) {
        return new Response("Invalid key scope\n", { status: 400 });
      }
      if (entry.looseKey && !entry.looseKey.startsWith(repoPrefix)) {
        return new Response("Invalid key scope\n", { status: 400 });
      }
      if (!entry.r2Key.startsWith(repoPrefix)) {
        return new Response("Invalid worktree key scope\n", { status: 400 });
      }
    }

    const wasm = await this.getWasm();
    const r2 = this.env.OBJECTS;

    // Group by chunk key
    const byChunk = new Map<string, WorktreeEntry[]>();
    const loose: WorktreeEntry[] = [];
    for (const entry of entries) {
      if (entry.chunkKey) {
        let list = byChunk.get(entry.chunkKey);
        if (!list) { list = []; byChunk.set(entry.chunkKey, list); }
        list.push(entry);
      } else {
        loose.push(entry);
      }
    }

    // Fetch chunks
    const chunkData = await this.fetchChunks(r2, [...byChunk.keys()]);

    let written = 0;
    const WRITE_CONCURRENCY = 50;
    const writes: Promise<void>[] = [];

    // Process chunk-indexed blobs
    for (const [chunkKey, chunkEntries] of byChunk) {
      const data = chunkData.get(chunkKey);
      if (!data) continue;

      for (const entry of chunkEntries) {
        if (entry.offset === undefined || entry.length === undefined) continue;
        const compressed = data.subarray(entry.offset, entry.offset + entry.length);
        const content = this.decompressBlob(wasm, compressed);
        if (content) {
          writes.push(r2.put(entry.r2Key, content));
          written++;
          if (writes.length >= WRITE_CONCURRENCY) {
            await Promise.all(writes.splice(0));
          }
        }
      }
    }

    // Process loose blobs
    const CONCURRENCY = 10;
    for (let i = 0; i < loose.length; i += CONCURRENCY) {
      const batch = loose.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async entry => {
          const key = entry.looseKey!;
          const obj = await r2.get(key);
          if (!obj) return { entry, compressed: null as Uint8Array | null };
          return { entry, compressed: new Uint8Array(await obj.arrayBuffer()) };
        })
      );
      for (const { entry, compressed } of results) {
        if (!compressed) continue;
        const content = this.decompressBlob(wasm, compressed);
        if (content) {
          writes.push(r2.put(entry.r2Key, content));
          written++;
          if (writes.length >= WRITE_CONCURRENCY) {
            await Promise.all(writes.splice(0));
          }
        }
      }
    }

    // Flush remaining writes
    if (writes.length > 0) await Promise.all(writes);

    return Response.json({ written });
  }

  // === Shared utilities ===

  private validateKeyScope(repoPath: string, objects: ObjectDescriptor[]): boolean {
    const repoPrefix = repoPath + "/";
    for (const desc of objects) {
      if (desc.chunkKey && !desc.chunkKey.startsWith(repoPrefix)) return false;
      if (desc.looseKey && !desc.looseKey.startsWith(repoPrefix)) return false;
    }
    return true;
  }

  private async fetchChunks(r2: R2Bucket, keys: string[]): Promise<Map<string, Uint8Array>> {
    const CONCURRENCY = 10;
    const chunkData = new Map<string, Uint8Array>();
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const batch = keys.slice(i, i + CONCURRENCY);
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
    return chunkData;
  }

  /** Decompress a git object, extract blob content (for worktree writes). */
  private decompressBlob(wasm: WasmEngine, compressed: Uint8Array): Uint8Array | null {
    const raw = this.inflateObject(wasm, compressed);
    if (!raw) return null;

    // Parse "type size\0content" — only extract blobs
    const spaceIdx = raw.indexOf(0x20);
    const nullIdx = raw.indexOf(0x00);
    if (spaceIdx === -1 || nullIdx === -1) return null;

    const typeStr = decoder.decode(raw.subarray(0, spaceIdx));
    if (typeStr !== "blob") return null;

    return raw.subarray(nullIdx + 1);
  }

  /** Decompress a git object, re-compress content for packfile format. */
  private buildPackEntry(wasm: WasmEngine, compressed: Uint8Array): Uint8Array | null {
    const raw = this.inflateObject(wasm, compressed);
    if (!raw) return null;

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
    } catch (err) {
      console.error(`pack-worker: deflate failed (${content.length} bytes): ${err}`);
      return null;
    }
    if (packCompressed.length === 0) return null;

    // Build packfile entry: type/size header + compressed content
    const packType = objectToPackType(type);
    const headerLen = typeSizeHeaderLen(content.length);
    const entry = new Uint8Array(headerLen + packCompressed.length);
    writeTypeSizeHeader(entry, 0, packType, content.length);
    entry.set(packCompressed, headerLen);
    return entry;
  }

  /** Inflate a zlib-compressed git object, trying increasing buffer sizes. */
  private inflateObject(wasm: WasmEngine, compressed: Uint8Array): Uint8Array | null {
    const sizes = [4, 16, 64, 256];
    for (const mult of sizes) {
      const maxSize = compressed.length * mult;
      if (maxSize > 32 * 1024 * 1024) break;
      try {
        const raw = wasm.zlibInflate(compressed, maxSize);
        if (raw.length > 0) return raw;
      } catch (err) {
        if (mult === sizes[sizes.length - 1]) {
          console.error(`pack-worker: inflate failed after all attempts (${compressed.length} bytes): ${err}`);
        }
      }
    }
    return null;
  }
}

function groupByChunk(objects: ObjectDescriptor[]): {
  byChunk: Map<string, ObjectDescriptor[]>;
  loose: ObjectDescriptor[];
} {
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
  return { byChunk, loose };
}
