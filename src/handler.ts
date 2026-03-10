// createHandler — reusable fetch handler for gitmode
//
// Extracts git protocol + REST API routing into a factory function
// that can be used from any Cloudflare Worker entry point.
//
// Usage:
//   import { RepoStore, createHandler } from "gitmode";
//   export { RepoStore };
//   export default { fetch: createHandler() };
//
// With custom auth:
//   export default {
//     fetch(req, env) {
//       if (!authorize(req)) return new Response("Unauthorized", { status: 401 });
//       return createHandler()(req, env);
//     }
//   };
//
// With a fallback handler for non-git routes:
//   export default { fetch: createHandler({ fallback: myAppHandler }) };

import type { Env } from "./env";

const VALID_PATH_SEGMENT = /^[a-zA-Z0-9._][a-zA-Z0-9._-]*$/;
const RESERVED_NAMES = /^\.\.?$/;

export interface HandlerOptions {
  /** Handler for requests that don't match git protocol or REST API routes */
  fallback?: (request: Request, env: Env) => Response | Promise<Response>;
  /** Enable CORS headers on REST API responses (default: true) */
  cors?: boolean;
}

interface Fetchable {
  fetch(request: Request): Promise<Response>;
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/;
const API_ROUTE = /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/;
const LIST_REPOS_ROUTE = /^\/api\/repos(?:\/([^/]+))?\/?$/;

function getStore(env: Env, repoPath: string): Fetchable {
  const id = env.REPO_STORE.idFromName(repoPath);
  return env.REPO_STORE.get(id) as unknown as Fetchable;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Creates a fetch handler for gitmode that routes git protocol and REST API requests.
 *
 * Returns a standard Cloudflare Worker fetch handler: `(request, env) => Promise<Response>`
 */
export function createHandler(options: HandlerOptions = {}): (request: Request, env: Env) => Promise<Response> {
  const { fallback, cors = true } = options;
  const wrapResponse = cors ? withCors : (r: Response) => r;

  return async function handleRequest(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors ? corsHeaders() : {} });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- List repos ---
    const listMatch = path.match(LIST_REPOS_ROUTE);
    if (listMatch && request.method === "GET") {
      try {
        return wrapResponse(await listRepos(env, listMatch[1]));
      } catch (err) {
        console.error(`gitmode list-repos error: ${err}`);
        return wrapResponse(Response.json({ error: "Internal error" }, { status: 500 }));
      }
    }

    // --- REST API ---
    const apiMatch = path.match(API_ROUTE);
    if (apiMatch) {
      const [, owner, repo, rest = ""] = apiMatch;
      if (!VALID_PATH_SEGMENT.test(owner) || !VALID_PATH_SEGMENT.test(repo) || RESERVED_NAMES.test(owner) || RESERVED_NAMES.test(repo)) {
        return wrapResponse(Response.json({ error: "Invalid repository path" }, { status: 400 }));
      }
      const repoPath = `${owner}/${repo}`;
      const store = getStore(env, repoPath);

      try {
        return wrapResponse(await routeApi(store, repoPath, rest, request, url));
      } catch (err) {
        console.error(`gitmode api error: ${err}`);
        return wrapResponse(Response.json({ error: "Internal error" }, { status: 500 }));
      }
    }

    // --- Git protocol ---
    const gitMatch = path.match(GIT_ROUTE);
    if (gitMatch) {
      const [, owner, repo, action] = gitMatch;
      if (!VALID_PATH_SEGMENT.test(owner) || !VALID_PATH_SEGMENT.test(repo) || RESERVED_NAMES.test(owner) || RESERVED_NAMES.test(repo)) {
        return new Response("Invalid repository path\n", { status: 400 });
      }
      const repoPath = `${owner}/${repo}`;
      const store = getStore(env, repoPath);

      try {
        return await routeGit(store, repoPath, action, request, url);
      } catch (err) {
        console.error(`gitmode error: ${err}`);
        return new Response("Internal error\n", { status: 500 });
      }
    }

    // --- Fallback ---
    if (fallback) {
      return fallback(request, env);
    }

    return new Response("Not found\n", { status: 404 });
  };
}

async function listRepos(env: Env, ownerFilter?: string): Promise<Response> {
  const prefix = ownerFilter ? `${ownerFilter}/` : "";
  // Discover repos via both legacy loose objects (/objects/) and chunk storage (/chunks/)
  const [byObjects, byChunks] = await Promise.all([
    env.OBJECTS.list({ prefix, delimiter: "/objects/" }),
    env.OBJECTS.list({ prefix, delimiter: "/chunks/" }),
  ]);
  const repos: Array<{ owner: string; name: string }> = [];
  const seen = new Set<string>();

  for (const p of byObjects.delimitedPrefixes) {
    const repoPath = p.replace(/\/objects\/$/, "");
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const [owner, name] = repoPath.split("/");
    if (owner && name) repos.push({ owner, name });
  }
  for (const p of byChunks.delimitedPrefixes) {
    const repoPath = p.replace(/\/chunks\/$/, "");
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const [owner, name] = repoPath.split("/");
    if (owner && name) repos.push({ owner, name });
  }

  return Response.json({ repos });
}

function forwardToStore(
  store: Fetchable,
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  return store.fetch(
    new Request(request.url, {
      method: request.method,
      body: request.body,
      headers,
    })
  );
}

async function routeGit(
  store: Fetchable,
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
    const headers: Record<string, string> = {
      "x-action": "receive-pack",
      "x-repo-path": repoPath,
    };
    const cl = request.headers.get("content-length");
    if (cl) headers["content-length"] = cl;
    return forwardToStore(store, request, headers);
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
  store: Fetchable,
  request: Request,
  repoPath: string,
  apiAction: string,
): Promise<Response> {
  return store.fetch(
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
  store: Fetchable,
  request: Request,
  repoPath: string,
  apiAction: string,
  body: string,
): Promise<Response> {
  return store.fetch(
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
  store: Fetchable,
  repoPath: string,
  rest: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const method = request.method;

  // GET /  (repo metadata)
  if (rest === "" && method === "GET") {
    return sendApiAction(store, request, repoPath, "get-meta");
  }

  // PATCH / (update repo metadata)
  if (rest === "" && method === "PATCH") {
    return sendApiAction(store, request, repoPath, "update-meta");
  }

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
  // GET /commits/:sha
  const commitMatch = rest.match(/^commits\/([0-9a-f]{40})$/);
  if (commitMatch && method === "GET") {
    const commitUrl = new URL(url.href);
    commitUrl.searchParams.set("sha", commitMatch[1]);
    return sendApiAction(store, new Request(commitUrl, request), repoPath, "get-commit");
  }

  // GET /log?ref=...&max=...&path=...
  if (rest === "log" && method === "GET") {
    if (url.searchParams.has("path")) {
      return sendApiAction(store, request, repoPath, "file-log");
    }
    return sendApiAction(store, request, repoPath, "log");
  }

  // GET /contributors
  if (rest === "contributors" && method === "GET") {
    return sendApiAction(store, request, repoPath, "contributors");
  }

  // GET /stats
  if (rest === "stats" && method === "GET") {
    return sendApiAction(store, request, repoPath, "stats");
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

  // Detach HEAD
  if (rest === "detach-head" && method === "POST") {
    return sendApiAction(store, request, repoPath, "detach-head");
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
