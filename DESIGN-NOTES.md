# gitmode design notes

> **Disclaimer.** Personal open-source project. Not affiliated with, endorsed by, or representative of Cloudflare. Opinions are my own.

> **Status: POC for learning.** This is a proof-of-concept and a learning vehicle, not a product. There is no launch, no roadmap commitment, and no expectation of users adopting it. The "wins" below mean *what was learned*, not *what shipped to whom*.

## Key learnings (the POC deliverable)

Captured in flight. These are the takeaways that justify the time spent.

### Architecture

- **Same problem → same architecture.** Independently arriving at Worker + DO + R2 + Zig WASM (and then watching Cloudflare ship Artifacts with that exact stack) is strong evidence the design space has a clear local optimum. Validates the choice but also explains why parallel solo OSS doesn't make sense.
- **Closed product + open primitives.** Cloudflare's strategy with Artifacts is closed server, OSS client (ArtifactFS). That dictates how an outsider can contribute: build *adjacent* OSS that consumes the public API, not parallel implementations. The toolkit pivot followed naturally from understanding this.
- **Move compute to the data.** PackWorkerDO slots reading directly from R2 and processing locally, returning only results, keeps the coordinator memory flat regardless of repo size. The ~128MB DO memory ceiling becomes the *unit of compute*, not a constraint.

### Concrete technical wins

- **Pre-allocated scratch ABI** (Zig+WASM): allocate the I/O buffer once at WASM init, reuse for every call, no `alloc()` per-operation. `_resetDynamic()` rolls back only dynamic allocations between calls. The `engine.test.ts` heap-stability test proves this works — 50 iterations of `sha1Hex` keep heap growth under 1MB total.
- **Zero-copy WASM views.** `viewBytes(ptr, len)` returns a `Uint8Array` directly into linear memory; consumers either use it immediately (then trigger another op) or copy. Saves the per-call clone of the read buffer.
- **`parse-commits` as a primitive** beats shipping separate `merge-base` / `log-walk` / `blame-walk` actions. Coordinator-side BFS over a single read primitive is cleaner: smaller slot interface, frontier-width fan-out, callers compose any history walk. Both `mergeBase` and `logWalk` shipped as ~120-line files on top.

### Cloudflare Workers surprises

- **`vitest-pool-workers` cross-package .wasm fails by default** when an import chain crosses pnpm-symlinked workspace boundaries. Fix: `test.deps.optimizer.ssr.include: ["@gitmode/wasm-git"]`. Spent significant time discovering this; documenting it here so future-me doesn't.
- **D1 isolates per-test** by default in `vitest-pool-workers`. Tests that POST then GET in separate `it()` blocks fail unexpectedly. Either disable isolation (`isolatedStorage: false`) or make each test self-contained.
- **`r2.put` returns `Promise<R2Object | null>`**, not `Promise<void>`. Storing a list of fire-and-forget puts means `Promise<unknown>[]`.
- **Loose objects vs chunk index** is a major design decision. Chunked R2 objects (~2MB) cut R2 op count 200×; loose objects make test setup easier. The `parse-commits` action supports both via the `looseKey` and `chunkKey + offset + length` discriminator on `ObjectDescriptor`.

### Strategic learnings

- **Hashimoto's "biggest opening since Git"** (the prompt-blame insight) is a real opening. Git tracks who and when; agents need *which prompt*. No incumbent has shipped this. The bet is small enough to prototype solo (one D1 table, one Worker, one CLI) and pairs naturally with local-side capture (`../timeline`).
- **Conflict of interest is a real planning input** for OSS work as a CF employee. Building parallel Git servers would have been awkward; building adjacent toolkit is fine. The pivot was driven as much by COI considerations as by technical comparison.
- **Reframing "win conditions" as "learning targets"** matters. The first draft of this doc had product-shipping language baked in. POC framing wasn't internalized until the user explicitly named it. Future projects: name "POC vs product" in the very first sentence.

## TL;DR

gitmode started as a Git server that runs entirely on Cloudflare Workers (Worker + Durable Objects + R2 + Zig WASM).

In April 2026, Cloudflare shipped [Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) — a managed Git-compatible storage product with the same architecture. The Artifacts *server* is closed-source; only [ArtifactFS](https://github.com/cloudflare/artifact-fs) (the client-side FUSE driver) is open.

This project is pivoting from "self-hosted Git server" to "open-source toolkit that extends Artifacts." We stop maintaining a parallel Git server, keep the differentiated parts (WASM engine, edge compute pool, prompt-blame R&D), and build them as libraries and Workers that integrate with Artifacts via its public APIs.

## Why pivot

| Question | Answer |
|---|---|
| Can we just contribute to Artifacts? | No — the server is closed-source. Only ArtifactFS is OSS. |
| Then why not stay parallel? | Cloudflare will out-resource a solo OSS project on core Git server features. The maintenance surface (clone, push, packfiles, refs, smart HTTP, conformance) is enormous. |
| What's left that Artifacts doesn't do? | Edge compute pool (diff/grep/walk fan-out), prompt-blame primitives, agent-native provenance. These are R&D bets, not core Git. |
| What's the "win" for a POC? | A bet works → write it up as learning notes (or for fun, propose to Artifacts). The point is to *understand* the design space, not to ship a product. |

## What gitmode becomes

**Before:** a Git server hosted on Cloudflare. Users push and clone to a gitmode deployment.

**After:** a set of libraries and Workers that operate *on top of* any Artifacts repo (or any Git remote). Users keep their repos in Artifacts; gitmode adds capabilities Artifacts doesn't ship.

```
gitmode/                                  (kept the original name; toolkit packages live under @gitmode/* scope)
├─ packages/
│  ├─ wasm-git/                           # SHA-1, zlib, delta, packfile (Zig+WASM)
│  ├─ edge-compute-pool/                  # dispatchToPool, batchForPool, pack-worker DO
│  └─ prompt-blame/                       # commit → prompt provenance, D1 schema, blame API
├─ examples/
│  ├─ blame-on-artifacts/                 # uses Artifacts URL, returns prompt-blame
│  ├─ grep-on-artifacts/                  # edge compute pool against Artifacts
│  └─ diff-on-artifacts/                  # edge compute pool against Artifacts
└─ docs/                                  # restructured: "extending Artifacts"
```

## What survives, what dies

### Keep (the differentiated work)

| File | Why |
|---|---|
| `wasm/` (Zig source) | Core asset — SHA-1 SIMD, libdeflate, delta, packfile primitives |
| `src/wasm-engine.ts`, `wasm-engine-core.ts` | Pre-allocated scratch ABI, zero-copy, the perf work |
| `src/wasm-module*.ts` | WASM loader |
| `src/compute-pool.ts` | Fan-out scatter/gather pattern |
| `src/pack-worker.ts` | Edge compute DO (5 actions) |
| `src/diff-engine.ts` | Myers diff |
| `src/hex.ts` | Lookup-table hex encoding |
| `src/pkt-line.ts` | Git protocol primitive (useful when talking to Artifacts) |
| `src/packfile-reader.ts` | Read packs from Artifacts in compute actions |

### Delete (Artifacts owns this)

| File | Replaced by |
|---|---|
| `src/git-engine.ts` | Artifacts repo storage |
| `src/repo-store.ts` | Artifacts repo lifecycle API |
| `src/receive-pack.ts` | Artifacts push handling |
| `src/upload-pack.ts` | Artifacts clone/fetch |
| `src/info-refs.ts` | Artifacts ref discovery |
| `src/handler.ts` | Artifacts request routing |
| `src/server.ts` | n/a |
| `src/ssh-handler.ts` | Defer — keep if SSH demand exists, else delete |
| `src/schema.sql` | Different schema for prompt-blame metadata |

### Refactor (still useful, but different shape)

| File | Direction |
|---|---|
| `src/git-porcelain.ts` | Becomes "porcelain over Artifacts" — talks to Artifacts via Git protocol, not local R2 |
| `src/packfile-builder.ts` | Library only — for examples that build packs to push to Artifacts |
| `src/checkout.ts` | Library only — worktree materialization for compute actions, not as a server feature |
| `src/worker.ts` | Reshape into example Workers in `examples/*` |
| `src/client.ts` | Reshape as `wasm-git` package consumer |

### Tests

Conformance suite (`test/conformance.sh`, `test/stress.sh`) becomes irrelevant — no Git server to conform. Replace with: integration tests against a real Artifacts repo + unit tests on the WASM engine and compute pool.

## R&D bets (the actual reason to keep working on this)

### Bet 1 — Prompt-blame primitives (priority)

**What:** A Worker that captures `commit_metadata` (prompt ID, model, session, agent ID) for each commit, stores in D1. Exposes `GET /blame/:repo/:sha?path=foo.ts` returning lines with prompt provenance.

**Why:** Hashimoto's "biggest opening since Git" point. Git tracks who, not why. As more code is AI-generated, `git blame` becomes meaningless. No incumbent has shipped this. Greenfield.

**Prior art:** `../timeline` is the local-side analog — captures Claude Code edits as snapshots via git notes, parses Claude session files for prompt/session linkage. Hits **git lock file deadlocks** under high-frequency writes (the user's reason for not installing system-wide). This is exactly why a server-side capture path matters — DOs serialize writes, no lock contention.

**Composition with timeline:**
```
Claude Code edit
  ↓ hook
timeline (local snapshot, prompt + session)
  ↓ optional push
gitmode prompt-blame Worker
  ↓
Artifacts repo + D1 sidecar
  ↓ query
GET /blame/:repo/:sha?path=foo.ts → { line, prompt_id, session, model, human_edited: bool }
```

**Learning target:** Build a working demo where (1) Claude Code edits a file, (2) timeline captures it locally, (3) push to a gitmode-extended Artifacts repo writes prompt metadata to D1, (4) `GET /blame` returns "line 17 was generated by prompt X in session Y, edited by human." If it works end-to-end, the design space is understood — that's the POC outcome.

**Open design questions:**
- Where does prompt metadata travel? Options: trailer in the commit message, sidecar push to a separate endpoint, or git notes pushed alongside.
- How do we handle squash/rebase? Per-line prompt mapping survives, but commit-level mapping breaks.
- Do we surface "human-edited" by diffing the commit content against the prompt's original generation?

### Bet 2 — Edge compute pool extensions

**What:** Extend the `pack-worker` DO with more actions: `blame-blobs`, `log-walk`, `merge-base`. All operate on git objects fetched from Artifacts via its smart HTTP remote.

**Why:** Artifacts ships repo storage but no compute primitives. `git log -S "TODO"` on a million-commit repo is slow because it's serial. Fanning out across DO slots is genuinely faster — and gitmode already has the framework.

**Learning target:** Build at least one new pool action and measure whether fan-out beats single-DO serial execution on a representative workload. The numbers are the deliverable.

### Bet 3 — Cross-repo blob dedup (deferred)

**What:** When millions of forks share a baseline, dedup blobs across repos via content-addressed R2 + refcounts.

**Why:** Artifacts will eventually need this (their per-op pricing model fights it without dedup). Worth prototyping; probably not the first bet to chase.

## Non-goals

- **Not a Git server.** Artifacts is the server.
- **Not a GitHub clone.** No Issues, no PRs, no web UI, no Actions.
- **Not API-compatible with Artifacts.** Implementing their Workers binding surface forever is a treadmill.
- **Not a self-hosted alternative for compliance/single-tenant users.** Possible, but out of scope for one person.

## "Why not Artifacts?" — public-facing answer

| Use Artifacts | Use gitmode tools |
|---|---|
| You want managed, pay-per-op git for agents | You want extensions: edge compute, prompt-blame |
| You're starting from scratch | You already use Artifacts and want capabilities it doesn't ship |

These are not alternatives — they compose.

## Migration plan

Executed in phases so each step is reversible.

### Phase 1 — Lock in the strategy
- [x] Write this doc
- [x] Sign-off received
- [x] Add disclaimer banner to README
- [x] Add separate `DISCLAIMER.md`

### Phase 2 — Prototype prompt-blame (Bet 1)
- [x] Design `commit_metadata` schema in D1 (`packages/prompt-blame/schema.sql`, `migrations/0001_init.sql`)
- [x] Build minimal Worker with `POST /metadata` and `GET /metadata` (`packages/prompt-blame/src/index.ts`)
- [x] Tests passing (16/16) via `vitest-pool-workers` with D1 binding
- [x] CLI client `bin/prompt-blame.mjs` with `post` / `get` / `hook` subcommands; URL normalization handles ssh/https/insteadOf rewrites
- [x] timeline bridge in `examples/timeline-bridge/` (reads `refs/notes/timeline-metadata`, posts to Worker)
- [x] Claude Code hook docs in `examples/claude-code-hook/` (manual settings.json install)
- [x] End-to-end demo verified locally — `wrangler dev` + CLI POST/GET round-trip + hook subcommand reading mock Claude Code stdin

> Endpoint shape: `POST /metadata` body `{ repo_id, commit_sha, ... }`, `GET /metadata?repo=<url>&sha=<sha>`. Chose query params over path segments because `repo_id` is a full URL (would need base64 encoding in a path).
>
> URL normalization: SSH form (`git@host:path.git`), HTTPS form, with/without `.git` suffix, with/without auth tokens — all collapse to a canonical lowercase HTTPS URL with `.git` suffix before storage. `git config --get remote.origin.url` is preferred over `git remote get-url` to bypass `insteadOf` rewrites.

### Phase 3 — Extract reusable libraries
- [x] Set up `packages/` workspace (pnpm workspace) — `pnpm-workspace.yaml`
- [x] Copy WASM engine into `packages/wasm-git/` (17 tests passing — 7 smoke + 10 engine integration). `WasmEngine.create()` exercised end-to-end with SHA-1 fixtures (empty, "hello", 1MB), git-compatible blob hash for "hello\n" matches `git hash-object`, zlib deflate/inflate round-trips on small/repeated/incompressible data, heap doesn't grow unboundedly across 50 iterations (proves scratch ABI works). `WasmEngineCore` still requires a fresh `gitmode-core.wasm` rebuild — see package README.
- [x] Copy compute pool + pack-worker into `packages/edge-compute-pool/` (15 smoke tests passing; depends on `@gitmode/wasm-git` via `workspace:*`)
- [x] `packages/prompt-blame/` for Bet 1 code (already complete from Phase 2)
- [x] Parent `vitest.config.ts` excludes `packages/**` so each package owns its bindings

> **Approach:** copied (not moved) the source files. Existing `src/*` keeps working until Phase 5 deletes it. Cross-package WASM imports under `vitest-pool-workers` need careful handling — smoke tests bypass the index re-exports for modules that don't actually need WASM.
>
> **Latent bug surfaced:** `WasmEngineCore.create()` was missing WASI `args_get` / `args_sizes_get` shims (added in the package copy, parent has the same gap). The committed `gitmode-core.wasm` also predates the `heapSave`/`heapRestore` exports added in commit `10f17f7`. Rebuilding requires Zig 0.15.2 which currently fails to link against macOS Tahoe SDK — fix deferred to Phase 4 or 5.

### Phase 4 — Edge compute pool extensions (Bet 2)
- [x] New pool action: `parse-commits` — read commit objects from R2, return structured `CommitInfo[]`. The primitive that powers `merge-base`, `log-walk`, and `blame-walk` from coordinator-side BFS.
- [x] Extracted `commit-parse.ts` from the legacy `git-porcelain.ts` parser. 9 unit tests covering root commit, single parent, merge commit, separate author/committer, malformed body, multi-line summary.
- [x] **Integration tests for `parse-commits`** — 8 tests exercising DO + R2 + WASM zlib end-to-end. Uses `node:zlib` (`nodejs_compat`) to pre-encode commit objects, writes them to R2, dispatches via `env.PACK_WORKER`. Resolved the cross-package WASM import limitation by adding `test.deps.optimizer.ssr.include: ["@gitmode/wasm-git"]` to vitest config.
- [x] **`mergeBase` coordinator** — `src/coordinators/merge-base.ts`. Alternating BFS from two seeds, dispatching one `parse-commits` RPC per level per side (parallel). 6 integration tests covering equal SHAs, ancestor relationship, siblings, deep LCA, disjoint histories, depth cap. Demonstrates the toolkit composition pattern.
- [x] **`logWalk` coordinator** — `src/coordinators/log-walk.ts`. BFS from seeds with arbitrary filter predicate. 6 integration tests covering all reachable, empty seeds, limit, author filter, message regex (`git log -S` equivalent), depth cap.
- [x] **`read-blobs` action** — pure read primitive that decompresses blob objects and returns base64 content + size, with a `maxBlobBytes` cap (default 1MB, hard 8MB). Validates type (rejects non-blobs), enforces cross-repo isolation. 9 integration tests covering text, binary (full byte range), batched calls, oversized rejection, oversized acceptance with raised cap, type validation, missing objects, key scope, missing repoPath. Unblocks future blame/inspection coordinators that need raw blob content.
- [x] **`blameWalk` coordinator** — `src/coordinators/blame-walk.ts`. Per-line attribution via first-parent history walk. For each ancestor: resolve path via recursive `walk-trees`, read blob via `read-blobs`, compare line set, push attribution back when line is still present. Final attribution = oldest commit where the line still appears (i.e., the commit that introduced or last reintroduced the line). 7 tests covering linear history attribution, root-only commit, partial-history walk, missing file, deep nested paths (`a/b/c/foo.txt`), maxDepth cap, invalid path. POC quality limitations documented: string-set line tracking (wrong for duplicate lines), no rename/copy detection, first-parent merge attribution.
- [x] **Refactored RPC dispatch** into `src/coordinators/pool-rpc.ts` — `parseCommitsRPC`, `walkTreesRPC`, `readBlobsRPC`. mergeBase and logWalk both refactored to use it; eliminates ~50 lines of duplicated dispatch boilerplate. Each coordinator file is now just the algorithm.

### Artifacts integration (closes the "but does it actually work with Artifacts?" gap)

Earlier rounds left the toolkit *positioned* to extend Artifacts but with no actual integration. Honestly assessed: the toolkit "worked well with Artifacts" only in the sense that the architecture was compatible. There was no Artifacts client, no object-staging path, no end-to-end test against an Artifacts-shaped server. This round closes that gap.

- [x] **`pkt-line.ts`** — Git's framing protocol (length-prefixed packets, flush/delim markers, sideband demultiplexing). 12 tests.
- [x] **`packfile-reader.ts`** — Pack v2 parser. Verifies SHA-1 trailer; parses type+size headers; uses `WasmEngine.zlibInflateTracked` and `deltaApply` for the heavy work; resolves both ref-delta and ofs-delta. Decoupled from any storage layer — exposes `onObject` callback for streaming or returns the unpacked map. 7 tests including a synthetic pack-builder fixture and corruption-detection.
- [x] **`smart-http.ts`** — Git smart HTTP v1 client. `discoverRefs` (GET `/info/refs?service=git-upload-pack`, parse first-line capabilities + ref advertisement). `fetchPack` (POST `/git-upload-pack` with want/done pkt-lines, sideband-64k response demux). 9 tests with hand-crafted pkt-line responses and Authorization header verification.
- [x] **`fetchArtifactsCommit` coordinator** — Orchestrates fetch → unpack → re-deflate → write-to-R2. Each unpacked object is recompressed as a standard loose git object (`zlib(<type> <size>\0<content>)`) and written at `${repoPath}/loose/${sha}` — exactly the layout the existing pool actions read from. 4 integration tests including the killer one: an in-memory Artifacts-shaped server is stood up, a commit closure is fetched + staged, and then the existing `parse-commits` and `read-blobs` actions are dispatched against the staged objects, returning the same shape they would for any other R2-backed repo.

The end-to-end test is the actual proof. Without it, "works with Artifacts" was wishful thinking. With it, the only thing standing between this toolkit and a real Artifacts beta repo is a beta access token.
- [ ] Higher-level coordinator example: `merge-base` via BFS over `parse-commits`
- [ ] `examples/grep-on-artifacts` — fan out grep across an Artifacts repo (deferred — needs Git smart HTTP client for fetching objects without staging in R2)
- [ ] `examples/diff-on-artifacts` — same dependency, deferred
- [ ] `blame-walk` action — coordinator-side BFS atop `parse-commits` + tree walks (deferred; complex line-tracking semantics)

> **Design call:** rather than adding `merge-base`, `log-walk`, `blame-walk` as standalone actions, expose `parse-commits` as the single primitive. Coordinator-side BFS keeps the slot interface narrow and lets callers compose any history-walk operation. Pool-size scales with BFS frontier width, not action type.

### Phase 5 — Kill the git server (done)
- [x] Deleted `src/` entirely — git-engine, repo-store, receive-pack, upload-pack, info-refs, handler, server, ssh-handler, git-porcelain, checkout, packfile-builder, packfile-reader, pkt-line, env, client, index, worker, schema.sql, plus the duplicates of wasm-engine/compute-pool/diff-engine/pack-worker that were copied into `packages/`
- [x] Deleted `app/` (React UI), `worker/` (server entry), `ssh/` (proxy), `scripts/setup.sh`, `bin/gitmode.mjs` (server CLI)
- [x] Deleted `test/` — conformance, stress, bench, ssh-conformance scripts plus `gitmode.test.ts` (93 tests)
- [x] Deleted root `wrangler.jsonc`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `dist/`, `wrangler.toml.bak`, stray `test_simd_wasi.wasm`
- [x] Rewrote root `package.json` as workspace root only — `gitmode` workspace root, no main/bin/exports, no React/vite/vinext deps; only WASM build scripts and meta `test`/`typecheck` recursive runners
- [x] Rewrote `README.md` for the post-pivot state — describes the three packages, removes the old "git server on Workers" framing
- [x] All package tests pass (`prompt-blame` 16, `wasm-git` 7, `edge-compute-pool` 24 = **47 total**)
- [x] Workspace typecheck clean across all 3 packages

### Phase 6 — Repackage (revised for POC framing)
- [x] Repo rename — **decided against**, keeping `gitmode`. The toolkit packages live under the `@gitmode/*` scope so the brand carries through.
- [x] ~~Publish npm packages~~ — dropped. POC, not a published product. Packages stay `private: true`.
- [x] ~~Launch blog post~~ — dropped. There is no launch.
- [x] Docs site (`docs/`) — left in place as legacy artifact. The Astro Starlight content describes the original git server and is now stale. Not deleted because (a) deleting is reversible from git history if regretted, and (b) some perf numbers and architecture diagrams are useful learning notes. A banner could be added later if the docs site is ever served, but for a POC the package READMEs + DESIGN-NOTES are sufficient.

## Locked-in decisions

| Question | Decision |
|---|---|
| Project framing | POC for learning, not a product (confirmed 2026-04-29) |
| Repo rename | No — keep `gitmode` (revisited 2026-04-29) |
| Disclaimer placement | Both README banner + `DISCLAIMER.md` |
| Bet ordering | Prompt-blame first |
| Self-hosted git mode | Kill cleanly, no final release |
| npm publishing | No — packages stay `private: true` |
| Launch blog post | No — there is no launch |
| Timeline | No fixed deadline; phases gated on quality |

### Repo name — kept as `gitmode`

Earlier-considered renames (`prompt-blame`, `git-edge-tools`, `artifacts-tools`, `gitlens-edge`, `provenance`) were dropped in favor of keeping the existing `gitmode` brand. The toolkit packages live under the `@gitmode/*` npm scope so the project identity carries through:

- `@gitmode/prompt-blame`
- `@gitmode/edge-compute-pool`
- `@gitmode/wasm-git`

Tradeoff accepted: the name doesn't telegraph the pivot to "Artifacts toolkit," but the README banner + DESIGN-NOTES make the positioning clear, and brand continuity is worth more than rename churn.
