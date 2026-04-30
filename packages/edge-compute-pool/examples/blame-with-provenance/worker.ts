// Worker that demonstrates the full toolkit composing.
//
// Endpoint: GET /blame?repo=<artifacts-url>&sha=<commit-sha>&path=<file-path>
//
// Flow:
//   1. fetchArtifactsCommit  → stage commit closure in R2 from the given Artifacts URL
//   2. blameWalk             → per-line attribution for the requested file
//   3. PROMPT_BLAME_DB join  → enrich each line's commit with prompt provenance
//   4. Return enriched JSON with lineNumber / line / commit / prompt_id / model / agent / session
//
// This is the runnable version of the README's "Full toolkit composing
// against an Artifacts repo" example. It's typechecked against the package
// exports — if the package API drifts, this fails to compile.

import { WasmEngine } from "@gitmode/wasm-git";
import {
  fetchArtifactsCommit,
  blameWalk,
  type CommitLookup,
  type BlameLine,
} from "../../src/index";

interface Env {
  /** R2 bucket where staged git objects are written. */
  OBJECTS: R2Bucket;
  /** PackWorkerDO binding for the fan-out compute slots. */
  PACK_WORKER: DurableObjectNamespace;
  /** D1 binding for the prompt-blame sidecar (the @gitmode/prompt-blame package's schema). */
  PROMPT_BLAME_DB: D1Database;
  /** Optional: Artifacts repo-scoped token for authenticated remotes. */
  ARTIFACTS_TOKEN?: string;
}

interface PromptMetaRow {
  commit_sha: string;
  prompt_id: string | null;
  model: string | null;
  agent: string | null;
  session_id: string | null;
}

interface EnrichedBlameLine extends BlameLine {
  prompt_id: string | null;
  model: string | null;
  agent: string | null;
  session_id: string | null;
}

async function enrichBlame(
  blame: BlameLine[],
  repoId: string,
  db: D1Database,
): Promise<EnrichedBlameLine[]> {
  const uniqueCommits = [...new Set(blame.map((b) => b.commit))];
  if (uniqueCommits.length === 0) return [];

  const bindMarkers = uniqueCommits.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT commit_sha, prompt_id, model, agent, session_id
     FROM commit_metadata
     WHERE repo_id = ? AND commit_sha IN (${bindMarkers})`,
  );
  const queryResult = await stmt.bind(repoId, ...uniqueCommits).all<PromptMetaRow>();
  const byCommit = new Map<string, PromptMetaRow>(
    (queryResult.results ?? []).map((r) => [r.commit_sha, r]),
  );

  return blame.map((b) => {
    const meta = byCommit.get(b.commit);
    return {
      ...b,
      prompt_id: meta?.prompt_id ?? null,
      model: meta?.model ?? null,
      agent: meta?.agent ?? null,
      session_id: meta?.session_id ?? null,
    };
  });
}

const SHA_RE = /^[0-9a-f]{40}$/;

function repoPathFromUrl(url: string): string {
  // A simple, deterministic key prefix per artifacts URL. Real deployments
  // would normalize the URL more aggressively (strip auth, lowercase host).
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9-_./]/g, "-");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/blame") {
      return new Response("usage: GET /blame?repo=<url>&sha=<sha>&path=<file>", {
        status: 404,
      });
    }

    const repo = url.searchParams.get("repo");
    const sha = url.searchParams.get("sha");
    const filePath = url.searchParams.get("path");

    if (!repo || !sha || !filePath) {
      return Response.json(
        { error: "missing query params: repo, sha, path are all required" },
        { status: 400 },
      );
    }
    if (!SHA_RE.test(sha)) {
      return Response.json({ error: "sha must be 40 lowercase hex characters" }, { status: 400 });
    }

    const repoPath = repoPathFromUrl(repo);
    const wasm = await WasmEngine.create();

    // 1. Stage the commit closure in R2
    await fetchArtifactsCommit({
      artifactsUrl: repo,
      ...(env.ARTIFACTS_TOKEN ? { token: env.ARTIFACTS_TOKEN } : {}),
      commitSha: sha,
      repoPath,
      bucket: env.OBJECTS,
      wasm,
    });

    // 2. Blame the requested file
    const lookup: CommitLookup = (s) => ({ looseKey: `${repoPath}/loose/${s}` });
    const blame = await blameWalk({
      startSha: sha,
      filePath,
      repoPath,
      lookup,
      pool: env.PACK_WORKER,
    });

    if (!blame) {
      return Response.json(
        { error: `file '${filePath}' not found at commit ${sha}` },
        { status: 404 },
      );
    }

    // 3. Enrich with prompt provenance
    const enriched = await enrichBlame(blame, repo.toLowerCase(), env.PROMPT_BLAME_DB);

    return Response.json({
      repo,
      sha,
      path: filePath,
      lines: enriched,
    });
  },
} satisfies ExportedHandler<Env>;
