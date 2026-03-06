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
): Promise<void> {
  const newTree = await getTreeSha(engine, commitSha);
  const prefix = `${repoPath}/worktrees/${branch}/`;

  // Collect new tree files
  const newFiles = new Map<string, string>(); // filepath -> blobSha
  await walkTree(engine, newTree, "", newFiles);

  if (oldCommitSha) {
    // Incremental: diff old tree vs new tree, only write changes
    let oldTree: string | null = null;
    try {
      oldTree = await getTreeSha(engine, oldCommitSha);
    } catch {
      // old commit not readable, fall through to full write
    }

    if (oldTree) {
      const oldFiles = new Map<string, string>();
      await walkTree(engine, oldTree, "", oldFiles);

      const writes: Promise<void>[] = [];
      const deletes: string[] = [];

      // Find added or modified files
      for (const [path, sha] of newFiles) {
        const oldSha = oldFiles.get(path);
        if (oldSha !== sha) {
          // New or changed — write it
          writes.push(writeBlobToWorktree(engine, env, repoPath, branch, path, sha));
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
  }

  // Full materialization: delete all old files, write all new files
  await deleteByPrefix(env.OBJECTS, prefix);
  const writes: Promise<void>[] = [];
  for (const [filepath, blobSha] of newFiles) {
    writes.push(writeBlobToWorktree(engine, env, repoPath, branch, filepath, blobSha));
  }
  await Promise.all(writes);
}

async function getTreeSha(engine: GitEngine, commitSha: string): Promise<string> {
  const commit = await engine.readObject(commitSha);
  if (!commit || commit.type !== OBJ_COMMIT) {
    throw new Error(`Cannot read commit ${commitSha}`);
  }
  const text = new TextDecoder().decode(commit.content);
  const m = text.match(/^tree ([0-9a-f]{40})/m);
  if (!m) throw new Error(`No tree in commit ${commitSha}`);
  return m[1];
}

/**
 * Recursively walk a git tree object, collecting filepath -> blobSha entries.
 */
async function walkTree(
  engine: GitEngine,
  treeSha: string,
  pathPrefix: string,
  files: Map<string, string>
): Promise<void> {
  const tree = await engine.readObject(treeSha);
  if (!tree || tree.type !== OBJ_TREE) {
    throw new Error(`Cannot read tree ${treeSha}`);
  }

  const data = tree.content;
  let offset = 0;

  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;

    const mode = new TextDecoder().decode(data.slice(offset, spaceIdx));
    const name = new TextDecoder().decode(data.slice(spaceIdx + 1, nullIdx));
    const shaBytes = data.slice(nullIdx + 1, nullIdx + 21);
    const sha = Array.from(shaBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    offset = nullIdx + 21;
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

    if (mode === "40000") {
      await walkTree(engine, sha, fullPath, files);
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
  blobSha: string
): Promise<void> {
  const obj = await engine.readObject(blobSha);
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
  // R2 delete supports batches
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await Promise.all(batch.map((key) => bucket.delete(key)));
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
