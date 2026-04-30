// artifacts-fetch — fetch a commit's transitive closure from a Git remote
// (Cloudflare Artifacts or any smart-HTTP server) and stage all objects
// in R2 at the standard `${repoPath}/loose/${sha}` layout the pool actions
// expect.
//
// Flow:
//   1. (optional) discoverRefs to resolve a ref name → SHA, or list refs
//   2. fetchPack with want=[commitSha] → packfile bytes
//   3. unpackPackfile → each object decompressed + delta-resolved
//   4. recompress each object as a loose git object and write to R2
//
// After this completes, callers can invoke the existing pool actions
// (parse-commits, read-blobs, walk-trees) against the staged objects.

import type { WasmEngine } from "@gitmode/wasm-git";
import { OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG } from "../pack-format";
import { unpackPackfile } from "../protocol/packfile-reader";
import { discoverRefs, fetchPack, type RefAdvertisement } from "../protocol/smart-http";

export interface FetchArtifactsCommitOptions {
  /** Base repo URL — e.g. "https://x.artifacts.cloudflare.net/git/repo-13194.git". */
  artifactsUrl: string;
  /** Repo-scoped Artifacts token (or empty for public repos). */
  token?: string;
  /** Commit SHA to fetch (with full transitive closure). */
  commitSha: string;
  /** R2 key prefix for staged objects. Loose keys become `${repoPath}/loose/${sha}`. */
  repoPath: string;
  /** R2 bucket binding to write objects into. */
  bucket: R2Bucket;
  /** WASM engine for zlib/delta operations. Caller manages lifecycle. */
  wasm: WasmEngine;
  /** Override fetch (for tests). */
  fetcher?: typeof fetch;
  /** Concurrency for R2 writes. Default 10. */
  writeConcurrency?: number;
}

export interface FetchArtifactsCommitResult {
  /** Number of objects fetched and written. */
  objectsWritten: number;
  /** SHAs of all unpacked objects. */
  shas: string[];
}

function objectTypeToName(t: number): string {
  switch (t) {
    case OBJ_BLOB:
      return "blob";
    case OBJ_TREE:
      return "tree";
    case OBJ_COMMIT:
      return "commit";
    case OBJ_TAG:
      return "tag";
    default:
      throw new Error(`Unknown object type: ${t}`);
  }
}

/**
 * Compose a loose-format git object: zlib(`<type> <size>\0<content>`).
 * Matches what `git hash-object -w` writes to `.git/objects/<sha[:2]>/<sha[2:]>`.
 */
function packLooseObject(wasm: WasmEngine, type: number, content: Uint8Array): Uint8Array {
  const typeName = objectTypeToName(type);
  const header = new TextEncoder().encode(`${typeName} ${content.length}\0`);
  const raw = new Uint8Array(header.length + content.length);
  raw.set(header, 0);
  raw.set(content, header.length);
  return wasm.zlibDeflate(raw);
}

/**
 * Fetch a commit + its transitive closure from an Artifacts (or any Git smart-HTTP)
 * remote, unpack the returned packfile, and write each object to R2.
 */
export async function fetchArtifactsCommit(
  opts: FetchArtifactsCommitOptions,
): Promise<FetchArtifactsCommitResult> {
  const { artifactsUrl, token, commitSha, repoPath, bucket, wasm } = opts;
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const concurrency = opts.writeConcurrency ?? 10;

  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error(`fetchArtifactsCommit: invalid commit sha: ${commitSha}`);
  }

  const packResult = await fetchPack({
    url: artifactsUrl,
    token,
    fetcher,
    wants: [commitSha],
  });

  if (packResult.errors) {
    throw new Error(`Artifacts server reported errors: ${packResult.errors.trim()}`);
  }
  if (packResult.pack.length === 0) {
    throw new Error("Empty packfile returned by Artifacts server");
  }

  const unpacked = await unpackPackfile(wasm, packResult.pack);

  // Recompress each object as a loose git blob and write to R2.
  const writes: Array<[string, Uint8Array]> = [];
  for (const [sha, obj] of unpacked.objects) {
    const compressed = packLooseObject(wasm, obj.type, obj.content);
    writes.push([`${repoPath}/loose/${sha}`, compressed]);
  }

  for (let i = 0; i < writes.length; i += concurrency) {
    const batch = writes.slice(i, i + concurrency);
    await Promise.all(batch.map(([key, body]) => bucket.put(key, body)));
  }

  return {
    objectsWritten: writes.length,
    shas: writes.map(([k]) => k.slice(`${repoPath}/loose/`.length)),
  };
}

/**
 * Discover the refs of an Artifacts repo. Useful when the caller wants to
 * fetch by branch / tag name rather than a known SHA.
 */
export async function discoverArtifactsRefs(opts: {
  artifactsUrl: string;
  token?: string;
  fetcher?: typeof fetch;
}): Promise<RefAdvertisement> {
  return discoverRefs({
    url: opts.artifactsUrl,
    token: opts.token,
    fetcher: opts.fetcher,
  });
}
