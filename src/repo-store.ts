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

      default:
        return new Response("Unknown action\n", { status: 400 });
    }
  }
}
