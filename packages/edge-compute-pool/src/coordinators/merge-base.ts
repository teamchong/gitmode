// merge-base — find the lowest common ancestor of two commits using
// the parse-commits pool action. This is the canonical example of how
// to compose a higher-level git operation from the slot primitive.
//
// Algorithm: alternating BFS from both starting commits. Each level
// dispatches one parse-commits RPC against the pool. When a commit is
// reached from both sides, it's the merge base.
//
// API status: example/recipe, not the stable package surface. The stable
// surface is `PackWorkerDO` + `dispatchToPool` + `parseCommitFromRaw` —
// callers can compose any history-walk on top.

import type { CommitInfo } from "../commit-parse";

export interface CommitLocation {
  chunkKey?: string;
  offset?: number;
  length?: number;
  looseKey?: string;
}

/** Resolve a commit SHA to its R2 location. */
export type CommitLookup = (sha: string) => CommitLocation | null;

export interface MergeBaseOptions {
  shaA: string;
  shaB: string;
  repoPath: string;
  lookup: CommitLookup;
  pool: DurableObjectNamespace;
  /** Cap on BFS depth before giving up. Default 1000. */
  maxDepth?: number;
  /** Slot name to use; defaults to "merge-base-{repoPath}". */
  slotName?: string;
}

interface ParseCommitsResponse {
  results: CommitInfo[];
  errors?: Array<{ sha: string; error: string }>;
}

async function parseCommitsRPC(
  pool: DurableObjectNamespace,
  slotName: string,
  repoPath: string,
  lookup: CommitLookup,
  shas: string[],
): Promise<CommitInfo[]> {
  if (shas.length === 0) return [];

  const commits = shas
    .map((sha) => {
      const loc = lookup(sha);
      return loc ? { sha, ...loc } : null;
    })
    .filter((c): c is { sha: string } & CommitLocation => c !== null);

  if (commits.length === 0) return [];

  const id = pool.idFromName(slotName);
  const worker = pool.get(id);
  const res = await worker.fetch("http://do/", {
    method: "POST",
    headers: { "x-action": "parse-commits", "content-type": "application/json" },
    body: JSON.stringify({ repoPath, commits }),
  });

  if (!res.ok) {
    throw new Error(`parse-commits returned ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as ParseCommitsResponse;
  return body.results;
}

/**
 * Find the lowest common ancestor of two commits.
 *
 * Returns the SHA of the merge base, or `null` if the histories don't
 * share an ancestor within `maxDepth` BFS levels.
 */
export async function mergeBase(opts: MergeBaseOptions): Promise<string | null> {
  const { shaA, shaB, repoPath, lookup, pool } = opts;
  const maxDepth = opts.maxDepth ?? 1000;
  const slotName = opts.slotName ?? `merge-base-${repoPath}`;

  if (shaA === shaB) return shaA;

  const ancestorsA = new Set<string>([shaA]);
  const ancestorsB = new Set<string>([shaB]);
  let frontierA: string[] = [shaA];
  let frontierB: string[] = [shaB];

  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontierA.length === 0 && frontierB.length === 0) return null;

    // Walk one BFS level on each side. The two RPCs run in parallel —
    // a single coordinator can saturate two slots even at the smallest
    // dispatch granularity.
    const [parsedA, parsedB] = await Promise.all([
      parseCommitsRPC(pool, slotName, repoPath, lookup, frontierA),
      parseCommitsRPC(pool, slotName, repoPath, lookup, frontierB),
    ]);

    const nextA: string[] = [];
    for (const c of parsedA) {
      for (const p of c.parents) {
        if (ancestorsB.has(p)) return p;
        if (!ancestorsA.has(p)) {
          ancestorsA.add(p);
          nextA.push(p);
        }
      }
    }

    const nextB: string[] = [];
    for (const c of parsedB) {
      for (const p of c.parents) {
        if (ancestorsA.has(p)) return p;
        if (!ancestorsB.has(p)) {
          ancestorsB.add(p);
          nextB.push(p);
        }
      }
    }

    frontierA = nextA;
    frontierB = nextB;
  }

  return null;
}
