// PackWorkerDO — edge compute worker for fan-out operations
//
// Each instance is a compute unit with its own ~128MB memory budget,
// WASM engine, and R2 access. The coordinator (RepoStore) dispatches
// work to a pool of these workers via RPC.
//
// The key principle: move compute to the data. Workers read from R2
// directly and process data locally, returning only results — not
// raw object bytes. This keeps the coordinator's memory flat.
//
// Actions:
//   build-segment   — decompress git objects, re-compress for packfile format
//   write-worktree  — read blobs from R2, write raw content to worktree paths
//   diff-blobs      — read blob pairs from R2, compute unified diffs
//   grep-blobs      — read blobs from R2, search content, return matches
//   walk-trees      — read tree objects, parse entries, return child SHAs
//
// Pool slots use deterministic IDs ("slot-{N}") for warm reuse.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { WasmEngine } from "./wasm-engine";
import { objectToPackType, writeTypeSizeHeader, typeSizeHeaderLen } from "./packfile-builder";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "./git-engine";
import { unifiedDiff, isBinary } from "./diff-engine";
import { toHex } from "./hex";

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

interface DiffPair {
  path: string;
  status: "added" | "modified" | "deleted";
  oldSha?: string;
  newSha?: string;
  // R2 location for old blob
  oldChunkKey?: string;
  oldOffset?: number;
  oldLength?: number;
  oldLooseKey?: string;
  // R2 location for new blob
  newChunkKey?: string;
  newOffset?: number;
  newLength?: number;
  newLooseKey?: string;
}

interface DiffBlobsRequest {
  repoPath: string;
  pairs: DiffPair[];
}

interface GrepEntry {
  sha: string;
  path: string;
  chunkKey?: string;
  offset?: number;
  length?: number;
  looseKey?: string;
}

interface GrepRequest {
  repoPath: string;
  pattern: string;
  entries: GrepEntry[];
  contextLines?: number;
}

interface TreeWalkEntry {
  sha: string;
  chunkKey?: string;
  offset?: number;
  length?: number;
  looseKey?: string;
}

interface TreeWalkRequest {
  repoPath: string;
  trees: TreeWalkEntry[];
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
      case "diff-blobs":
        return this.handleDiffBlobs(request);
      case "grep-blobs":
        return this.handleGrepBlobs(request);
      case "walk-trees":
        return this.handleWalkTrees(request);
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

  // === diff-blobs: read blob pairs from R2, compute unified diffs ===

  private async handleDiffBlobs(request: Request): Promise<Response> {
    const body = await request.json() as DiffBlobsRequest;
    const { repoPath, pairs } = body;
    if (!repoPath || typeof repoPath !== "string") {
      return new Response("Missing repoPath\n", { status: 400 });
    }
    if (!pairs || pairs.length === 0) {
      return Response.json({ diffs: [] });
    }
    if (pairs.length > MAX_OBJECTS_PER_BATCH) {
      return new Response("Too many pairs\n", { status: 400 });
    }

    // Validate key scope
    const repoPrefix = repoPath + "/";
    for (const p of pairs) {
      if (p.oldChunkKey && !p.oldChunkKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
      if (p.newChunkKey && !p.newChunkKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
      if (p.oldLooseKey && !p.oldLooseKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
      if (p.newLooseKey && !p.newLooseKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
    }

    const wasm = await this.getWasm();
    const r2 = this.env.OBJECTS;

    // Collect all unique chunk keys to fetch
    const allChunkKeys = new Set<string>();
    for (const p of pairs) {
      if (p.oldChunkKey) allChunkKeys.add(p.oldChunkKey);
      if (p.newChunkKey) allChunkKeys.add(p.newChunkKey);
    }
    const chunkData = await this.fetchChunks(r2, [...allChunkKeys]);

    // Process each pair
    const diffs: Array<{
      path: string;
      status: string;
      binary?: boolean;
      patch?: string;
      oldSize?: number;
      newSize?: number;
    }> = [];

    for (const pair of pairs) {
      const oldBlob = pair.oldSha ? await this.readBlobContent(wasm, r2, chunkData, {
        chunkKey: pair.oldChunkKey, offset: pair.oldOffset,
        length: pair.oldLength, looseKey: pair.oldLooseKey,
      }) : null;

      const newBlob = pair.newSha ? await this.readBlobContent(wasm, r2, chunkData, {
        chunkKey: pair.newChunkKey, offset: pair.newOffset,
        length: pair.newLength, looseKey: pair.newLooseKey,
      }) : null;

      const entry: typeof diffs[0] = {
        path: pair.path,
        status: pair.status,
        oldSize: oldBlob?.length,
        newSize: newBlob?.length,
      };

      // Check for binary
      if ((oldBlob && isBinary(oldBlob)) || (newBlob && isBinary(newBlob))) {
        entry.binary = true;
      } else {
        const oldText = oldBlob ? decoder.decode(oldBlob) : "";
        const newText = newBlob ? decoder.decode(newBlob) : "";
        entry.patch = unifiedDiff(oldText, newText, pair.path, pair.path);
      }

      diffs.push(entry);
    }

    return Response.json({ diffs });
  }

  // === grep-blobs: read blobs from R2, search content, return matches ===

  private async handleGrepBlobs(request: Request): Promise<Response> {
    const body = await request.json() as GrepRequest;
    const { repoPath, pattern, entries, contextLines = 0 } = body;
    if (!repoPath || typeof repoPath !== "string") {
      return new Response("Missing repoPath\n", { status: 400 });
    }
    if (!pattern || typeof pattern !== "string") {
      return new Response("Missing pattern\n", { status: 400 });
    }
    if (!entries || entries.length === 0) {
      return Response.json({ matches: [] });
    }
    if (entries.length > MAX_OBJECTS_PER_BATCH) {
      return new Response("Too many entries\n", { status: 400 });
    }

    // Validate key scope
    const repoPrefix = repoPath + "/";
    for (const e of entries) {
      if (e.chunkKey && !e.chunkKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
      if (e.looseKey && !e.looseKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "gm");
    } catch {
      return new Response("Invalid regex pattern\n", { status: 400 });
    }

    const wasm = await this.getWasm();
    const r2 = this.env.OBJECTS;

    // Fetch all chunks
    const allChunkKeys = new Set<string>();
    for (const e of entries) {
      if (e.chunkKey) allChunkKeys.add(e.chunkKey);
    }
    const chunkData = await this.fetchChunks(r2, [...allChunkKeys]);

    const matches: Array<{
      path: string;
      sha: string;
      lines: Array<{ lineNumber: number; text: string; isMatch: boolean }>;
    }> = [];

    const clampedContext = Math.min(contextLines, 10);

    for (const entry of entries) {
      const content = await this.readBlobContent(wasm, r2, chunkData, entry);
      if (!content || isBinary(content)) continue;

      const text = decoder.decode(content);
      const lines = text.split("\n");
      const matchedLineNums = new Set<number>();

      // Find all matching lines
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matchedLineNums.add(i);
        }
      }

      if (matchedLineNums.size === 0) continue;

      // Collect matched lines + context
      const outputLines: Array<{ lineNumber: number; text: string; isMatch: boolean }> = [];
      const includedLines = new Set<number>();
      for (const ln of matchedLineNums) {
        for (let c = Math.max(0, ln - clampedContext); c <= Math.min(lines.length - 1, ln + clampedContext); c++) {
          if (!includedLines.has(c)) {
            includedLines.add(c);
            outputLines.push({ lineNumber: c + 1, text: lines[c], isMatch: matchedLineNums.has(c) });
          }
        }
      }
      outputLines.sort((a, b) => a.lineNumber - b.lineNumber);
      matches.push({ path: entry.path, sha: entry.sha, lines: outputLines });
    }

    return Response.json({ matches });
  }

  // === walk-trees: read tree objects, parse entries, return child SHAs ===

  private async handleWalkTrees(request: Request): Promise<Response> {
    const body = await request.json() as TreeWalkRequest;
    const { repoPath, trees } = body;
    if (!repoPath || typeof repoPath !== "string") {
      return new Response("Missing repoPath\n", { status: 400 });
    }
    if (!trees || trees.length === 0) {
      return Response.json({ results: [] });
    }
    if (trees.length > MAX_OBJECTS_PER_BATCH) {
      return new Response("Too many trees\n", { status: 400 });
    }

    const repoPrefix = repoPath + "/";
    for (const t of trees) {
      if (t.chunkKey && !t.chunkKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
      if (t.looseKey && !t.looseKey.startsWith(repoPrefix)) return new Response("Invalid key scope\n", { status: 400 });
    }

    const wasm = await this.getWasm();
    const r2 = this.env.OBJECTS;

    const allChunkKeys = new Set<string>();
    for (const t of trees) {
      if (t.chunkKey) allChunkKeys.add(t.chunkKey);
    }
    const chunkData = await this.fetchChunks(r2, [...allChunkKeys]);

    const results: Array<{
      sha: string;
      entries: Array<{ mode: string; name: string; sha: string }>;
    }> = [];

    for (const tree of trees) {
      const raw = await this.readRawObject(wasm, r2, chunkData, tree);
      if (!raw) continue;

      // Parse "tree size\0" header
      const nullIdx = raw.indexOf(0x00);
      if (nullIdx === -1) continue;
      const typeStr = decoder.decode(raw.subarray(0, raw.indexOf(0x20)));
      if (typeStr !== "tree") continue;

      const data = raw.subarray(nullIdx + 1);
      const entries: Array<{ mode: string; name: string; sha: string }> = [];
      let pos = 0;

      while (pos < data.length) {
        const spaceIdx = data.indexOf(0x20, pos);
        if (spaceIdx === -1) break;
        const nullPos = data.indexOf(0x00, spaceIdx + 1);
        if (nullPos === -1 || nullPos + 21 > data.length) break;

        const mode = decoder.decode(data.subarray(pos, spaceIdx));
        const name = decoder.decode(data.subarray(spaceIdx + 1, nullPos));
        const sha = toHex(data.subarray(nullPos + 1, nullPos + 21));
        entries.push({ mode, name, sha });
        pos = nullPos + 21;
      }

      results.push({ sha: tree.sha, entries });
    }

    return Response.json({ results });
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

  /** Read a blob from R2, decompress, return raw content (no git header). */
  private async readBlobContent(
    wasm: WasmEngine,
    r2: R2Bucket,
    chunkData: Map<string, Uint8Array>,
    loc: { chunkKey?: string; offset?: number; length?: number; looseKey?: string },
  ): Promise<Uint8Array | null> {
    let compressed: Uint8Array | null = null;
    if (loc.chunkKey && loc.offset !== undefined && loc.length !== undefined) {
      const chunk = chunkData.get(loc.chunkKey);
      if (chunk) compressed = chunk.subarray(loc.offset, loc.offset + loc.length);
    } else if (loc.looseKey) {
      const obj = await r2.get(loc.looseKey);
      if (obj) compressed = new Uint8Array(await obj.arrayBuffer());
    }
    if (!compressed) return null;
    return this.decompressBlob(wasm, compressed);
  }

  /** Read a raw git object from R2 (full "type size\0content" form). */
  private async readRawObject(
    wasm: WasmEngine,
    r2: R2Bucket,
    chunkData: Map<string, Uint8Array>,
    loc: { chunkKey?: string; offset?: number; length?: number; looseKey?: string },
  ): Promise<Uint8Array | null> {
    let compressed: Uint8Array | null = null;
    if (loc.chunkKey && loc.offset !== undefined && loc.length !== undefined) {
      const chunk = chunkData.get(loc.chunkKey);
      if (chunk) compressed = chunk.subarray(loc.offset, loc.offset + loc.length);
    } else if (loc.looseKey) {
      const obj = await r2.get(loc.looseKey);
      if (obj) compressed = new Uint8Array(await obj.arrayBuffer());
    }
    if (!compressed) return null;
    return this.inflateObject(wasm, compressed);
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
    let compressedView: Uint8Array;
    try {
      // Zero-copy view — consumed immediately by entry.set() below
      compressedView = wasm.zlibDeflateView(content);
    } catch (err) {
      console.error(`pack-worker: deflate failed (${content.length} bytes): ${err}`);
      return null;
    }
    if (compressedView.length === 0) return null;

    // Build packfile entry: type/size header + compressed content
    const packType = objectToPackType(type);
    const headerLen = typeSizeHeaderLen(content.length);
    const entry = new Uint8Array(headerLen + compressedView.length);
    writeTypeSizeHeader(entry, 0, packType, content.length);
    entry.set(compressedView, headerLen);  // copies from WASM view into entry
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
