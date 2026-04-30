// Shared RPC helpers for coordinator-side BFS over PackWorkerDO actions.
//
// Centralizes the dispatch boilerplate so each coordinator (mergeBase,
// logWalk, blameWalk, etc.) is just the algorithm, not the plumbing.

import type { CommitInfo } from "../commit-parse";
import type { CommitLocation, CommitLookup } from "./merge-base";

interface ActionResponse<T> {
  results: T[];
  errors?: Array<{ sha: string; error: string }>;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

interface TreeResult {
  sha: string;
  entries: TreeEntry[];
}

interface BlobResult {
  sha: string;
  size: number;
  contentBase64: string;
}

async function rpc<T>(
  pool: DurableObjectNamespace,
  slotName: string,
  action: string,
  body: object,
): Promise<T> {
  const id = pool.idFromName(slotName);
  const worker = pool.get(id);
  const res = await worker.fetch("http://do/", {
    method: "POST",
    headers: { "x-action": action, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${action} returned ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function withLocation(
  shas: string[],
  lookup: CommitLookup,
): Array<{ sha: string } & CommitLocation> {
  const out: Array<{ sha: string } & CommitLocation> = [];
  for (const sha of shas) {
    const loc = lookup(sha);
    if (loc) out.push({ sha, ...loc });
  }
  return out;
}

export async function parseCommitsRPC(
  pool: DurableObjectNamespace,
  slotName: string,
  repoPath: string,
  lookup: CommitLookup,
  shas: string[],
): Promise<CommitInfo[]> {
  if (shas.length === 0) return [];
  const commits = withLocation(shas, lookup);
  if (commits.length === 0) return [];
  const out = await rpc<ActionResponse<CommitInfo>>(pool, slotName, "parse-commits", {
    repoPath,
    commits,
  });
  return out.results;
}

export async function walkTreesRPC(
  pool: DurableObjectNamespace,
  slotName: string,
  repoPath: string,
  lookup: CommitLookup,
  treeShas: string[],
): Promise<TreeResult[]> {
  if (treeShas.length === 0) return [];
  const trees = withLocation(treeShas, lookup);
  if (trees.length === 0) return [];
  const out = await rpc<ActionResponse<TreeResult>>(pool, slotName, "walk-trees", {
    repoPath,
    trees,
  });
  return out.results;
}

export async function readBlobsRPC(
  pool: DurableObjectNamespace,
  slotName: string,
  repoPath: string,
  lookup: CommitLookup,
  blobShas: string[],
  maxBlobBytes?: number,
): Promise<BlobResult[]> {
  if (blobShas.length === 0) return [];
  const blobs = withLocation(blobShas, lookup);
  if (blobs.length === 0) return [];
  const body: Record<string, unknown> = { repoPath, blobs };
  if (maxBlobBytes !== undefined) body.maxBlobBytes = maxBlobBytes;
  const out = await rpc<ActionResponse<BlobResult>>(pool, slotName, "read-blobs", body);
  return out.results;
}
