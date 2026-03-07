// GitEngine — orchestrates R2 (objects) and DO SQLite (refs, metadata)
//
// Storage layout:
//   R2 key:  "{repo}/objects/{sha1[0:2]}/{sha1[2:]}"  (loose objects)
//   R2 key:  "{repo}/worktrees/{branch}/{filepath}"    (materialized files)
//   SQLite:  refs, head, repo_meta, commits, permissions (per-repo DO)

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

  async getObject(sha1Hex: string): Promise<Uint8Array | null> {
    const obj = await this.objects.get(this.objectKey(sha1Hex));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async putObject(sha1Hex: string, data: Uint8Array): Promise<void> {
    await this.objects.put(this.objectKey(sha1Hex), data);
  }

  async hasObject(sha1Hex: string): Promise<boolean> {
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

  /** Batch write multiple objects to R2 in parallel. */
  async putObjects(entries: Array<{ sha1Hex: string; compressed: Uint8Array }>): Promise<void> {
    // Run up to 50 concurrent R2 PUTs
    const CONCURRENCY = 50;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(e => this.putObject(e.sha1Hex, e.compressed)));
    }
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

    const wasm = await this.getWasm();

    // Decompress with retry — compression ratios can exceed 100x for repetitive data.
    // Try increasing buffer sizes until decompression succeeds.
    // Cap at 32MB to stay within WASM arena (64MB total minus input).
    // Decompress: try WASM (libdeflate), fallback to node:zlib
    let raw: Uint8Array | null = null;
    try {
      // libdeflate needs exact or larger output buffer — try increasing sizes
      for (const multiplier of [4, 16, 64, 256]) {
        const maxSize = Math.min(
          Math.max(compressed.length * multiplier, 65536),
          32 * 1024 * 1024
        );
        const result = wasm.zlibInflate(compressed, maxSize);
        if (result.length > 0) {
          raw = result;
          break;
        }
      }
    } catch {
      // WASM trap — fall through to node:zlib
    }
    if (!raw || raw.length === 0) {
      // WASM decompression failed — fallback to node:zlib
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
        inflate.end(Buffer.from(compressed));
      });
    }

    // Parse header to extract type and content
    const spaceIdx = raw.indexOf(0x20); // space
    const nullIdx = raw.indexOf(0x00); // null
    if (spaceIdx === -1 || nullIdx === -1) return null;

    const typeStr = decoder.decode(raw.subarray(0, spaceIdx));
    const type = nameToType(typeStr);
    const content = raw.subarray(nullIdx + 1);

    return { type, content };
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
