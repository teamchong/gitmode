// gitmode — Git server + REST API on Cloudflare Workers
//
// Git protocol routes:
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack   → ref advertisement
//   GET  /:owner/:repo.git/info/refs?service=git-receive-pack  → ref advertisement
//   POST /:owner/:repo.git/git-upload-pack                     → clone/fetch
//   POST /:owner/:repo.git/git-receive-pack                    → push
//   GET  /:owner/:repo.git/HEAD                                → default branch
//
// REST API routes (for agents/programmatic use):
//   POST /api/repos/:owner/:repo/init
//   GET  /api/repos/:owner/:repo/files?ref=...&path=...
//   GET  /api/repos/:owner/:repo/files/all?ref=...
//   POST /api/repos/:owner/:repo/commits
//   GET  /api/repos/:owner/:repo/log?ref=...&max=...
//   GET  /api/repos/:owner/:repo/diff?a=...&b=...
//   GET  /api/repos/:owner/:repo/branches
//   POST /api/repos/:owner/:repo/branches
//   DELETE /api/repos/:owner/:repo/branches/:name
//   PATCH  /api/repos/:owner/:repo/branches/:name
//   POST /api/repos/:owner/:repo/checkout
//   GET  /api/repos/:owner/:repo/tags
//   POST /api/repos/:owner/:repo/tags
//   DELETE /api/repos/:owner/:repo/tags/:name
//   POST /api/repos/:owner/:repo/merge
//   POST /api/repos/:owner/:repo/cherry-pick
//   POST /api/repos/:owner/:repo/revert
//   POST /api/repos/:owner/:repo/reset
//   GET  /api/repos/:owner/:repo/rev-parse?ref=...
//   GET  /api/repos/:owner/:repo/show?sha=...
//
// All operations route through a per-repo RepoStore Durable Object.

import type { Env } from "./env";
import { RepoStore } from "./repo-store";

export { RepoStore };
export type { Env };

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/;
const API_ROUTE = /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/;
const LIST_REPOS_ROUTE = /^\/api\/repos(?:\/([^/]+))?\/?$/;

function getStore(env: Env, repoPath: string) {
  const id = env.REPO_STORE.idFromName(repoPath);
  return env.REPO_STORE.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- List repos ---
    const listMatch = path.match(LIST_REPOS_ROUTE);
    if (listMatch && request.method === "GET") {
      const ownerFilter = listMatch[1];
      try {
        return await listRepos(env, ownerFilter);
      } catch (err) {
        console.error(`gitmode list-repos error: ${err}`);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    // --- REST API ---
    const apiMatch = path.match(API_ROUTE);
    if (apiMatch) {
      const [, owner, repo, rest = ""] = apiMatch;
      const repoPath = `${owner}/${repo}`;
      const store = getStore(env, repoPath);

      try {
        return await routeApi(store, repoPath, rest, request, url);
      } catch (err) {
        console.error(`gitmode api error: ${err}`);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    }

    // --- Git protocol ---
    const gitMatch = path.match(GIT_ROUTE);
    if (gitMatch) {
      const [, owner, repo, action] = gitMatch;
      const repoPath = `${owner}/${repo}`;
      const store = getStore(env, repoPath);

      try {
        return await routeGit(store, repoPath, action, request, url);
      } catch (err) {
        console.error(`gitmode error: ${err}`);
        return new Response("Internal error\n", { status: 500 });
      }
    }

    return new Response("gitmode\n", { status: 200 });
  },
};

async function listRepos(env: Env, ownerFilter?: string): Promise<Response> {
  // Discover repos by listing R2 prefixes: {owner}/{repo}/objects/
  const prefix = ownerFilter ? `${ownerFilter}/` : "";
  const listed = await env.OBJECTS.list({ prefix, delimiter: "/objects/" });
  const repos: Array<{ owner: string; name: string }> = [];
  const seen = new Set<string>();

  for (const prefix of listed.delimitedPrefixes) {
    // prefix looks like "owner/repo/objects/"
    const repoPath = prefix.replace(/\/objects\/$/, "");
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const [owner, name] = repoPath.split("/");
    if (owner && name) repos.push({ owner, name });
  }

  return Response.json({ repos });
}

function forwardToStore(
  store: Rpc.DurableObjectBranded,
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  return (store as any).fetch(
    new Request(request.url, {
      method: request.method,
      body: request.body,
      headers,
    })
  );
}

async function routeGit(
  store: Rpc.DurableObjectBranded,
  repoPath: string,
  action: string,
  request: Request,
  url: URL,
): Promise<Response> {
  if (action === "info/refs" && request.method === "GET") {
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return new Response("Unsupported service\n", { status: 403 });
    }
    return forwardToStore(store, request, {
      "x-action": "info-refs",
      "x-repo-path": repoPath,
      "x-service": service,
    });
  }

  if (action === "git-upload-pack" && request.method === "POST") {
    return forwardToStore(store, request, {
      "x-action": "upload-pack",
      "x-repo-path": repoPath,
    });
  }

  if (action === "git-receive-pack" && request.method === "POST") {
    return forwardToStore(store, request, {
      "x-action": "receive-pack",
      "x-repo-path": repoPath,
    });
  }

  if (action === "HEAD" && request.method === "GET") {
    return forwardToStore(store, request, {
      "x-action": "head",
      "x-repo-path": repoPath,
    });
  }

  return new Response("Not found\n", { status: 404 });
}

function sendApiAction(
  store: Rpc.DurableObjectBranded,
  request: Request,
  repoPath: string,
  apiAction: string,
): Promise<Response> {
  return (store as any).fetch(
    new Request(request.url, {
      method: request.method,
      body: request.method !== "GET" ? request.body : undefined,
      headers: {
        "x-action": "api",
        "x-repo-path": repoPath,
        "x-api-action": apiAction,
        "content-type": "application/json",
      },
    })
  );
}

function sendApiBody(
  store: Rpc.DurableObjectBranded,
  request: Request,
  repoPath: string,
  apiAction: string,
  body: string,
): Promise<Response> {
  return (store as any).fetch(
    new Request(request.url, {
      method: "POST",
      body,
      headers: {
        "x-action": "api",
        "x-repo-path": repoPath,
        "x-api-action": apiAction,
        "content-type": "application/json",
      },
    })
  );
}

async function routeApi(
  store: Rpc.DurableObjectBranded,
  repoPath: string,
  rest: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const method = request.method;

  // POST /init
  if (rest === "init" && method === "POST") {
    return sendApiAction(store, request, repoPath, "init");
  }

  // GET /files?ref=...&path=...
  if (rest === "files" && method === "GET") {
    return sendApiAction(store, request, repoPath, url.searchParams.has("path") ? "read-file" : "list-files");
  }

  // GET /files/all?ref=...
  if (rest === "files/all" && method === "GET") {
    return sendApiAction(store, request, repoPath, "list-all-files");
  }

  // POST /commits
  if (rest === "commits" && method === "POST") {
    return sendApiAction(store, request, repoPath, "commit");
  }

  // GET /log?ref=...&max=...
  if (rest === "log" && method === "GET") {
    return sendApiAction(store, request, repoPath, "log");
  }

  // GET /diff?a=...&b=... (or ?from=...&to=...)
  if (rest === "diff" && method === "GET") {
    return sendApiAction(store, request, repoPath, "diff");
  }

  // Branches
  if (rest === "branches" && method === "GET") {
    return sendApiAction(store, request, repoPath, "list-branches");
  }
  if (rest === "branches" && method === "POST") {
    return sendApiAction(store, request, repoPath, "create-branch");
  }
  const branchMatch = rest.match(/^branches\/(.+)$/);
  if (branchMatch && method === "DELETE") {
    return sendApiBody(store, request, repoPath, "delete-branch",
      JSON.stringify({ name: decodeURIComponent(branchMatch[1]) }));
  }
  if (branchMatch && method === "PATCH") {
    const reqBody = await request.json() as { newName: string };
    return sendApiBody(store, request, repoPath, "rename-branch",
      JSON.stringify({ oldName: decodeURIComponent(branchMatch[1]), newName: reqBody.newName }));
  }

  // Checkout
  if (rest === "checkout" && method === "POST") {
    return sendApiAction(store, request, repoPath, "checkout");
  }

  // Tags
  if (rest === "tags" && method === "GET") {
    return sendApiAction(store, request, repoPath, "list-tags");
  }
  if (rest === "tags" && method === "POST") {
    const body = await request.json() as Record<string, unknown>;
    const action = body.message ? "create-annotated-tag" : "create-tag";
    return sendApiBody(store, request, repoPath, action, JSON.stringify(body));
  }
  const tagMatch = rest.match(/^tags\/(.+)$/);
  if (tagMatch && method === "DELETE") {
    return sendApiBody(store, request, repoPath, "delete-tag",
      JSON.stringify({ name: decodeURIComponent(tagMatch[1]) }));
  }

  // Merge, cherry-pick, revert, reset
  if (rest === "merge" && method === "POST") {
    return sendApiAction(store, request, repoPath, "merge");
  }
  if (rest === "cherry-pick" && method === "POST") {
    return sendApiAction(store, request, repoPath, "cherry-pick");
  }
  if (rest === "revert" && method === "POST") {
    return sendApiAction(store, request, repoPath, "revert");
  }
  if (rest === "reset" && method === "POST") {
    return sendApiAction(store, request, repoPath, "reset");
  }

  // Rev-parse
  if (rest === "rev-parse" && method === "GET") {
    return sendApiAction(store, request, repoPath, "rev-parse");
  }

  // Show object
  if (rest === "show" && method === "GET") {
    return sendApiAction(store, request, repoPath, "show");
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
