# `artifacts-as-s3`

Worker that exposes a Cloudflare Artifacts repo as an **S3-style HTTP API** with versioning for free. Drop-in for clients that speak S3 idioms (`curl`, `rclone`, AWS SDKs, presigned-URL workflows).

## API

```
GET    /<path>               → bytes at HEAD
GET    /<path>?version=<sha> → bytes at a specific commit (time-travel)
HEAD   /<path>               → metadata + ETag
PUT    /<path>               → write; body = file bytes; new commit
DELETE /<path>               → delete; new commit
GET    /?prefix=…&max-keys=N → list (JSON, S3 ListObjectsV2 shape)
```

## Required headers

| Header | Purpose |
|---|---|
| `X-Artifacts-Url` | Base repo URL — `https://x.artifacts.cloudflare.net/git/<repo>.git` |
| `Authorization` | `Bearer <token>` or `Basic <base64>` — Artifacts repo token |
| `X-Branch` | Branch to read/write. Default `main`. |
| `X-Author-Name` / `X-Author-Email` | Commit identity (PUT / DELETE). Default `artifacts-as-s3 <noreply@example.com>`. |
| `X-Commit-Message` | Override default `"PUT <path>"` / `"DELETE <path>"`. |

## Versioning

Every PUT or DELETE creates a real git commit. The response carries the new commit SHA in `ETag` and the `version` field. Earlier versions are reachable via `?version=<sha>`:

```bash
# Write a file
curl -X PUT https://your-worker.workers.dev/notes/today.md \
  -H "X-Artifacts-Url: https://x.artifacts.cloudflare.net/git/team.git" \
  -H "Authorization: Bearer $TOKEN" \
  -d "today's notes"
# → { "ok": true, "version": "abc123…" }

# Update it
curl -X PUT https://your-worker.workers.dev/notes/today.md \
  -H "X-Artifacts-Url: …" -H "Authorization: …" \
  -d "today's notes (revised)"
# → { "ok": true, "version": "def456…", "previousVersion": "abc123…" }

# Read the previous version
curl https://your-worker.workers.dev/notes/today.md?version=abc123…
# → "today's notes"
```

That's the differentiator over plain R2: **time-travel + consistent snapshots across the whole repo**, without writing custom version-tracking logic.

## What's not S3-compatible

- The wire format is JSON, not S3's XML. Easy to add an `Accept: application/xml` translator if you need real AWS SDK compatibility.
- No multipart upload — git's pack format already handles arbitrary-size objects, but the example caps blob size at 8MB per request.
- No presigned URLs (yet) — would need an HMAC-signed query parameter scheme.
- No bucket-level ACLs — Artifacts tokens are repo-scoped, not path-scoped.

## How it composes

```
PUT /<path>
  ↓
commitFileChange({
  artifactsUrl, token, branch, pathParts, newContent,
  authorName, authorEmail, message, bucket, repoPath, wasm
})
  ├── discoverArtifactsRefs          → current branch tip
  ├── fetchArtifactsCommit(branchSha) → stage closure in R2
  ├── applyTreeChange                → new blob + new trees
  ├── buildCommitBytes               → new commit object
  ├── buildPackfile                  → pack with all new objects
  └── pushPack                       → POST /git-receive-pack
```

```
GET /<path>?version=<sha>
  ↓
fetchArtifactsCommit(sha) → ensureStaged
  ↓
parse-commits action     → resolves commit's root tree
  ↓
walk-trees action(s)     → resolves path through nested trees
  ↓
read-blobs action        → returns base64 content
  ↓
HTTP response
```

## Status

Compiled as part of `pnpm typecheck`. Not deployed by default. To deploy:

```jsonc
// wrangler.jsonc
{
  "main": "examples/artifacts-as-s3/worker.ts",
  "compatibility_flags": ["nodejs_compat"],
  "rules": [{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": false }],
  "durable_objects": {
    "bindings": [{ "name": "PACK_WORKER", "class_name": "PackWorkerDO" }]
  },
  "migrations": [{ "tag": "v1", "new_classes": ["PackWorkerDO"] }],
  "r2_buckets": [{ "binding": "OBJECTS", "bucket_name": "your-objects" }]
}
```

```ts
// src/worker.ts
export { PackWorkerDO } from "@gitmode/edge-compute-pool";
export { default } from "../examples/artifacts-as-s3/worker";
```
