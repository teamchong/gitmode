// RepoStore — Durable Object with SQLite for per-repo state
//
// Each repository gets its own DO instance. The DO's embedded SQLite
// database stores refs (branches, tags, HEAD) and metadata (repo info,
// commit index). Git objects live in R2.
//
// This replaces the previous KV (refs) + D1 (metadata) + RepoLock (mutex)
// architecture with a single strongly-consistent DO per repo.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { GitEngine } from "./git-engine";
import { handleUploadPack } from "./upload-pack";
import { handleReceivePack } from "./receive-pack";
import { handleInfoRefs } from "./info-refs";
import { GitPorcelain } from "./git-porcelain";

const decoder = new TextDecoder();

const MAX_REF_NAME_LEN = 256;
const MAX_MESSAGE_LEN = 1024 * 1024; // 1MB
const MAX_DESCRIPTION_LEN = 10 * 1024; // 10KB
const MAX_SHORT_FIELD_LEN = 1024; // 1KB (author, email, tagger)
const MAX_FILES_PER_COMMIT = 10_000;
const MAX_API_BODY = 10 * 1024 * 1024; // 10MB
const INVALID_REF_CHARS = /[\x00-\x1f\x7f ~^:?*\[\\]/;

function bufferToBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

export function validateRefName(name: string): void {
  if (!name || typeof name !== "string") throw new Error("Ref name is required");
  if (name.length > MAX_REF_NAME_LEN) throw new Error("Ref name too long");
  if (INVALID_REF_CHARS.test(name)) throw new Error("Ref name contains invalid characters");
  if (name.includes("..")) throw new Error("Ref name cannot contain '..'");
  if (name.includes("@{")) throw new Error("Ref name cannot contain '@{'");
  if (name.startsWith(".") || name.endsWith(".")) throw new Error("Ref name cannot start or end with '.'");
  if (name.endsWith(".lock")) throw new Error("Ref name cannot end with '.lock'");
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) throw new Error("Invalid ref name");
}

function requireString(value: unknown, field: string): string {
  if (!value || typeof value !== "string") throw new Error(`Missing required field: ${field}`);
  return value;
}

const MAX_FILE_PATH_LEN = 4096;
const INVALID_PATH_SEGMENT = /[\x00-\x1f\x7f]/;

function limitString(value: string | undefined, maxLen: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  if (value.length <= maxLen) return value;
  // Avoid splitting a UTF-16 surrogate pair
  let end = maxLen;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end--;
  return value.slice(0, end);
}

function validateFilePath(path: string): void {
  if (!path || typeof path !== "string") throw new Error("File path is required");
  if (path.length > MAX_FILE_PATH_LEN) throw new Error("File path too long");
  if (INVALID_PATH_SEGMENT.test(path)) throw new Error("File path contains invalid characters");
  if (path.startsWith("/") || path.endsWith("/")) throw new Error("File path cannot start or end with '/'");
  if (path.includes("//")) throw new Error("File path contains empty segments");
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") throw new Error("File path cannot contain '.' or '..' segments");
  }
}

export class RepoStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY,
        sha TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS head (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS repo_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        visibility TEXT DEFAULT 'public',
        default_branch TEXT DEFAULT 'main',
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS commits (
        sha TEXT PRIMARY KEY,
        author TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    // Note: authentication/authorization is the caller's responsibility.
    // Use createHandler() with a custom auth wrapper — see docs.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS file_sizes (
        sha TEXT PRIMARY KEY,
        size INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS object_chunks (
        sha TEXT PRIMARY KEY,
        chunk_key TEXT NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_length INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_object_chunks_key ON object_chunks (chunk_key)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const action = request.headers.get("x-action");
    const repoPath = request.headers.get("x-repo-path") ?? "";

    const engine = new GitEngine(this.env.OBJECTS, repoPath, this.sql);

    switch (action) {
      case "info-refs": {
        const service = request.headers.get("x-service") ?? "";
        return handleInfoRefs(engine, service);
      }

      case "upload-pack": {
        // Upload-pack request body is want/have lines — typically small
        const uploadLen = parseInt(request.headers.get("content-length") ?? "0", 10);
        if (uploadLen > 1024 * 1024) { // 1MB — generous for want/have lines
          return new Response("Request too large\n", { status: 413 });
        }
        const body = new Uint8Array(await request.arrayBuffer());
        return handleUploadPack(engine, body, this.env.PACK_WORKER);
      }

      case "receive-pack": {
        const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
        if (contentLength > 100 * 1024 * 1024) {
          return new Response("Packfile too large (max 100MB)\n", { status: 413 });
        }
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.length > 100 * 1024 * 1024) {
          return new Response("Packfile too large (max 100MB)\n", { status: 413 });
        }
        const { response, backgroundWork } = await handleReceivePack(engine, body, this.env, repoPath);
        if (backgroundWork) {
          this.ctx.waitUntil(backgroundWork);
        }
        return response;
      }

      case "head": {
        const head = engine.getHead();
        if (!head) return new Response("ref: refs/heads/main\n");
        return new Response(head + "\n");
      }

      case "set-head": {
        const { value } = await request.json() as { value: string };
        engine.setHead(value);
        return new Response("ok");
      }

      case "ensure-repo": {
        engine.ensureRepo();
        return new Response("ok");
      }

      case "index-commit": {
        const { sha, author, message, timestamp } = await request.json() as {
          sha: string; author: string; message: string; timestamp: number;
        };
        engine.indexCommit(sha, author, message, timestamp);
        return new Response("ok");
      }

      case "set-ref": {
        const { name, sha } = await request.json() as { name: string; sha: string };
        engine.setRef(name, sha);
        return new Response("ok");
      }

      case "get-ref": {
        const name = new URL(request.url).searchParams.get("name") ?? "";
        const sha = engine.getRef(name);
        return Response.json({ sha });
      }

      case "delete-ref": {
        const { name } = await request.json() as { name: string };
        engine.deleteRef(name);
        return new Response("ok");
      }

      case "list-refs": {
        const refs = engine.listRefs();
        return Response.json(Object.fromEntries(refs));
      }

      case "store-object": {
        const body = new Uint8Array(await request.arrayBuffer());
        const type = parseInt(request.headers.get("x-object-type") ?? "1", 10);
        const sha = await engine.storeObject(type, body);
        return Response.json({ sha });
      }

      case "read-object": {
        const sha = new URL(request.url).searchParams.get("sha") ?? "";
        const obj = await engine.readObject(sha);
        if (!obj) return new Response(null, { status: 404 });
        return new Response(obj.content, {
          headers: { "x-object-type": String(obj.type) },
        });
      }

      // === Porcelain API ===

      case "api": {
        // Guard against oversized JSON bodies
        const apiContentLen = parseInt(request.headers.get("content-length") ?? "0", 10);
        if (apiContentLen > MAX_API_BODY) {
          return Response.json({ error: "Request body too large" }, { status: 413 });
        }
        const porcelain = new GitPorcelain(engine);
        const url = new URL(request.url);
        const apiAction = request.headers.get("x-api-action") ?? "";
        try {
          return await handleApiAction(porcelain, engine, apiAction, request, url, this.env);
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          // Only return known user-facing errors; hide internal details
          const safe = /^(Missing|Invalid|Ref|Branch|Tag|Merge|No |Not |Cannot )/.test(raw) ? raw : "Operation failed";
          return Response.json({ error: safe }, { status: 400 });
        }
      }

      default:
        return new Response("Unknown action\n", { status: 400 });
    }
  }
}

async function handleApiAction(
  porcelain: GitPorcelain,
  engine: GitEngine,
  action: string,
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  switch (action) {
    // --- init ---
    case "init": {
      let defaultBranch: string | undefined;
      try {
        const body = await request.json() as { defaultBranch?: string };
        defaultBranch = body.defaultBranch;
      } catch {
        // Empty body is fine — use defaults
      }
      if (defaultBranch) validateRefName(defaultBranch);
      porcelain.init(defaultBranch);
      return Response.json({ ok: true });
    }

    // --- files ---
    case "read-file": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const path = url.searchParams.get("path") ?? "";
      const content = await porcelain.catFile(ref, path);
      if (!content) return Response.json({ error: "not found" }, { status: 404 });
      const isBinary = content.subarray(0, 8192).includes(0x00);
      if (isBinary) {
        return Response.json({ content: bufferToBase64(content), size: content.length, encoding: "base64" });
      }
      return Response.json({ content: decoder.decode(content), size: content.length });
    }

    case "list-files": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const path = url.searchParams.get("path") ?? "";
      const files = await porcelain.listFiles(ref, path);
      return Response.json({ files });
    }

    case "list-all-files": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const files = await porcelain.listAllFiles(ref);
      return Response.json({ files });
    }

    // --- commit ---
    case "commit": {
      const body = await request.json() as {
        ref: string;
        message: string;
        author?: string;
        email?: string;
        files: Array<{ path: string; content: string | null }>;
        timestamp?: number;
      };
      if (!body.ref) throw new Error("Missing required field: ref");
      if (!body.message) throw new Error("Missing required field: message");
      if (!body.files || !Array.isArray(body.files)) throw new Error("Missing required field: files");
      if (body.files.length > MAX_FILES_PER_COMMIT) throw new Error("Too many files (max 10000)");
      if (body.message.length > MAX_MESSAGE_LEN) throw new Error("Commit message too long (max 1MB)");
      for (const file of body.files) {
        validateFilePath(file.path);
      }
      const sha = await porcelain.commit({
        ref: body.ref,
        message: body.message,
        author: limitString(body.author, MAX_SHORT_FIELD_LEN),
        email: limitString(body.email, MAX_SHORT_FIELD_LEN),
        files: body.files,
        timestamp: body.timestamp,
      });
      return Response.json({ sha });
    }

    // --- branches ---
    case "list-branches": {
      const branches = porcelain.listBranches();
      return Response.json({ branches });
    }

    case "create-branch": {
      const body = await request.json() as { name: string; startPoint?: string };
      validateRefName(requireString(body.name, "name"));
      const sha = await porcelain.createBranch(body.name, body.startPoint);
      return Response.json({ sha });
    }

    case "delete-branch": {
      const body = await request.json() as { name: string };
      validateRefName(requireString(body.name, "name"));
      porcelain.deleteBranch(body.name);
      return Response.json({ ok: true });
    }

    case "rename-branch": {
      const body = await request.json() as { oldName: string; newName: string };
      requireString(body.oldName, "oldName");
      validateRefName(requireString(body.newName, "newName"));
      await porcelain.renameBranch(body.oldName, body.newName);
      return Response.json({ ok: true });
    }

    // --- checkout ---
    case "checkout": {
      const body = await request.json() as { branch: string };
      requireString(body.branch, "branch");
      porcelain.checkout(body.branch);
      return Response.json({ ok: true });
    }

    case "detach-head": {
      const body = await request.json() as { sha: string };
      requireString(body.sha, "sha");
      porcelain.detachHead(body.sha);
      return Response.json({ ok: true });
    }

    // --- tags ---
    case "list-tags": {
      const tags = await porcelain.listTags();
      return Response.json({ tags });
    }

    case "create-tag": {
      const body = await request.json() as { name: string; target?: string };
      validateRefName(requireString(body.name, "name"));
      const sha = await porcelain.createTag(body.name, body.target);
      return Response.json({ sha });
    }

    case "create-annotated-tag": {
      const body = await request.json() as {
        name: string; target?: string;
        tagger: string; email: string; message: string;
        timestamp?: number;
      };
      validateRefName(requireString(body.name, "name"));
      requireString(body.tagger, "tagger");
      requireString(body.email, "email");
      requireString(body.message, "message");
      body.tagger = limitString(body.tagger, MAX_SHORT_FIELD_LEN)!;
      body.email = limitString(body.email, MAX_SHORT_FIELD_LEN)!;
      body.message = limitString(body.message, MAX_MESSAGE_LEN)!;
      const sha = await porcelain.createAnnotatedTag(body);
      return Response.json({ sha });
    }

    case "delete-tag": {
      const body = await request.json() as { name: string };
      validateRefName(requireString(body.name, "name"));
      porcelain.deleteTag(body.name);
      return Response.json({ ok: true });
    }

    // --- log ---
    case "log": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const maxCount = Math.min(parseInt(url.searchParams.get("max") ?? "50", 10) || 50, 10000);
      const commits = await porcelain.log(ref, maxCount);
      return Response.json({ commits });
    }

    // --- diff ---
    case "diff": {
      const refA = url.searchParams.get("a") ?? url.searchParams.get("from") ?? "";
      const refB = url.searchParams.get("b") ?? url.searchParams.get("to") ?? undefined;
      const withContent = url.searchParams.get("content") === "true";
      const entries = withContent
        ? await porcelain.diffWithContent(refA, refB, env.PACK_WORKER)
        : await porcelain.diff(refA, refB);
      return Response.json({ entries });
    }

    // --- grep ---
    case "grep": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const pattern = url.searchParams.get("pattern") ?? url.searchParams.get("q") ?? "";
      if (!pattern) return Response.json({ error: "Missing pattern" }, { status: 400 });
      const contextLines = Math.min(parseInt(url.searchParams.get("context") ?? "2", 10) || 2, 10);
      const matches = await porcelain.grep(ref, pattern, env.PACK_WORKER, contextLines);
      return Response.json({ matches });
    }

    // --- merge ---
    case "merge": {
      const body = await request.json() as {
        target: string; source: string;
        author: string; email: string;
        message?: string; timestamp?: number;
      };
      requireString(body.target, "target");
      requireString(body.source, "source");
      requireString(body.author, "author");
      requireString(body.email, "email");
      body.author = limitString(body.author, MAX_SHORT_FIELD_LEN)!;
      body.email = limitString(body.email, MAX_SHORT_FIELD_LEN)!;
      body.message = limitString(body.message, MAX_MESSAGE_LEN);
      const result = await porcelain.merge(body);
      return Response.json(result);
    }

    // --- cherry-pick ---
    case "cherry-pick": {
      const body = await request.json() as {
        commit?: string; sha?: string;
        target?: string; branch?: string;
        author?: string; authorEmail?: string; email?: string;
        timestamp?: number;
      };
      const commit = body.commit ?? body.sha;
      const target = body.target ?? body.branch;
      const email = body.email ?? body.authorEmail ?? "";
      if (!commit) throw new Error("Missing required field: commit (or sha)");
      if (!target) throw new Error("Missing required field: target (or branch)");
      if (!body.author) throw new Error("Missing required field: author");
      const author = limitString(body.author, MAX_SHORT_FIELD_LEN)!;
      const limitedEmail = limitString(email, MAX_SHORT_FIELD_LEN) ?? "";
      const sha = await porcelain.cherryPick({ commit, target, author, email: limitedEmail, timestamp: body.timestamp });
      return Response.json({ sha });
    }

    // --- revert ---
    case "revert": {
      const body = await request.json() as {
        commit?: string; sha?: string;
        target?: string; branch?: string;
        author?: string; authorEmail?: string; email?: string;
        timestamp?: number;
      };
      const commit = body.commit ?? body.sha;
      const target = body.target ?? body.branch;
      const email = body.email ?? body.authorEmail ?? "";
      if (!commit) throw new Error("Missing required field: commit (or sha)");
      if (!target) throw new Error("Missing required field: target (or branch)");
      if (!body.author) throw new Error("Missing required field: author");
      const author = limitString(body.author, MAX_SHORT_FIELD_LEN)!;
      const limitedEmail = limitString(email, MAX_SHORT_FIELD_LEN) ?? "";
      const sha = await porcelain.revert({ commit, target, author, email: limitedEmail, timestamp: body.timestamp });
      return Response.json({ sha });
    }

    // --- reset ---
    case "reset": {
      const body = await request.json() as {
        ref?: string; branch?: string;
        target?: string; sha?: string;
      };
      const ref = body.ref ?? body.branch;
      const target = body.target ?? body.sha;
      if (!ref) throw new Error("Missing required field: ref (or branch)");
      if (!target) throw new Error("Missing required field: target (or sha)");
      validateRefName(ref);
      await porcelain.reset(ref, target);
      return Response.json({ ok: true });
    }

    // --- rev-parse ---
    case "rev-parse": {
      const ref = url.searchParams.get("ref") ?? "";
      const sha = await porcelain.resolveRef(ref);
      return Response.json({ sha });
    }

    // --- commit detail ---
    case "get-commit": {
      const sha = url.searchParams.get("sha") ?? "";
      const commit = await porcelain.getCommit(sha);
      if (!commit) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(commit);
    }

    // --- file history ---
    case "file-log": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const path = url.searchParams.get("path") ?? "";
      const maxCount = Math.min(parseInt(url.searchParams.get("max") ?? "50", 10) || 50, 10000);
      if (!path) return Response.json({ error: "path is required" }, { status: 400 });
      const commits = await porcelain.fileLog(ref, path, maxCount);
      return Response.json({ commits });
    }

    // --- contributors ---
    case "contributors": {
      const contributors = porcelain.contributors();
      return Response.json({ contributors });
    }

    // --- repo stats ---
    case "stats": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const stats = await porcelain.stats(ref);
      return Response.json(stats);
    }

    // --- repo metadata ---
    case "get-meta": {
      const meta = engine.getRepoMeta();
      if (!meta) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(meta);
    }

    case "update-meta": {
      const body = await request.json() as Record<string, string>;
      if (body.description && body.description.length > MAX_DESCRIPTION_LEN) {
        throw new Error("Description too long (max 10KB)");
      }
      if (body.default_branch) validateRefName(body.default_branch);
      engine.updateRepoMeta(body);
      return Response.json({ ok: true });
    }

    // --- show object ---
    case "show": {
      const ref = url.searchParams.get("sha") ?? url.searchParams.get("ref") ?? "";
      if (!ref) return Response.json({ error: "ref or sha is required" }, { status: 400 });
      // Resolve ref to SHA if needed
      const resolved = await porcelain.resolveRef(ref);
      if (!resolved) return Response.json({ error: "not found" }, { status: 404 });
      const obj = await engine.readObject(resolved);
      if (!obj) return Response.json({ error: "not found" }, { status: 404 });
      const typeNames = ["", "blob", "tree", "commit", "tag"];
      const typeName = typeNames[obj.type] ?? "unknown";
      // Blobs may be binary — detect via null bytes in first 8KB
      const isBinary = typeName === "blob" && obj.content.subarray(0, 8192).includes(0x00);
      const result: Record<string, unknown> = {
        type: typeName,
        size: obj.content.length,
      };
      if (isBinary) {
        result.encoding = "base64";
        result.content = bufferToBase64(obj.content);
      } else {
        result.content = decoder.decode(obj.content);
      }
      return Response.json(result);
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
