// RepoStore — Durable Object with SQLite for per-repo state
//
// Each repository gets its own DO instance. The DO's embedded SQLite
// database stores refs (branches, tags, HEAD) and metadata (repo info,
// commit index, permissions). Git objects live in R2.
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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        username TEXT PRIMARY KEY,
        role TEXT NOT NULL
      )
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
        const body = new Uint8Array(await request.arrayBuffer());
        return handleUploadPack(engine, body);
      }

      case "receive-pack": {
        const body = new Uint8Array(await request.arrayBuffer());
        return handleReceivePack(engine, body, this.env, repoPath);
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
        const porcelain = new GitPorcelain(engine);
        const url = new URL(request.url);
        const apiAction = request.headers.get("x-api-action") ?? "";
        try {
          return await handleApiAction(porcelain, engine, apiAction, request, url);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 400 });
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
      porcelain.init(defaultBranch);
      return Response.json({ ok: true });
    }

    // --- files ---
    case "read-file": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const path = url.searchParams.get("path") ?? "";
      const content = await porcelain.catFile(ref, path);
      if (!content) return Response.json({ error: "not found" }, { status: 404 });
      // Return as base64 for binary safety
      const text = new TextDecoder().decode(content);
      return Response.json({ content: text, size: content.length });
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
      const sha = await porcelain.commit({
        ref: body.ref,
        message: body.message,
        author: body.author,
        email: body.email,
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
      const sha = await porcelain.createBranch(body.name, body.startPoint);
      return Response.json({ sha });
    }

    case "delete-branch": {
      const body = await request.json() as { name: string };
      porcelain.deleteBranch(body.name);
      return Response.json({ ok: true });
    }

    case "rename-branch": {
      const body = await request.json() as { oldName: string; newName: string };
      await porcelain.renameBranch(body.oldName, body.newName);
      return Response.json({ ok: true });
    }

    // --- checkout ---
    case "checkout": {
      const body = await request.json() as { branch: string };
      porcelain.checkout(body.branch);
      return Response.json({ ok: true });
    }

    case "detach-head": {
      const body = await request.json() as { sha: string };
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
      const sha = await porcelain.createTag(body.name, body.target);
      return Response.json({ sha });
    }

    case "create-annotated-tag": {
      const body = await request.json() as {
        name: string; target?: string;
        tagger: string; email: string; message: string;
        timestamp?: number;
      };
      const sha = await porcelain.createAnnotatedTag(body);
      return Response.json({ sha });
    }

    case "delete-tag": {
      const body = await request.json() as { name: string };
      porcelain.deleteTag(body.name);
      return Response.json({ ok: true });
    }

    // --- log ---
    case "log": {
      const ref = url.searchParams.get("ref") ?? "HEAD";
      const maxCount = parseInt(url.searchParams.get("max") ?? "50", 10);
      const commits = await porcelain.log(ref, maxCount);
      return Response.json({ commits });
    }

    // --- diff ---
    case "diff": {
      const refA = url.searchParams.get("a") ?? url.searchParams.get("from") ?? "";
      const refB = url.searchParams.get("b") ?? url.searchParams.get("to") ?? undefined;
      const entries = await porcelain.diff(refA, refB);
      return Response.json({ entries });
    }

    // --- merge ---
    case "merge": {
      const body = await request.json() as {
        target: string; source: string;
        author: string; email: string;
        message?: string; timestamp?: number;
      };
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
      const sha = await porcelain.cherryPick({ commit, target, author: body.author, email, timestamp: body.timestamp });
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
      const sha = await porcelain.revert({ commit, target, author: body.author, email, timestamp: body.timestamp });
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
      const maxCount = parseInt(url.searchParams.get("max") ?? "50", 10);
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
      return Response.json({
        type: typeNames[obj.type] ?? "unknown",
        size: obj.content.length,
        content: new TextDecoder().decode(obj.content),
      });
    }

    default:
      return Response.json({ error: `Unknown API action: ${action}` }, { status: 400 });
  }
}
