# `@gitmode/edge-compute-pool`

Fan-out compute primitives for git operations on Cloudflare Workers. Treats the network as a distributed compute cluster — each Durable Object slot is a ~128MB compute unit with WASM, R2 access, and serialized writes. The coordinator dispatches work via RPC; slots read from R2 and process locally, returning only results.

> **Status:** prototype. Extracted from `gitmode` as part of the toolkit pivot. APIs may change.

## Public surface

```ts
import {
  PackWorkerDO,           // the slot class — bind it as a Durable Object
  type PackWorkerEnv,     // minimal env shape: { OBJECTS: R2Bucket }
  dispatchToPool,         // scatter/gather across slots, fail-fast aggregation
  batchForPool,           // split a workload into per-slot tasks
  type PoolConfig,
  // Helpers for callers building their own actions:
  unifiedDiff, isBinary,
  OBJ_BLOB, OBJ_TREE, OBJ_COMMIT, OBJ_TAG,
  objectToPackType, writeTypeSizeHeader, typeSizeHeaderLen, writeUint32BE,
} from "@gitmode/edge-compute-pool";
```

## Wiring it up

```jsonc
// wrangler.jsonc
{
  "main": "src/worker.ts",
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

export default {
  async fetch(req, env) {
    /* coordinator logic that calls dispatchToPool */
  },
};
```

## Built-in actions

`PackWorkerDO` ships seven RPC actions:

| Action | Reads | Computes | Returns |
|---|---|---|---|
| `build-segment` | git objects from R2 | decompress, re-compress for packfile | packfile segment bytes |
| `write-worktree` | blobs from R2 | decompress | writes raw content to R2 worktree paths |
| `diff-blobs` | blob pairs from R2 | unified diff (Myers) | patches |
| `grep-blobs` | blobs from R2 | regex search with context | matches |
| `walk-trees` | tree objects from R2 | parse entries | child SHAs |
| `parse-commits` | commit objects from R2 | decompress, parse header + summary | structured `CommitInfo[]` |
| `read-blobs` | blob objects from R2 | decompress, validate type | base64 content + size, capped at `maxBlobBytes` (default 1MB, hard max 8MB) |

Each action validates that all R2 keys start with `repoPath/` (cross-repo isolation) and caps batches at 1000 objects (OOM defense).

### Building higher-level operations on `parse-commits`

The action returns `{ sha, tree, parents, author, authorTimestamp, committer, committerTimestamp, summary, message }` per commit. A coordinator can compose this into:

- **`mergeBase`** — alternating BFS from two seeds; in `src/coordinators/merge-base.ts`.
- **`logWalk`** — BFS from seeds with arbitrary filter predicate (author, message regex, date, etc.); in `src/coordinators/log-walk.ts`.
- **`blameWalk`** — first-parent walk of a path's history with per-line attribution; in `src/coordinators/blame-walk.ts`. POC quality (string-set line tracking, no rename/copy detection).

All three share `src/coordinators/pool-rpc.ts` for the dispatch boilerplate so each coordinator is just the algorithm, not the plumbing.

The coordinator owns the BFS loop; each level does one `parse-commits` RPC against a slot. Pool size scales with the BFS frontier width.

```ts
import { mergeBase, logWalk, blameWalk } from "@gitmode/edge-compute-pool";

const base = await mergeBase({
  shaA: "...", shaB: "...",
  repoPath: "my-repo",
  lookup: (sha) => ({ looseKey: `my-repo/loose/${sha}` }),
  pool: env.PACK_WORKER,
});

const todos = await logWalk({
  seeds: [headSha],
  repoPath: "my-repo",
  lookup,
  pool: env.PACK_WORKER,
  filter: (c) => /TODO/.test(c.message),
  limit: 50,
});

const blame = await blameWalk({
  startSha: headSha,
  filePath: "src/foo.ts",
  repoPath: "my-repo",
  lookup,
  pool: env.PACK_WORKER,
});
// → [{ lineNumber: 1, line: "...", commit: "abc..." }, ...]
```

## Pool sizing

Slots scale with batch count, capped by `POOL_MAX_SLOTS` (default 20, hard ceiling 100):

- 3 batches → 3 slots, no waste
- 50 batches with cap=20 → 20 slots, round-robin wraps so 2-3 batches share each slot

Tune via env var or `PoolConfig.maxSlots`. The cap exists because each slot is a fresh DO RPC and warmup is non-zero.

## Why fan-out

`grep` of "TODO" across 10K blobs serialized in one DO takes ~30s. Fanning across 20 slots takes ~2s. The wins are biggest for embarrassingly parallel ops (diff, grep, walk) and packfile assembly where each segment is independent.

Below the threshold (200 objects for packfile, 10 for diff, 50 for grep) the local path is faster — you skip the RPC overhead.

## Artifacts integration (read + write)

Beyond the slot/coordinator surface, this package ships **end-to-end read AND write** paths for [Cloudflare Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) (or any Git smart-HTTP server):

| Primitive | Direction | Purpose |
|---|---|---|
| `fetchArtifactsCommit` | read | pull a commit's transitive closure into R2 |
| `commitFileChange` | write | mutate one path, build commit, push back |
| `applyTreeChange` | helper | build the new tree(s) for a single-path change |
| `buildPackfile` / `buildCommitBytes` | helpers | produce raw git objects |
| `pushPack` | wire | POST `git-receive-pack` with a packfile + ref updates |
| `discoverArtifactsRefs` | wire | resolve branches/tags via smart-HTTP v1 or v2 |

Read example:

```ts
import { fetchArtifactsCommit, discoverArtifactsRefs } from "@gitmode/edge-compute-pool";
import { WasmEngine } from "@gitmode/wasm-git";

const wasm = await WasmEngine.create();

// Resolve a branch to its tip SHA
const adv = await discoverArtifactsRefs({
  artifactsUrl: "https://x.artifacts.cloudflare.net/git/repo-1.git",
  token: env.ARTIFACTS_TOKEN,
});
const headSha = adv.refs.get("refs/heads/main")!;

// Fetch the commit + transitive closure into R2 in the layout the pool actions expect
await fetchArtifactsCommit({
  artifactsUrl: "https://x.artifacts.cloudflare.net/git/repo-1.git",
  token: env.ARTIFACTS_TOKEN,
  commitSha: headSha,
  repoPath: "my-repo",
  bucket: env.OBJECTS,
  wasm,
});

// Now the pool actions work — same as if you'd pushed objects yourself
await blameWalk({ startSha: headSha, filePath: "src/foo.ts", repoPath: "my-repo", lookup, pool: env.PACK_WORKER });
```

Write example:

```ts
import { commitFileChange } from "@gitmode/edge-compute-pool";

const result = await commitFileChange({
  artifactsUrl: "https://x.artifacts.cloudflare.net/git/repo-1.git",
  token: env.ARTIFACTS_TOKEN,
  branch: "main",
  pathParts: ["src", "config.json"],
  newContent: new TextEncoder().encode(JSON.stringify({ updated: true })),
  authorName: "Tester",
  authorEmail: "tester@example.com",
  message: "update config",
  bucket: env.OBJECTS,
  repoPath: "repo-1",
  wasm,
});
// result.newCommitSha → the commit we just pushed
// result.pushResult.unpackOk → true if the server accepted the pack
```

Implementation pieces (all in `src/protocol/`):

| File | Purpose |
|---|---|
| `pkt-line.ts` | Length-prefixed framing + flush/delim markers + sideband channel demux |
| `smart-http.ts` | `discoverRefs` (v1+v2 auto-negotiation), `fetchPack` (v1 want/done or v2 command=fetch), `pushPack` (v1 receive-pack with status report) |
| `packfile-reader.ts` | Pack v2 parser: SHA-1 trailer verification, type+size headers, zlib inflate via WasmEngine, ref-delta + ofs-delta resolution |
| `packfile-writer.ts` | Inverse — serializes (type, content) tuples into a v2 pack with SHA-1 trailer |
| `tree-bytes.ts` | Pure encode/parse of git tree objects + add/remove entry primitives |
| `commit-bytes.ts` | Pure builder for git commit object bodies |

Integration tests:

- `test/artifacts-fetch.integration.test.ts` — read flow (in-memory Artifacts server → fetch closure → staged objects readable by pool actions).
- `test/commit-file-change.integration.test.ts` — write flow (in-memory Artifacts server → push pack → server unpacks and validates objects, ref state updates).

No real Artifacts access required for either.

## Limitations

- Unpack is **not** fan-out-able — delta chains require ordering within a packfile.
- One coordinator can saturate ~20 slots; beyond that you're better off sharding work across multiple coordinators.
- The package depends on `@gitmode/wasm-git` for SHA-1, zlib, delta, packfile primitives. Cross-package WASM imports under `vitest-pool-workers` require `test.deps.optimizer.ssr.include: ["@gitmode/wasm-git"]` in the consumer's `vitest.config.ts` (already wired up in this package's own tests).
- Smart-HTTP client supports both Git protocol v1 and v2 (`Git-Protocol: version=2`). `discoverRefs` auto-negotiates: it sends the v2 header by default, follows up with a v2 ls-refs POST when the server advertises `version 2`, and falls back to v1 parsing otherwise. `fetchPack` defaults to v1 (works with all servers) but accepts `protocolVersion: "v2"` to use v2 fetch instead.

## Status / extraction

Extracted from `src/{compute-pool,pack-worker,diff-engine}.ts`. Helper functions previously imported from `git-engine.ts` and `packfile-builder.ts` (object type constants, packfile entry encoding) are inlined into [`src/pack-format.ts`](./src/pack-format.ts) so this package has no dependency on the rest of the legacy `gitmode` orchestration code.
