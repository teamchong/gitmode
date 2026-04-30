// log-walk — BFS commit history from seed SHAs, optionally filtered.
//
// Like mergeBase, walks history via parse-commits RPCs against pool slots.
// Returns commits in BFS order (typically chronological-ish, but exact
// order depends on the merge topology). Stops when `limit` matched results
// have been collected, when the frontier is empty, or at `maxDepth`.

import type { CommitInfo } from "../commit-parse";
import type { CommitLookup } from "./merge-base";
import { parseCommitsRPC } from "./pool-rpc";

export interface LogWalkOptions {
  /** Starting commits — typically [HEAD] or a branch tip. */
  seeds: string[];
  repoPath: string;
  lookup: CommitLookup;
  pool: DurableObjectNamespace;
  /** Predicate to include a commit in results. Default: include all. */
  filter?: (commit: CommitInfo) => boolean;
  /** Cap on the number of matching commits returned. Default: 100. */
  limit?: number;
  /** Cap on BFS depth (parent levels). Default 1000. */
  maxDepth?: number;
  /** Slot name override; defaults to `log-walk-{repoPath}`. */
  slotName?: string;
}

/**
 * Walk commit history breadth-first from `seeds`, returning matching commits.
 *
 * Visits each commit at most once. When `filter` returns true the commit goes
 * into the result; either way, its parents are queued. Stops at `limit`
 * matches, empty frontier, or `maxDepth`.
 */
export async function logWalk(opts: LogWalkOptions): Promise<CommitInfo[]> {
  const { seeds, repoPath, lookup, pool } = opts;
  const filter = opts.filter ?? (() => true);
  const limit = opts.limit ?? 100;
  const maxDepth = opts.maxDepth ?? 1000;
  const slotName = opts.slotName ?? `log-walk-${repoPath}`;

  if (seeds.length === 0) return [];

  const visited = new Set<string>(seeds);
  const results: CommitInfo[] = [];
  let frontier: string[] = [...seeds];

  for (let depth = 0; depth < maxDepth; depth++) {
    if (frontier.length === 0) break;

    const parsed = await parseCommitsRPC(pool, slotName, repoPath, lookup, frontier);
    if (parsed.length === 0) break;

    const next: string[] = [];
    for (const commit of parsed) {
      if (filter(commit)) {
        results.push(commit);
        if (results.length >= limit) return results;
      }
      for (const parent of commit.parents) {
        if (!visited.has(parent)) {
          visited.add(parent);
          next.push(parent);
        }
      }
    }

    frontier = next;
  }

  return results;
}
