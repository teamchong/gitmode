// GitEngine — orchestrates R2 (objects) and DO SQLite (refs, metadata)
//
// Storage layout:
//   R2 key:  "{repo}/chunks/{uuid}"                    (~2MB bundled objects, primary)
//   R2 key:  "{repo}/objects/{sha1[0:2]}/{sha1[2:]}"  (loose objects, legacy fallback)
//   R2 key:  "{repo}/worktrees/{branch}/{filepath}"    (materialized files)
//   SQLite:  refs, head, repo_meta, commits, permissions, object_chunks, file_sizes

import { WasmEngine } from "./wasm-engine";
import { toHex } from "./hex";

// Object types matching Zig enum
export const OBJ_BLOB = 1;
export const OBJ_TREE = 2;
export const OBJ_COMMIT = 3;
export const OBJ_TAG = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class GitEngine {
  private objects: R2Bucket;
  private repo: string;
  private sql: SqlStorage | null;
  private wasm: WasmEngine | null = null;

  constructor(objects: R2Bucket, repo: string, sql: SqlStorage | null = null) {
    this.objects = objects;
    this.repo = repo;
    this.sql = sql;
  }

  private async getWasm(): Promise<WasmEngine> {
    if (!this.wasm) {
      this.wasm = await WasmEngine.create();
    }
    return this.wasm;
  }

  private requireSql(): SqlStorage {
    if (!this.sql) throw new Error("GitEngine: no SQL storage (ref operations require a DO context)");
    return this.sql;
  }

  // === Object storage (R2) ===

  private objectKey(sha1Hex: string): string {
    return `${this.repo}/objects/${sha1Hex.slice(0, 2)}/${sha1Hex.slice(2)}`;
  }

  private async getObject(sha1Hex: string): Promise<Uint8Array | null> {
    // Check chunk index first (SQLite lookup, then R2 range read)
    if (this.sql) {
      const rows = [...this.sql.exec(
        "SELECT chunk_key, byte_offset, byte_length FROM object_chunks WHERE sha = ?",
        sha1Hex
      )];
      if (rows.length > 0) {
        const obj = await this.objects.get(rows[0].chunk_key as string, {
          range: { offset: rows[0].byte_offset as number, length: rows[0].byte_length as number },
        });
        if (obj) return new Uint8Array(await obj.arrayBuffer());
      }
    }
    // Fall back to loose object
    const obj = await this.objects.get(this.objectKey(sha1Hex));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  private async putObject(sha1Hex: string, data: Uint8Array): Promise<void> {
    await this.objects.put(this.objectKey(sha1Hex), data);
  }

  async hasObject(sha1Hex: string): Promise<boolean> {
    // Check chunk index first (pure SQLite — no R2 round trip)
    if (this.sql) {
      const rows = [...this.sql.exec(
        "SELECT 1 FROM object_chunks WHERE sha = ?", sha1Hex
      )];
      if (rows.length > 0) return true;
    }
    const head = await this.objects.head(this.objectKey(sha1Hex));
    return head !== null;
  }

  /** Store a git object (type + content), returns sha1 hex. */
  async storeObject(
    type: number,
    content: Uint8Array
  ): Promise<string> {
    const wasm = await this.getWasm();
    const { sha1Hex, compressed } = this.prepareObject(wasm, type, content);
    await this.putObject(sha1Hex, compressed);
    return sha1Hex;
  }

  /** Prepare an object for storage (hash + compress) without writing to R2. */
  prepareObject(
    wasm: WasmEngine,
    type: number,
    content: Uint8Array,
  ): { sha1Hex: string; compressed: Uint8Array } {
    const digest = wasm.hashObject(type, content);
    const sha1Hex = toHex(digest);
    const header = encoder.encode(
      `${typeToName(type)} ${content.length}\0`
    );
    const full = new Uint8Array(header.length + content.length);
    full.set(header);
    full.set(content, header.length);
    const compressed = wasm.zlibDeflate(full);
    return { sha1Hex, compressed };
  }

  /** Batch write multiple objects to R2, bundled into ~2MB chunks with SQLite index. */
  async putObjects(entries: Array<{ sha1Hex: string; compressed: Uint8Array }>): Promise<void> {
    if (!this.sql || entries.length === 0) {
      // No DO context — fall back to individual puts
      const CONCURRENCY = 50;
      for (let i = 0; i < entries.length; i += CONCURRENCY) {
        const batch = entries.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(e => this.putObject(e.sha1Hex, e.compressed)));
      }
      return;
    }

    // Bundle objects into ~2MB chunks, store each chunk as one R2 key
    const CHUNK_TARGET = 2 * 1024 * 1024;
    let parts: Uint8Array[] = [];
    let currentSize = 0;
    let indexEntries: Array<{ sha: string; offset: number; length: number }> = [];

    for (const entry of entries) {
      indexEntries.push({
        sha: entry.sha1Hex,
        offset: currentSize,
        length: entry.compressed.length,
      });
      parts.push(entry.compressed);
      currentSize += entry.compressed.length;

      if (currentSize >= CHUNK_TARGET) {
        await this.flushChunk(parts, currentSize, indexEntries);
        parts = [];
        currentSize = 0;
        indexEntries = [];
      }
    }

    if (indexEntries.length > 0) {
      await this.flushChunk(parts, currentSize, indexEntries);
    }
  }

  private async flushChunk(
    parts: Uint8Array[],
    totalSize: number,
    entries: Array<{ sha: string; offset: number; length: number }>,
  ): Promise<void> {
    // Concatenate parts into a single blob
    const blob = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) {
      blob.set(part, pos);
      pos += part.length;
    }

    const chunkKey = `${this.repo}/chunks/${crypto.randomUUID()}`;
    await this.objects.put(chunkKey, blob);

    // Index all objects in this chunk
    const sql = this.sql!;
    for (const e of entries) {
      sql.exec(
        "INSERT OR IGNORE INTO object_chunks (sha, chunk_key, byte_offset, byte_length) VALUES (?, ?, ?, ?)",
        e.sha, chunkKey, e.offset, e.length
      );
    }
  }

  /**
   * Batch read multiple objects, grouping by chunk for efficiency.
   * Returns a Map of sha -> { type, content }.
   * For 10K objects across 50 chunks, this does ~50 R2 GETs instead of 10K.
   */
  async readObjects(
    shas: string[]
  ): Promise<Map<string, { type: number; content: Uint8Array }>> {
    const result = new Map<string, { type: number; content: Uint8Array }>();
    if (shas.length === 0) return result;

    // Ensure WASM is initialized before decompressObject calls in Phase 1
    await this.getWasm();

    let remaining = shas;

    // Phase 1: batch-read from chunk index (group by chunk_key)
    if (this.sql) {
      const indexed = new Map<string, { chunk_key: string; offset: number; length: number }>();
      for (let i = 0; i < shas.length; i += 100) {
        const batch = shas.slice(i, i + 100);
        const params = batch.map(() => "?").join(",");
        for (const row of this.sql.exec(
          `SELECT sha, chunk_key, byte_offset, byte_length FROM object_chunks WHERE sha IN (${params})`,
          ...batch
        )) {
          indexed.set(row.sha as string, {
            chunk_key: row.chunk_key as string,
            offset: row.byte_offset as number,
            length: row.byte_length as number,
          });
        }
      }

      if (indexed.size > 0) {
        // Group by chunk_key
        const byChunk = new Map<string, Array<{ sha: string; offset: number; length: number }>>();
        for (const [sha, info] of indexed) {
          let arr = byChunk.get(info.chunk_key);
          if (!arr) { arr = []; byChunk.set(info.chunk_key, arr); }
          arr.push({ sha, offset: info.offset, length: info.length });
        }

        // Fetch each chunk once, extract all objects
        const CONCURRENCY = 10;
        const chunkKeys = [...byChunk.keys()];
        for (let i = 0; i < chunkKeys.length; i += CONCURRENCY) {
          const batch = chunkKeys.slice(i, i + CONCURRENCY);
          const fetched = await Promise.all(
            batch.map(key => this.objects.get(key).then(obj => ({ key, obj })))
          );
          for (const { key, obj } of fetched) {
            if (!obj) continue;
            const data = new Uint8Array(await obj.arrayBuffer());
            for (const e of byChunk.get(key)!) {
              const compressed = data.subarray(e.offset, e.offset + e.length);
              const parsed = await this.decompressObject(compressed);
              if (parsed) result.set(e.sha, parsed);
            }
          }
        }

        remaining = shas.filter(s => !result.has(s));
      }
    }

    // Phase 2: fall back to individual loose object reads
    if (remaining.length > 0) {
      const CONCURRENCY = 50;
      for (let i = 0; i < remaining.length; i += CONCURRENCY) {
        const batch = remaining.slice(i, i + CONCURRENCY);
        const fetched = await Promise.all(
          batch.map(sha => this.readObject(sha).then(obj => ({ sha, obj })))
        );
        for (const { sha, obj } of fetched) {
          if (obj) result.set(sha, obj);
        }
      }
    }

    return result;
  }

  /** Decompress a raw git object (zlib compressed full object with header). */
  private async decompressObject(
    compressed: Uint8Array
  ): Promise<{ type: number; content: Uint8Array } | null> {
    let raw: Uint8Array | null = null;

    if (this.wasm) {
      try {
        for (const multiplier of [4, 16, 64, 256]) {
          const maxSize = Math.min(
            Math.max(compressed.length * multiplier, 65536),
            32 * 1024 * 1024
          );
          const result = this.wasm.zlibInflate(compressed, maxSize);
          if (result.length > 0) { raw = result; break; }
        }
      } catch {
        // WASM trap — fall through to node:zlib
      }
    }

    if (!raw || raw.length === 0) {
      try {
        const { createInflate } = await import("node:zlib");
        raw = await new Promise<Uint8Array>((resolve, reject) => {
          const inflate = createInflate();
          const chunks: Buffer[] = [];
          inflate.on("data", (chunk: Buffer) => chunks.push(chunk));
          inflate.on("end", () => {
            const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
            const data = new Uint8Array(totalLen);
            let pos = 0;
            for (const c of chunks) { data.set(c, pos); pos += c.length; }
            resolve(data);
          });
          inflate.on("error", reject);
          inflate.end(Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength));
        });
      } catch {
        return null;
      }
    }

    const spaceIdx = raw.indexOf(0x20);
    const nullIdx = raw.indexOf(0x00);
    if (spaceIdx === -1 || nullIdx === -1) return null;

    const typeStr = decoder.decode(raw.subarray(0, spaceIdx));
    return { type: nameToType(typeStr), content: raw.subarray(nullIdx + 1) };
  }

  getWasmPublic(): Promise<WasmEngine> {
    return this.getWasm();
  }

  /** Read and decompress a git object. Returns { type, content }. */
  async readObject(
    sha1Hex: string
  ): Promise<{ type: number; content: Uint8Array } | null> {
    const compressed = await this.getObject(sha1Hex);
    if (!compressed) return null;
    // Ensure WASM is initialized before calling decompressObject
    await this.getWasm();
    return this.decompressObject(compressed);
  }

  // === Refs (DO SQLite) ===

  getRef(refname: string): string | null {
    const sql = this.requireSql();
    const rows = [...sql.exec("SELECT sha FROM refs WHERE name = ?", refname)];
    return rows.length > 0 ? (rows[0].sha as string) : null;
  }

  setRef(refname: string, sha1Hex: string): void {
    const sql = this.requireSql();
    sql.exec("INSERT OR REPLACE INTO refs (name, sha) VALUES (?, ?)", refname, sha1Hex);
  }

  deleteRef(refname: string): void {
    const sql = this.requireSql();
    sql.exec("DELETE FROM refs WHERE name = ?", refname);
  }

  listRefs(): Map<string, string> {
    const sql = this.requireSql();
    const refs = new Map<string, string>();
    for (const row of sql.exec("SELECT name, sha FROM refs")) {
      refs.set(row.name as string, row.sha as string);
    }
    return refs;
  }

  getHead(): string | null {
    const sql = this.requireSql();
    const rows = [...sql.exec("SELECT value FROM head WHERE id = 1")];
    return rows.length > 0 ? (rows[0].value as string) : null;
  }

  setHead(value: string): void {
    const sql = this.requireSql();
    sql.exec("INSERT OR REPLACE INTO head (id, value) VALUES (1, ?)", value);
  }

  // === Metadata (DO SQLite) ===

  ensureRepo(): void {
    const sql = this.requireSql();
    const [owner, name] = this.repo.split("/");
    const rows = [...sql.exec("SELECT id FROM repo_meta WHERE id = 1")];
    if (rows.length === 0) {
      sql.exec(
        "INSERT INTO repo_meta (id, owner, name, created_at) VALUES (1, ?, ?, ?)",
        owner, name, new Date().toISOString()
      );
    }
  }

  getRepoMeta(): Record<string, unknown> | null {
    const sql = this.requireSql();
    const rows = [...sql.exec("SELECT * FROM repo_meta WHERE id = 1")];
    if (rows.length === 0) return null;
    return rows[0] as Record<string, unknown>;
  }

  updateRepoMeta(fields: Record<string, string>): void {
    const sql = this.requireSql();
    const allowed = ["description", "visibility", "default_branch"];
    const sets: string[] = [];
    const values: string[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    sql.exec(`UPDATE repo_meta SET ${sets.join(", ")} WHERE id = 1`, ...values);
  }

  indexFileSize(sha: string, size: number): void {
    if (!this.sql) return; // no-op outside DO context (e.g. unit tests)
    this.sql.exec("INSERT OR IGNORE INTO file_sizes (sha, size) VALUES (?, ?)", sha, size);
  }

  getFileSizes(shas: string[]): Map<string, number> {
    if (shas.length === 0) return new Map();
    const sql = this.requireSql();
    const result = new Map<string, number>();
    // Cloudflare DO SQLite limits to 100 bind variables
    for (let i = 0; i < shas.length; i += 100) {
      const batch = shas.slice(i, i + 100);
      const params = batch.map(() => "?").join(",");
      for (const row of sql.exec(`SELECT sha, size FROM file_sizes WHERE sha IN (${params})`, ...batch)) {
        result.set(row.sha as string, row.size as number);
      }
    }
    return result;
  }

  getContributors(): Array<{ name: string; commits: number; lastCommit: number }> {
    const sql = this.requireSql();
    const rows = [...sql.exec(
      `SELECT author, COUNT(*) as commits, MAX(timestamp) as lastCommit
       FROM commits GROUP BY author ORDER BY commits DESC`
    )];
    return rows.map(r => ({
      name: r.author as string,
      commits: r.commits as number,
      lastCommit: r.lastCommit as number,
    }));
  }

  getCommitCount(): number {
    const sql = this.requireSql();
    const rows = [...sql.exec("SELECT COUNT(*) as cnt FROM commits")];
    return (rows[0]?.cnt as number) ?? 0;
  }

  indexCommit(
    sha1Hex: string,
    author: string,
    message: string,
    timestamp: number
  ): void {
    const sql = this.requireSql();
    sql.exec(
      "INSERT OR IGNORE INTO commits (sha, author, message, timestamp) VALUES (?, ?, ?, ?)",
      sha1Hex, author, message, timestamp
    );
  }
}

function typeToName(type: number): string {
  switch (type) {
    case OBJ_BLOB:
      return "blob";
    case OBJ_TREE:
      return "tree";
    case OBJ_COMMIT:
      return "commit";
    case OBJ_TAG:
      return "tag";
    default:
      throw new Error(`Unknown object type: ${type}`);
  }
}

function nameToType(name: string): number {
  switch (name) {
    case "blob":
      return OBJ_BLOB;
    case "tree":
      return OBJ_TREE;
    case "commit":
      return OBJ_COMMIT;
    case "tag":
      return OBJ_TAG;
    default:
      throw new Error(`Unknown object type name: ${name}`);
  }
}
