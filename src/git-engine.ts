// GitEngine — orchestrates R2 (objects), KV (refs), D1 (metadata)
//
// Storage layout:
//   R2 key: "{repo}/objects/{sha1[0:2]}/{sha1[2:]}"  (loose objects)
//   R2 key: "{repo}/packs/{sha1}.pack"                (packfiles)
//   KV key: "{repo}/refs/{refname}"                   (branch/tag → sha1)
//   KV key: "{repo}/HEAD"                             (symbolic ref)
//   D1:     repos, commits, permissions, ssh_keys

import type { Env } from "./env";
import { WasmEngine } from "./wasm-engine";

// Object types matching Zig enum
export const OBJ_BLOB = 1;
export const OBJ_TREE = 2;
export const OBJ_COMMIT = 3;
export const OBJ_TAG = 4;

export class GitEngine {
  private env: Env;
  private repo: string;
  private wasm: WasmEngine | null = null;

  constructor(env: Env, repo: string) {
    this.env = env;
    this.repo = repo;
  }

  private async getWasm(): Promise<WasmEngine> {
    if (!this.wasm) {
      this.wasm = await WasmEngine.create();
    }
    return this.wasm;
  }

  // === Object storage (R2) ===

  private objectKey(sha1Hex: string): string {
    return `${this.repo}/objects/${sha1Hex.slice(0, 2)}/${sha1Hex.slice(2)}`;
  }

  async getObject(sha1Hex: string): Promise<Uint8Array | null> {
    const obj = await this.env.OBJECTS.get(this.objectKey(sha1Hex));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async putObject(sha1Hex: string, data: Uint8Array): Promise<void> {
    await this.env.OBJECTS.put(this.objectKey(sha1Hex), data);
  }

  async hasObject(sha1Hex: string): Promise<boolean> {
    const head = await this.env.OBJECTS.head(this.objectKey(sha1Hex));
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

  // === Refs (KV) ===

  async getRef(refname: string): Promise<string | null> {
    return this.env.REFS.get(`${this.repo}/refs/${refname}`);
  }

  async setRef(refname: string, sha1Hex: string): Promise<void> {
    await this.env.REFS.put(`${this.repo}/refs/${refname}`, sha1Hex);
  }

  async deleteRef(refname: string): Promise<void> {
    await this.env.REFS.delete(`${this.repo}/refs/${refname}`);
  }

  async listRefs(): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    const prefix = `${this.repo}/refs/`;
    let cursor: string | undefined;

    do {
      const list = await this.env.REFS.list({ prefix, cursor });
      for (const key of list.keys) {
        const refname = key.name.slice(prefix.length);
        const value = await this.env.REFS.get(key.name);
        if (value) refs.set(refname, value);
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    return refs;
  }

  async getHead(): Promise<string | null> {
    return this.env.REFS.get(`${this.repo}/HEAD`);
  }

  async setHead(value: string): Promise<void> {
    await this.env.REFS.put(`${this.repo}/HEAD`, value);
  }

  // === Metadata (D1) ===

  async ensureRepo(): Promise<void> {
    const [owner, name] = this.repo.split("/");
    await this.env.META.prepare(
      `INSERT OR IGNORE INTO repos (owner, name, created_at) VALUES (?, ?, ?)`
    )
      .bind(owner, name, new Date().toISOString())
      .run();
  }

  async indexCommit(
    sha1Hex: string,
    author: string,
    message: string,
    timestamp: number
  ): Promise<void> {
    await this.env.META.prepare(
      `INSERT OR IGNORE INTO commits (repo, sha1, author, message, timestamp) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(this.repo, sha1Hex, author, message, timestamp)
      .run();
  }

  // === SSH key management (D1) ===

  async getSSHKeyOwner(fingerprint: string): Promise<string | null> {
    const result = await this.env.META.prepare(
      `SELECT owner FROM ssh_keys WHERE fingerprint = ?`
    )
      .bind(fingerprint)
      .first<{ owner: string }>();
    return result?.owner ?? null;
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
