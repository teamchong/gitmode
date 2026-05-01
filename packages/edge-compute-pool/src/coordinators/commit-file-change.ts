// commit-file-change — the round-trip write coordinator.
//
// Given an Artifacts URL, branch, and a single-path change (write or
// delete), this builds a new commit on top of the current branch tip
// and pushes it back via git-receive-pack. Everything composes from
// the existing primitives — this file is just the orchestration glue.
//
// Steps:
//   1. discoverArtifactsRefs — find the current branch tip
//   2. (if branch exists) fetchArtifactsCommit — stage the commit's
//      transitive closure in R2 so we can read its trees locally
//   3. Walk the commit's root tree → mutate via applyTreeChange,
//      producing a new root tree + every intermediate tree
//   4. buildCommitBytes for the new commit pointing at the new root
//   5. buildPackfile with the new blob (if any) + new trees + new commit
//   6. pushPack via git-receive-pack to update the branch ref

import type { WasmEngine } from "@gitmode/wasm-git";
import { OBJ_TREE, OBJ_COMMIT } from "../pack-format";
import { applyTreeChange, type ObjectHasher, type TreeLoader } from "./tree-update";
import { buildCommitBytes } from "../protocol/commit-bytes";
import { buildPackfile, type ObjectToPack } from "../protocol/packfile-writer";
import {
  discoverArtifactsRefs,
} from "./artifacts-fetch";
import { fetchArtifactsCommit } from "./artifacts-fetch";
import { pushPack, NULL_SHA, type PushResult } from "../protocol/smart-http";

const decoder = new TextDecoder();

export interface CommitFileChangeOptions {
  /** Base repo URL — `https://x.artifacts.cloudflare.net/git/repo.git`. */
  artifactsUrl: string;
  /** Repo-scoped Artifacts token. */
  token?: string;
  /** Branch to update. Bare name like "main" — we add `refs/heads/`. */
  branch: string;
  /** Slash-split path components, e.g. ["src", "foo.ts"]. */
  pathParts: string[];
  /** New file bytes, or null to delete the path. */
  newContent: Uint8Array | null;
  /** File mode for new/replaced blobs. Default "100644" (regular file). */
  mode?: string;
  /** Identity to record on the commit. */
  authorName: string;
  authorEmail: string;
  /** Commit message subject (and optionally body, separated by \n\n). */
  message: string;
  /** Unix timestamp seconds. Default `Date.now() / 1000 | 0`. */
  authorTimestamp?: number;
  /** Timezone like "+0000". Default "+0000". */
  authorTz?: string;
  /** R2 bucket for object staging (read closure cached here). */
  bucket: R2Bucket;
  /** R2 key prefix used by fetchArtifactsCommit. Default derived from URL. */
  repoPath: string;
  /** WASM engine for zlib + delta. Caller manages lifecycle. */
  wasm: WasmEngine;
  /** Override fetch (for tests). */
  fetcher?: typeof fetch;
  /** If true, skip the fetchArtifactsCommit step (caller has already staged). */
  skipFetch?: boolean;
}

export interface CommitFileChangeResult {
  /** SHA of the commit we created. */
  newCommitSha: string;
  /** SHA the branch was at before this push. NULL_SHA if branch was new. */
  oldCommitSha: string;
  /** Push response from the server. */
  pushResult: PushResult;
}

/**
 * Make a single-path change to a branch in an Artifacts repo and push
 * the result back as one commit.
 */
export async function commitFileChange(
  opts: CommitFileChangeOptions,
): Promise<CommitFileChangeResult> {
  const {
    artifactsUrl,
    token,
    branch,
    pathParts,
    newContent,
    bucket,
    repoPath,
    wasm,
    fetcher,
  } = opts;

  if (pathParts.length === 0) throw new Error("commitFileChange: pathParts must be non-empty");
  const refName = `refs/heads/${branch}`;
  const mode = opts.mode ?? "100644";

  // 1. Discover the current branch tip.
  const adv = await discoverArtifactsRefs({
    artifactsUrl,
    ...(token ? { token } : {}),
    ...(fetcher ? { fetcher } : {}),
  });
  const currentSha = adv.refs.get(refName) ?? NULL_SHA;

  // 2. Stage the closure so we can read existing trees, unless caller already did.
  if (currentSha !== NULL_SHA && !opts.skipFetch) {
    await fetchArtifactsCommit({
      artifactsUrl,
      ...(token ? { token } : {}),
      commitSha: currentSha,
      repoPath,
      bucket,
      wasm,
      ...(fetcher ? { fetcher } : {}),
    });
  }

  // Resolve the base tree sha.
  let baseTreeSha: string | null = null;
  if (currentSha !== NULL_SHA) {
    const commitContent = await readObjectContent(bucket, repoPath, currentSha, wasm);
    if (!commitContent) throw new Error(`commitFileChange: missing staged commit ${currentSha}`);
    baseTreeSha = parseCommitTreeRef(commitContent);
    if (!baseTreeSha) throw new Error(`commitFileChange: cannot parse tree ref from commit ${currentSha}`);
  }

  // 3. Apply the change, producing new blob + trees.
  const loader: TreeLoader = (sha) => readObjectContent(bucket, repoPath, sha, wasm);
  const hasher: ObjectHasher = (type, content) => gitObjectSha1(type, content);

  const treeChange = await applyTreeChange({
    baseTreeSha,
    pathParts,
    newBlob: newContent ? { mode, content: newContent } : null,
    loader,
    hasher,
  });

  // 4. Build the new commit object.
  const commitBytes = buildCommitBytes({
    tree: treeChange.newRootSha,
    parents: currentSha === NULL_SHA ? [] : [currentSha],
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
    authorTimestamp: opts.authorTimestamp ?? Math.floor(Date.now() / 1000),
    ...(opts.authorTz ? { authorTz: opts.authorTz } : {}),
    message: opts.message,
  });
  const commitSha = await gitObjectSha1(OBJ_COMMIT, commitBytes);

  // 5. Build the pack.
  const packObjects: ObjectToPack[] = [
    ...treeChange.newObjects.map((o) => ({ type: o.type, content: o.content })),
    { type: OBJ_COMMIT, content: commitBytes },
  ];
  const pack = await buildPackfile(wasm, packObjects);

  // 6. Push.
  const pushResult = await pushPack({
    url: artifactsUrl,
    ...(token ? { token } : {}),
    ...(fetcher ? { fetcher } : {}),
    refUpdates: [{ refName, oldSha: currentSha, newSha: commitSha }],
    packData: pack,
  });

  return {
    newCommitSha: commitSha,
    oldCommitSha: currentSha,
    pushResult,
  };
}

/**
 * Read a staged object from R2 and return just its content bytes
 * (decompresses + strips the `<type> <size>\0` header). Returns null
 * if the object isn't staged.
 */
async function readObjectContent(
  bucket: R2Bucket,
  repoPath: string,
  sha: string,
  wasm: WasmEngine,
): Promise<Uint8Array | null> {
  const obj = await bucket.get(`${repoPath}/loose/${sha}`);
  if (!obj) return null;
  const compressed = new Uint8Array(await obj.arrayBuffer());
  // Decompress with a generous output cap; the engine will stop at end-of-stream.
  const inflated = wasm.zlibInflate(compressed, 64 * 1024 * 1024);
  // Strip the "<type> <size>\0" header.
  const nullIdx = inflated.indexOf(0x00);
  if (nullIdx === -1) return null;
  return inflated.subarray(nullIdx + 1);
}

/** Compute a git object's SHA-1 over `<type> <size>\0<content>`. */
async function gitObjectSha1(type: number, content: Uint8Array): Promise<string> {
  const TYPE_NAMES: Record<number, string> = {
    1: "blob",
    2: "tree",
    3: "commit",
    4: "tag",
  };
  const typeName = TYPE_NAMES[type];
  if (!typeName) throw new Error(`gitObjectSha1: unknown type ${type}`);
  const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header, 0);
  buf.set(content, header.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  let s = "";
  for (let i = 0; i < hash.length; i++) s += hash[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Pull the `tree <sha>` line out of a commit object body. */
function parseCommitTreeRef(commitBody: Uint8Array): string | null {
  const headerEnd = commitBody.indexOf(0x0a); // first newline = end of "tree …" line
  if (headerEnd === -1) return null;
  const text = decoder.decode(commitBody.subarray(0, headerEnd));
  if (!text.startsWith("tree ")) return null;
  return text.slice(5);
}

// Suppress unused-import if OBJ_TREE turns out to be referenced indirectly.
void OBJ_TREE;
