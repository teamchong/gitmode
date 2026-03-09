// checkout.ts — Materialize a commit tree into R2 worktree files
//
// After a push updates a ref, this walks the commit's tree and writes
// blobs to R2 at: {owner}/{repo}/worktrees/{branch}/{filepath}
//
// The vinext UI reads these files directly — no git decompression needed.
//
// Optimization: On incremental push, diffs the old and new trees and only
// writes changed/added files, deletes removed files. Avoids rewriting
// the entire worktree on every push.

import { GitEngine, OBJ_TREE, OBJ_BLOB, OBJ_COMMIT } from "./git-engine";
import type { Env } from "./env";
import type { ObjectCache } from "./packfile-reader";
import { toHex } from "./hex";

const decoder = new TextDecoder();

/**
 * Materialize the tree at `commitSha` into R2 worktree files for `branch`.
 * If `oldCommitSha` is provided, only writes changed/added files and deletes removed ones.
 */
export async function materializeWorktree(
  engine: GitEngine,
  env: Env,
  repoPath: string,
  branch: string,
  commitSha: string,
  oldCommitSha?: string,
  objectCache?: ObjectCache,
): Promise<void> {
  const newTree = await getTreeSha(engine, commitSha, objectCache);
  const prefix = `${repoPath}/worktrees/${branch}/`;

  // Resolve old tree for incremental diff
  let oldTree: string | null = null;
  if (oldCommitSha) {
    try {
      oldTree = await getTreeSha(engine, oldCommitSha, objectCache);
    } catch {
      // old commit not readable, fall through to full write
    }
    // Skip if tree unchanged (empty commit, metadata-only change)
    if (oldTree === newTree) return;
  }

  // Collect new tree files
  const newFiles = new Map<string, string>(); // filepath -> blobSha
  await walkTree(engine, newTree, "", newFiles, objectCache);

  if (oldTree) {
    const oldFiles = new Map<string, string>();
    await walkTree(engine, oldTree, "", oldFiles, objectCache);

    const writes: Promise<void>[] = [];
    const deletes: string[] = [];

    // Find added or modified files
    for (const [path, sha] of newFiles) {
      const oldSha = oldFiles.get(path);
      if (oldSha !== sha) {
        writes.push(writeBlobToWorktree(engine, env, repoPath, branch, path, sha, objectCache));
      }
    }

    // Find deleted files
    for (const path of oldFiles.keys()) {
      if (!newFiles.has(path)) {
        deletes.push(`${prefix}${path}`);
      }
    }

    // Execute writes and deletes in parallel
    if (deletes.length > 0) {
      writes.push(deleteKeys(env.OBJECTS, deletes));
    }
    await Promise.all(writes);
    return;
  }

  // Full materialization: delete all old files, write all new files
  await deleteByPrefix(env.OBJECTS, prefix);

  const entries = [...newFiles.entries()];

  // Process in read+write batches of 500 to bound memory and yield control
  // between batches so the DO can serve incoming requests (e.g. clone).
  const READ_BATCH = 500;
  const WRITE_CONCURRENCY = 100;

  for (let r = 0; r < entries.length; r += READ_BATCH) {
    const readSlice = entries.slice(r, r + READ_BATCH);
    const uncachedShas = readSlice
      .map(([, sha]) => sha)
      .filter(sha => !objectCache?.has(sha));
    const batchRead = uncachedShas.length > 0
      ? await engine.readObjects(uncachedShas)
      : new Map<string, { type: number; content: Uint8Array }>();

    for (let i = 0; i < readSlice.length; i += WRITE_CONCURRENCY) {
      const batch = readSlice.slice(i, i + WRITE_CONCURRENCY);
      await Promise.all(
        batch.map(([filepath, blobSha]) => {
          let content: Uint8Array | undefined;
          if (objectCache?.has(blobSha)) {
            const cached = objectCache.get(blobSha)!;
            if (cached.type === OBJ_BLOB) content = cached.data;
          } else {
            const obj = batchRead.get(blobSha);
            if (obj?.type === OBJ_BLOB) content = obj.content;
          }
          if (!content) {
            console.error(`checkout: cannot read blob ${blobSha} for ${filepath}`);
            return Promise.resolve();
          }
          return env.OBJECTS.put(`${repoPath}/worktrees/${branch}/${filepath}`, content);
        })
      );
    }
    // batchRead released here; yield to let DO process pending fetch requests
    if (r + READ_BATCH < entries.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

async function readObjectCached(
  engine: GitEngine,
  sha: string,
  cache?: ObjectCache,
): Promise<{ type: number; content: Uint8Array } | null> {
  if (cache) {
    const cached = cache.get(sha);
    if (cached) return { type: cached.type, content: cached.data };
  }
  return engine.readObject(sha);
}

async function getTreeSha(engine: GitEngine, commitSha: string, cache?: ObjectCache): Promise<string> {
  const commit = await readObjectCached(engine, commitSha, cache);
  if (!commit || commit.type !== OBJ_COMMIT) {
    throw new Error(`Cannot read commit ${commitSha}`);
  }
  const text = decoder.decode(commit.content);
  const m = text.match(/^tree ([0-9a-f]{40})/m);
  if (!m) throw new Error(`No tree in commit ${commitSha}`);
  return m[1];
}

const MAX_TREE_DEPTH = 100;

/**
 * Recursively walk a git tree object, collecting filepath -> blobSha entries.
 */
async function walkTree(
  engine: GitEngine,
  treeSha: string,
  pathPrefix: string,
  files: Map<string, string>,
  cache?: ObjectCache,
  depth = 0,
): Promise<void> {
  if (depth > MAX_TREE_DEPTH) {
    throw new Error(`Tree nesting exceeds maximum depth (${MAX_TREE_DEPTH})`);
  }

  const tree = await readObjectCached(engine, treeSha, cache);
  if (!tree || tree.type !== OBJ_TREE) {
    throw new Error(`Cannot read tree ${treeSha}`);
  }

  const data = tree.content;
  let offset = 0;

  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1 || nullIdx + 21 > data.length) break;

    const mode = decoder.decode(data.subarray(offset, spaceIdx));
    const name = decoder.decode(data.subarray(spaceIdx + 1, nullIdx));
    const shaBytes = data.subarray(nullIdx + 1, nullIdx + 21);
    const sha = toHex(shaBytes);

    offset = nullIdx + 21;
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

    if (mode === "40000") {
      await walkTree(engine, sha, fullPath, files, cache, depth + 1);
    } else {
      files.set(fullPath, sha);
    }
  }
}

/**
 * Read a blob from git storage, decompress, and write raw content to R2 worktree.
 */
async function writeBlobToWorktree(
  engine: GitEngine,
  env: Env,
  repoPath: string,
  branch: string,
  filepath: string,
  blobSha: string,
  cache?: ObjectCache,
): Promise<void> {
  const obj = await readObjectCached(engine, blobSha, cache);
  if (!obj || obj.type !== OBJ_BLOB) {
    console.error(`checkout: cannot read blob ${blobSha} for ${filepath}`);
    return;
  }
  await env.OBJECTS.put(`${repoPath}/worktrees/${branch}/${filepath}`, obj.content);
}

/**
 * Delete specific R2 keys.
 */
async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  // R2 delete() accepts an array of up to 1000 keys
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

/**
 * Delete all R2 keys with a given prefix (for full re-materialization).
 */
async function deleteByPrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  const keysToDelete: string[] = [];

  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects) {
      keysToDelete.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  await deleteKeys(bucket, keysToDelete);
}
