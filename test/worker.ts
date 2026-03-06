// Test worker — git protocol only (no vinext UI)
// Used by vitest-pool-workers to run integration tests

import { GitEngine } from "../src/git-engine";
import { handleUploadPack } from "../src/upload-pack";
import { handleReceivePack } from "../src/receive-pack";
import { handleInfoRefs } from "../src/info-refs";
import { RepoLock } from "../src/repo-lock";

export { RepoLock };

import type { Env } from "../src/env";
export type { Env };

const GIT_ROUTE_RE = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(GIT_ROUTE_RE);

    if (match) {
      const [, owner, repo, action] = match;
      const repoPath = `${owner}/${repo}`;
      const engine = new GitEngine(env, repoPath);

      if (action === "info/refs" && request.method === "GET") {
        const service = url.searchParams.get("service");
        if (service !== "git-upload-pack" && service !== "git-receive-pack") {
          return new Response("Unsupported service\n", { status: 403 });
        }
        return handleInfoRefs(engine, service);
      }

      if (action === "git-upload-pack" && request.method === "POST") {
        const body = new Uint8Array(await request.arrayBuffer());
        return handleUploadPack(engine, body);
      }

      if (action === "git-receive-pack" && request.method === "POST") {
        const body = new Uint8Array(await request.arrayBuffer());
        return handleReceivePack(engine, body, env, repoPath);
      }

      if (action === "HEAD" && request.method === "GET") {
        const head = await engine.getHead();
        if (!head) return new Response("ref: refs/heads/main\n");
        return new Response(head + "\n");
      }

      return new Response("Not found\n", { status: 404 });
    }

    return new Response("Not found\n", { status: 404 });
  },
};
