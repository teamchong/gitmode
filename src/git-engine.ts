// GitEngine — orchestrates R2 (objects) and DO SQLite (refs, metadata)
//
// Storage layout:
//   R2 key:  "{repo}/objects/{sha1[0:2]}/{sha1[2:]}"  (loose objects)
//   R2 key:  "{repo}/worktrees/{branch}/{filepath}"    (materialized files)
//   SQLite:  refs, head, repo_meta, commits, permissions (per-repo DO)

import { WasmEngine } from "./wasm-engine";

// Object types matching Zig enum
export const OBJ_BLOB = 1;
export const OBJ_TREE = 2;
export const OBJ_COMMIT = 3;
export const OBJ_TAG = 4;

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
    const digest = wasm.hashObject(type, content);
    const sha1Hex = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Compress and store
    const header = new TextEncoder().encode(
      `${typeToName(type)} ${content.length}\0`
    );
    const full = new Uint8Array(header.length + content.length);
    full.set(header);
    full.set(content, header.length);

    const compressed = wasm.zlibDeflate(full);
    await this.putObject(sha1Hex, compressed);

    return sha1Hex;
  }

  /** Read and decompress a git object. Returns { type, content }. */
  async readObject(
    sha1Hex: string
  ): Promise<{ type: number; content: Uint8Array } | null> {
    const compressed = await this.getObject(sha1Hex);
    if (!compressed) return null;

    const wasm = await this.getWasm();
    // Decompress — estimate 4x expansion
    const maxSize = Math.max(compressed.length * 4, 65536);
    const raw = wasm.zlibInflate(compressed, maxSize);

    // Parse header to extract type and content
    const spaceIdx = raw.indexOf(0x20); // space
    const nullIdx = raw.indexOf(0x00); // null
    if (spaceIdx === -1 || nullIdx === -1) return null;

    const typeStr = new TextDecoder().decode(raw.slice(0, spaceIdx));
    const type = nameToType(typeStr);
    const content = raw.slice(nullIdx + 1);

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
