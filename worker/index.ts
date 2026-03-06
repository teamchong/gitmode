// gitmode worker entry — handles git protocol AND vinext UI
//
// Routes:
//   *.git/*  → git protocol handlers (info-refs, upload-pack, receive-pack)
//   /*       → vinext RSC UI

import handler from "vinext/server/app-router-entry";
import { GitEngine } from "../src/git-engine";
import { handleUploadPack } from "../src/upload-pack";
import { handleReceivePack } from "../src/receive-pack";
import { handleInfoRefs } from "../src/info-refs";
import { RepoLock } from "../src/repo-lock";

export { RepoLock };

import type { Env } from "../src/env";
export type { Env };

// Match git protocol routes: /:owner/:repo.git/...
const GIT_ROUTE_RE = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Expose env to RSC components via globalThis
    (globalThis as any).__gitmode_env__ = env;

    const url = new URL(request.url);
    const match = url.pathname.match(GIT_ROUTE_RE);

    if (match) {
      return handleGitRequest(request, env, url, match);
    }

    // Everything else goes to vinext UI
    return handler.fetch(request);
  },
};

async function handleGitRequest(
  request: Request,
  env: Env,
  url: URL,
  match: RegExpMatchArray
): Promise<Response> {
  const [, owner, repo, action] = match;
  const repoPath = `${owner}/${repo}`;
  const engine = new GitEngine(env, repoPath);

  // GET /info/refs?service=...
  if (action === "info/refs" && request.method === "GET") {
    const service = url.searchParams.get("service");
    if (
      service !== "git-upload-pack" &&
      service !== "git-receive-pack"
    ) {
      return new Response("Unsupported service\n", { status: 403 });
    }
    return handleInfoRefs(engine, service);
  }

  // POST /git-upload-pack (clone/fetch)
  if (action === "git-upload-pack" && request.method === "POST") {
    const body = new Uint8Array(await request.arrayBuffer());
    return handleUploadPack(engine, body);
  }

  // POST /git-receive-pack (push)
  if (action === "git-receive-pack" && request.method === "POST") {
    const body = new Uint8Array(await request.arrayBuffer());
    const lockId = env.REPO_LOCK.idFromName(repoPath);
    const lock = env.REPO_LOCK.get(lockId);
    return lock.fetch(
      new Request("https://lock/receive-pack", {
        method: "POST",
        body,
        headers: { "x-repo-path": repoPath },
      })
    );
  }

  // GET /HEAD
  if (action === "HEAD" && request.method === "GET") {
    const head = await engine.getHead();
    if (!head) return new Response("ref: refs/heads/main\n");
    return new Response(head + "\n");
  }

  return new Response("Not found\n", { status: 404 });
}
