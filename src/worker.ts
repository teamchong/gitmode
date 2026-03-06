// gitmode — Git server on Cloudflare Workers
//
// Routes:
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack   → ref advertisement
//   GET  /:owner/:repo.git/info/refs?service=git-receive-pack  → ref advertisement
//   POST /:owner/:repo.git/git-upload-pack                     → clone/fetch
//   POST /:owner/:repo.git/git-receive-pack                    → push
//   GET  /:owner/:repo.git/HEAD                                → default branch
//
// SSH: via TCP socket handler (Cloudflare Workers TCP support)

import { GitEngine } from "./git-engine";
import { handleUploadPack } from "./upload-pack";
import { handleReceivePack } from "./receive-pack";
import { handleInfoRefs } from "./info-refs";
import { RepoLock } from "./repo-lock";

export { RepoLock };

export type { Env } from "./env";

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
    const engine = new GitEngine(env, repoPath);

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
        // Acquire per-repo lock via Durable Object
        const lockId = env.REPO_LOCK.idFromName(repoPath);
        const lock = env.REPO_LOCK.get(lockId);
        return lock.fetch(
          new Request("https://lock/receive-pack", {
            method: "POST",
            body,
            headers: {
              "x-repo-path": repoPath,
            },
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
    } catch (err) {
      console.error(`gitmode error: ${err}`);
      return new Response(`Internal error\n`, { status: 500 });
    }
  },
};
