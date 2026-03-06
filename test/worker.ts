// Test worker — git protocol only (no vinext UI)
// Used by vitest-pool-workers to run integration tests.
//
// All git operations route through the RepoStore Durable Object,
// which owns per-repo SQLite (refs, metadata) and coordinates
// atomic ref updates.

import { GitEngine } from "../src/git-engine";
import { handleUploadPack } from "../src/upload-pack";
import { handleReceivePack } from "../src/receive-pack";
import { handleInfoRefs } from "../src/info-refs";
import { RepoStore } from "../src/repo-store";

export { RepoStore };

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

      // Route through RepoStore DO
      const storeId = env.REPO_STORE.idFromName(repoPath);
      const store = env.REPO_STORE.get(storeId);

      if (action === "info/refs" && request.method === "GET") {
        const service = url.searchParams.get("service");
        if (service !== "git-upload-pack" && service !== "git-receive-pack") {
          return new Response("Unsupported service\n", { status: 403 });
        }
        return store.fetch(
          new Request(request.url, {
            method: "GET",
            headers: {
              "x-action": "info-refs",
              "x-repo-path": repoPath,
              "x-service": service,
            },
          })
        );
      }

      if (action === "git-upload-pack" && request.method === "POST") {
        return store.fetch(
          new Request(request.url, {
            method: "POST",
            body: request.body,
            headers: {
              "x-action": "upload-pack",
              "x-repo-path": repoPath,
            },
          })
        );
      }

      if (action === "git-receive-pack" && request.method === "POST") {
        return store.fetch(
          new Request(request.url, {
            method: "POST",
            body: request.body,
            headers: {
              "x-action": "receive-pack",
              "x-repo-path": repoPath,
            },
          })
        );
      }

      if (action === "HEAD" && request.method === "GET") {
        return store.fetch(
          new Request(request.url, {
            method: "GET",
            headers: {
              "x-action": "head",
              "x-repo-path": repoPath,
            },
          })
        );
      }

      return new Response("Not found\n", { status: 404 });
    }

    return new Response("Not found\n", { status: 404 });
  },
};
