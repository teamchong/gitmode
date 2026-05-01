// artifacts-as-s3 — exposes any Cloudflare Artifacts repo as an
// S3-shaped REST API: GET / PUT / DELETE / HEAD / list, with optional
// version-pinning via ?version=<sha>.
//
// Request shape:
//   <method> /<file-path>
//   Headers:
//     X-Artifacts-Url: https://x.artifacts.cloudflare.net/git/<repo>.git
//     Authorization:  Bearer <artifacts-token>   (or Basic — passed through)
//     X-Branch:       main                        (default: "main")
//     X-Author-Name:  Tester                      (PUT/DELETE — for commit identity)
//     X-Author-Email: tester@example.com          (PUT/DELETE)
//
// Endpoints:
//   GET    /<path>                  → bytes of file at HEAD
//   GET    /<path>?version=<sha>    → bytes at specific commit
//   HEAD   /<path>                  → metadata (size, etag, version)
//   PUT    /<path>                  → write; body = file bytes; returns commit sha
//   DELETE /<path>                  → delete; returns commit sha
//   GET    /?prefix=…               → list (JSON)
//
// Versioning is "for free" — every PUT or DELETE creates a new commit,
// and ?version= reads from any previous commit. That's the differentiator
// over plain R2: time-travel + consistent snapshots across the whole repo.

import { WasmEngine } from "@gitmode/wasm-git";
import {
  fetchArtifactsCommit,
  discoverArtifactsRefs,
} from "../../src/coordinators/artifacts-fetch";
import { commitFileChange } from "../../src/coordinators/commit-file-change";
import { walkTreesRPC, parseCommitsRPC, readBlobsRPC } from "../../src/coordinators/pool-rpc";
import type { CommitLookup } from "../../src/coordinators/merge-base";

interface Env {
  OBJECTS: R2Bucket;
  PACK_WORKER: DurableObjectNamespace;
}

const DIR_MODE = "040000";
const SLOT_NAME = "artifacts-s3";

function repoPathFromUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9-_./]/g, "-");
}

function parseAuth(req: Request): { token?: string } {
  const auth = req.headers.get("authorization");
  if (!auth) return {};
  if (auth.startsWith("Bearer ")) return { token: auth.slice(7) };
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const colonIdx = decoded.indexOf(":");
      if (colonIdx !== -1) return { token: decoded.slice(colonIdx + 1) };
    } catch {
      // basic-decode failure falls through with no token
    }
  }
  return {};
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function ensureStaged(opts: {
  artifactsUrl: string;
  token: string | undefined;
  bucket: R2Bucket;
  repoPath: string;
  wasm: WasmEngine;
  commitSha: string;
}): Promise<void> {
  // Cheap check: if the commit object is already in R2, skip the fetch.
  const exists = await opts.bucket.head(`${opts.repoPath}/loose/${opts.commitSha}`);
  if (exists) return;
  await fetchArtifactsCommit({
    artifactsUrl: opts.artifactsUrl,
    ...(opts.token ? { token: opts.token } : {}),
    commitSha: opts.commitSha,
    repoPath: opts.repoPath,
    bucket: opts.bucket,
    wasm: opts.wasm,
  });
}

interface ResolvedFile {
  blobSha: string;
  mode: string;
  size: number;
}

async function resolveFile(opts: {
  rootTreeSha: string;
  pathParts: string[];
  repoPath: string;
  lookup: CommitLookup;
  pool: DurableObjectNamespace;
}): Promise<ResolvedFile | null> {
  let currentTreeSha = opts.rootTreeSha;
  for (let i = 0; i < opts.pathParts.length; i++) {
    const part = opts.pathParts[i]!;
    const trees = await walkTreesRPC(opts.pool, SLOT_NAME, opts.repoPath, opts.lookup, [
      currentTreeSha,
    ]);
    const tree = trees[0];
    if (!tree) return null;
    const entry = tree.entries.find((e) => e.name === part);
    if (!entry) return null;
    if (i === opts.pathParts.length - 1) {
      if (entry.mode === DIR_MODE) return null;
      return { blobSha: entry.sha, mode: entry.mode, size: 0 };
    }
    if (entry.mode !== DIR_MODE) return null;
    currentTreeSha = entry.sha;
  }
  return null;
}

async function resolveCommitTree(opts: {
  commitSha: string;
  repoPath: string;
  lookup: CommitLookup;
  pool: DurableObjectNamespace;
}): Promise<string | null> {
  const commits = await parseCommitsRPC(opts.pool, SLOT_NAME, opts.repoPath, opts.lookup, [
    opts.commitSha,
  ]);
  return commits[0]?.tree ?? null;
}

async function listTreeRecursive(opts: {
  rootTreeSha: string;
  prefix: string[];
  repoPath: string;
  lookup: CommitLookup;
  pool: DurableObjectNamespace;
  maxKeys: number;
}): Promise<Array<{ key: string; size: number; etag: string }>> {
  const out: Array<{ key: string; size: number; etag: string }> = [];

  // Resolve the prefix to its tree.
  let currentSha = opts.rootTreeSha;
  for (const part of opts.prefix) {
    const trees = await walkTreesRPC(opts.pool, SLOT_NAME, opts.repoPath, opts.lookup, [
      currentSha,
    ]);
    const entry = trees[0]?.entries.find((e) => e.name === part);
    if (!entry || entry.mode !== DIR_MODE) return out;
    currentSha = entry.sha;
  }

  // BFS listing under the prefix tree.
  const queue: Array<{ sha: string; path: string[] }> = [{ sha: currentSha, path: opts.prefix }];
  while (queue.length > 0 && out.length < opts.maxKeys) {
    const { sha, path } = queue.shift()!;
    const trees = await walkTreesRPC(opts.pool, SLOT_NAME, opts.repoPath, opts.lookup, [sha]);
    const tree = trees[0];
    if (!tree) continue;
    for (const entry of tree.entries) {
      if (entry.mode === DIR_MODE) {
        queue.push({ sha: entry.sha, path: [...path, entry.name] });
      } else {
        out.push({ key: [...path, entry.name].join("/"), size: 0, etag: entry.sha });
        if (out.length >= opts.maxKeys) break;
      }
    }
  }

  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const artifactsUrl = req.headers.get("x-artifacts-url");
    if (!artifactsUrl) return jsonError("X-Artifacts-Url header required", 400);
    const branch = req.headers.get("x-branch") ?? "main";
    const repoPath = repoPathFromUrl(artifactsUrl);
    const { token } = parseAuth(req);

    const wasm = await WasmEngine.create();
    const lookup: CommitLookup = (sha) => ({ looseKey: `${repoPath}/loose/${sha}` });

    // Resolve current branch sha (or use ?version=).
    const versionParam = url.searchParams.get("version");
    let commitSha: string | null = versionParam;
    if (!commitSha) {
      const adv = await discoverArtifactsRefs({
        artifactsUrl,
        ...(token ? { token } : {}),
      });
      commitSha = adv.refs.get(`refs/heads/${branch}`) ?? null;
    }
    if (commitSha && !/^[0-9a-f]{40}$/.test(commitSha)) {
      return jsonError("invalid version sha", 400);
    }

    // List endpoint: GET /?prefix=…&list-type=2
    if (url.pathname === "/" && req.method === "GET") {
      if (!commitSha) return Response.json({ Name: repoPath, Contents: [], IsTruncated: false });
      await ensureStaged({ artifactsUrl, token, bucket: env.OBJECTS, repoPath, wasm, commitSha });
      const treeSha = await resolveCommitTree({
        commitSha,
        repoPath,
        lookup,
        pool: env.PACK_WORKER,
      });
      if (!treeSha) return jsonError("commit not found", 404);

      const prefix = url.searchParams.get("prefix") ?? "";
      const maxKeys = parseInt(url.searchParams.get("max-keys") ?? "1000", 10);
      const prefixParts = prefix.split("/").filter(Boolean);
      const contents = await listTreeRecursive({
        rootTreeSha: treeSha,
        prefix: prefixParts,
        repoPath,
        lookup,
        pool: env.PACK_WORKER,
        maxKeys,
      });
      return Response.json({
        Name: repoPath,
        Prefix: prefix,
        MaxKeys: maxKeys,
        IsTruncated: contents.length >= maxKeys,
        Contents: contents.map((c) => ({
          Key: c.key,
          Size: c.size,
          ETag: `"${c.etag}"`,
        })),
        Version: commitSha,
      });
    }

    const pathStr = decodeURIComponent(url.pathname.slice(1));
    if (!pathStr) return jsonError("path required", 400);
    const pathParts = pathStr.split("/").filter(Boolean);

    if (req.method === "GET" || req.method === "HEAD") {
      if (!commitSha) return jsonError("repo has no commits on this branch", 404);
      await ensureStaged({ artifactsUrl, token, bucket: env.OBJECTS, repoPath, wasm, commitSha });
      const treeSha = await resolveCommitTree({
        commitSha,
        repoPath,
        lookup,
        pool: env.PACK_WORKER,
      });
      if (!treeSha) return jsonError("commit not found", 404);
      const file = await resolveFile({
        rootTreeSha: treeSha,
        pathParts,
        repoPath,
        lookup,
        pool: env.PACK_WORKER,
      });
      if (!file) return jsonError("file not found", 404);

      const headers = new Headers({
        ETag: `"${file.blobSha}"`,
        "X-Artifacts-Version": commitSha,
        "X-Artifacts-Mode": file.mode,
      });
      if (req.method === "HEAD") return new Response(null, { headers });

      const blobs = await readBlobsRPC(
        env.PACK_WORKER,
        SLOT_NAME,
        repoPath,
        lookup,
        [file.blobSha],
        8 * 1024 * 1024,
      );
      const blob = blobs[0];
      if (!blob) return jsonError("blob not stageable (oversized?)", 500);
      const bytes = new Uint8Array(Buffer.from(blob.contentBase64, "base64"));
      headers.set("Content-Length", String(bytes.length));
      return new Response(bytes, { headers });
    }

    if (req.method === "PUT") {
      const authorName = req.headers.get("x-author-name") ?? "artifacts-as-s3";
      const authorEmail = req.headers.get("x-author-email") ?? "noreply@example.com";
      const message =
        req.headers.get("x-commit-message") ?? `PUT ${pathParts.join("/")}`;
      const body = new Uint8Array(await req.arrayBuffer());

      const result = await commitFileChange({
        artifactsUrl,
        ...(token ? { token } : {}),
        branch,
        pathParts,
        newContent: body,
        authorName,
        authorEmail,
        message,
        bucket: env.OBJECTS,
        repoPath,
        wasm,
      });

      if (!result.pushResult.unpackOk || result.pushResult.refResults.some((r) => !r.ok)) {
        return jsonError(`push failed: ${JSON.stringify(result.pushResult)}`, 502);
      }

      return Response.json(
        {
          ok: true,
          path: pathParts.join("/"),
          version: result.newCommitSha,
          previousVersion: result.oldCommitSha,
        },
        { status: 201, headers: { ETag: `"${result.newCommitSha}"` } },
      );
    }

    if (req.method === "DELETE") {
      const authorName = req.headers.get("x-author-name") ?? "artifacts-as-s3";
      const authorEmail = req.headers.get("x-author-email") ?? "noreply@example.com";
      const message =
        req.headers.get("x-commit-message") ?? `DELETE ${pathParts.join("/")}`;

      const result = await commitFileChange({
        artifactsUrl,
        ...(token ? { token } : {}),
        branch,
        pathParts,
        newContent: null,
        authorName,
        authorEmail,
        message,
        bucket: env.OBJECTS,
        repoPath,
        wasm,
      });

      if (!result.pushResult.unpackOk || result.pushResult.refResults.some((r) => !r.ok)) {
        return jsonError(`push failed: ${JSON.stringify(result.pushResult)}`, 502);
      }

      return Response.json({
        ok: true,
        path: pathParts.join("/"),
        version: result.newCommitSha,
        previousVersion: result.oldCommitSha,
      });
    }

    return new Response("method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<Env>;
