// checkout.ts — Materialize a commit tree into R2 worktree files
//
// After a push updates a ref, this walks the commit's tree and writes
// every blob to R2 at: {owner}/{repo}/worktrees/{branch}/{filepath}
//
// The vinext UI reads these files directly — no git decompression needed.

import { GitEngine, OBJ_TREE, OBJ_BLOB, OBJ_COMMIT } from "./git-engine";
import type { Env } from "./env";

/**
 * Materialize the tree at `commitSha` into R2 worktree files for `branch`.
 * Deletes stale files from the previous worktree first.
 */
export async function materializeWorktree(
  engine: GitEngine,
  env: Env,
  repoPath: string,
  branch: string,
  commitSha: string
): Promise<void> {
  // Read commit to get tree SHA
  const commit = await engine.readObject(commitSha);
  if (!commit || commit.type !== OBJ_COMMIT) {
    throw new Error(`Cannot read commit ${commitSha}`);
  }

  const commitText = new TextDecoder().decode(commit.content);
  const treeMatch = commitText.match(/^tree ([0-9a-f]{40})/m);
  if (!treeMatch) {
    throw new Error(`No tree in commit ${commitSha}`);
  }
  const treeSha = treeMatch[1];

  // Walk the tree and collect all file paths + blob SHAs
  const files = new Map<string, string>(); // filepath -> blobSha
  await walkTree(engine, treeSha, "", files);

  // Delete previous worktree files for this branch
  const prefix = `${repoPath}/worktrees/${branch}/`;
  await deleteByPrefix(env.OBJECTS, prefix);

  // Write all blobs to worktree
  const writes: Promise<void>[] = [];
  for (const [filepath, blobSha] of files) {
    writes.push(writeBlobToWorktree(engine, env, repoPath, branch, filepath, blobSha));
  }
  await Promise.all(writes);
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

  // Parse tree entries: each entry is "<mode> <name>\0<20-byte-sha>"
  const data = tree.content;
  let offset = 0;

  while (offset < data.length) {
    // Find space after mode
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;

    // Find null after name
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;

    const mode = new TextDecoder().decode(data.slice(offset, spaceIdx));
    const name = new TextDecoder().decode(data.slice(spaceIdx + 1, nullIdx));

    // Read 20-byte binary SHA
    const shaBytes = data.slice(nullIdx + 1, nullIdx + 21);
    const sha = Array.from(shaBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    offset = nullIdx + 21;

    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

    if (mode === "40000") {
      // Directory — recurse
      await walkTree(engine, sha, fullPath, files);
    } else {
      // File (blob)
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

  const key = `${repoPath}/worktrees/${branch}/${filepath}`;
  await env.OBJECTS.put(key, obj.content);
}

/**
 * Delete all R2 keys with a given prefix (batch delete).
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

  // R2 delete supports up to 1000 keys at a time
  for (let i = 0; i < keysToDelete.length; i += 1000) {
    const batch = keysToDelete.slice(i, i + 1000);
    await Promise.all(batch.map((key) => bucket.delete(key)));
  }
}
