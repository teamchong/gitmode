// Internal API helpers for vinext RSC pages
//
// Pages call these functions to get data from the RepoStore DO.
// Runs inside the same worker — no external HTTP calls needed.

import { getEnv } from "./env";

function getStore(owner: string, repo: string) {
  const env = getEnv();
  const repoPath = `${owner}/${repo}`;
  const id = env.REPO_STORE.idFromName(repoPath);
  return { store: env.REPO_STORE.get(id), repoPath };
}

async function doFetch(
  owner: string,
  repo: string,
  apiAction: string,
  params?: Record<string, string>,
): Promise<Response> {
  const { store, repoPath } = getStore(owner, repo);
  const url = new URL("https://internal/api");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return store.fetch(
    new Request(url.toString(), {
      headers: {
        "x-action": "api",
        "x-repo-path": repoPath,
        "x-api-action": apiAction,
        "content-type": "application/json",
      },
    }),
  );
}

export async function listRepos(ownerFilter?: string) {
  const env = getEnv();
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
  return repos;
}

export async function listBranches(owner: string, repo: string) {
  const resp = await doFetch(owner, repo, "list-branches");
  const data = (await resp.json()) as {
    branches: Array<{ name: string; sha: string; isHead: boolean }>;
  };
  return data.branches;
}

export async function listTags(owner: string, repo: string) {
  const resp = await doFetch(owner, repo, "list-tags");
  const data = (await resp.json()) as {
    tags: Array<{
      name: string;
      sha: string;
      type: string;
      target?: string;
      tagger?: string;
      message?: string;
    }>;
  };
  return data.tags;
}

export async function getLog(
  owner: string,
  repo: string,
  ref: string,
  max = 50,
) {
  const resp = await doFetch(owner, repo, "log", {
    ref,
    max: String(max),
  });
  const data = (await resp.json()) as {
    commits: Array<{
      sha: string;
      tree: string;
      parents: string[];
      author: string;
      authorEmail: string;
      authorTimestamp: number;
      message: string;
    }>;
  };
  return data.commits;
}

export async function getCommit(owner: string, repo: string, sha: string) {
  const resp = await doFetch(owner, repo, "get-commit", { sha });
  if (!resp.ok) return null;
  return (await resp.json()) as {
    sha: string;
    tree: string;
    parents: string[];
    author: string;
    authorEmail: string;
    authorTimestamp: number;
    committer: string;
    committerEmail: string;
    committerTimestamp: number;
    message: string;
  };
}

export async function getRepoMeta(owner: string, repo: string) {
  const resp = await doFetch(owner, repo, "get-meta");
  if (!resp.ok) return null;
  return (await resp.json()) as {
    owner: string;
    name: string;
    description: string;
    visibility: string;
    default_branch: string;
    created_at: string;
    updated_at: string | null;
  };
}
