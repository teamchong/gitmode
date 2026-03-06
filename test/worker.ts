// Test worker — git protocol + REST API (no vinext UI)
// Used by vitest-pool-workers to run integration tests.
//
// All operations route through the RepoStore Durable Object,
// which owns per-repo SQLite (refs, metadata) and coordinates
// atomic ref updates.

import { RepoStore } from "../src/repo-store";
import type { Env } from "../src/env";

export { RepoStore };
export type { Env };

const GIT_ROUTE = /^\/([^/]+)\/([^/]+?)\.git\/(.+)$/;
const API_ROUTE = /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/;
const LIST_REPOS_ROUTE = /^\/api\/repos(?:\/([^/]+))?\/?$/;

function getStore(env: Env, repoPath: string) {
  const id = env.REPO_STORE.idFromName(repoPath);
  return env.REPO_STORE.get(id);
}

type StoreHandle = ReturnType<typeof getStore>;

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
  const prefix = ownerFilter ? `${ownerFilter}/` : "";
  const listed = await env.OBJECTS.list({ prefix, delimiter: "/objects/" });
  const repos: Array<{ owner: string; name: string }> = [];
  const seen = new Set<string>();

  for (const p of listed.delimitedPrefixes) {
    const repoPath = p.replace(/\/objects\/$/, "");
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const [owner, name] = repoPath.split("/");
    if (owner && name) repos.push({ owner, name });
  }

  return Response.json({ repos });
}

function forwardToStore(
  store: StoreHandle,
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
  store: StoreHandle,
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
  store: StoreHandle,
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
  store: StoreHandle,
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
  store: StoreHandle,
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

  if (rest === "init" && method === "POST") {
    return sendApiAction(store, request, repoPath, "init");
  }

  if (rest === "files" && method === "GET") {
    return sendApiAction(store, request, repoPath, url.searchParams.has("path") ? "read-file" : "list-files");
  }

  if (rest === "files/all" && method === "GET") {
    return sendApiAction(store, request, repoPath, "list-all-files");
  }

  if (rest === "commits" && method === "POST") {
    return sendApiAction(store, request, repoPath, "commit");
  }
  const commitMatch = rest.match(/^commits\/([0-9a-f]{40})$/);
  if (commitMatch && method === "GET") {
    const commitUrl = new URL(request.url);
    commitUrl.searchParams.set("sha", commitMatch[1]);
    return sendApiAction(store, new Request(commitUrl, request), repoPath, "get-commit");
  }

  if (rest === "log" && method === "GET") {
    const logUrl = new URL(request.url);
    if (logUrl.searchParams.has("path")) {
      return sendApiAction(store, request, repoPath, "file-log");
    }
    return sendApiAction(store, request, repoPath, "log");
  }

  if (rest === "contributors" && method === "GET") {
    return sendApiAction(store, request, repoPath, "contributors");
  }

  if (rest === "stats" && method === "GET") {
    return sendApiAction(store, request, repoPath, "stats");
  }

  if (rest === "diff" && method === "GET") {
    return sendApiAction(store, request, repoPath, "diff");
  }

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

  if (rest === "checkout" && method === "POST") {
    return sendApiAction(store, request, repoPath, "checkout");
  }

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

  if (rest === "rev-parse" && method === "GET") {
    return sendApiAction(store, request, repoPath, "rev-parse");
  }

  if (rest === "show" && method === "GET") {
    return sendApiAction(store, request, repoPath, "show");
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}
