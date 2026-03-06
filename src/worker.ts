// gitmode — Git server on Cloudflare Workers
//
// Routes:
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack   → ref advertisement
//   GET  /:owner/:repo.git/info/refs?service=git-receive-pack  → ref advertisement
//   POST /:owner/:repo.git/git-upload-pack                     → clone/fetch
//   POST /:owner/:repo.git/git-receive-pack                    → push
//   GET  /:owner/:repo.git/HEAD                                → default branch
//
// All git operations are routed through a per-repo RepoStore Durable Object
// which owns the repo's SQLite database (refs, metadata) and coordinates
// atomic ref updates.

import type { Env } from "./env";
import { RepoStore } from "./repo-store";

export { RepoStore };
export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Parse /:owner/:repo.git/...
    const match = path.match(
      /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(.+)$/
    );
    if (!match) {
      return new Response("gitmode\n", { status: 200 });
    }

    const [, owner, repo, action] = match;
    const repoPath = `${owner}/${repo}`;

    // Get per-repo Durable Object
    const storeId = env.REPO_STORE.idFromName(repoPath);
    const store = env.REPO_STORE.get(storeId);

    try {
      // GET /info/refs?service=...
      if (action === "info/refs" && request.method === "GET") {
        const service = url.searchParams.get("service");
        if (
          service !== "git-upload-pack" &&
          service !== "git-receive-pack"
        ) {
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

      // POST /git-upload-pack (clone/fetch)
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

      // POST /git-receive-pack (push)
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

      // GET /HEAD
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
    } catch (err) {
      console.error(`gitmode error: ${err}`);
      return new Response(`Internal error\n`, { status: 500 });
    }
  },
};
