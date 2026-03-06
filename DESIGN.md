# gitmode — Design Document

## Vision

A serverless git hosting platform running entirely on Cloudflare Workers.
Users deploy their own instance with one click. Full git protocol support
(clone, push, pull) plus a web UI for browsing repos, viewing commits,
and reading code — all powered by a Zig WASM engine with SIMD128.

## What gitmode IS

A **git hosting tool** that makes git hosting possible on Cloudflare.
Not just a bare object store — on every push, the server materializes
files into a real worktree on R2, making them instantly browseable,
edge-cached, and accessible to CI/CD pipelines.

## What gitmode is NOT

- Not a git client (users use standard `git` CLI)
- Not a framework (it's a deployable product)
- Not GitHub (no social features — PRs, issues, discussions are out of scope)

---

## Architecture

```
git client (standard git CLI)
       |
       | HTTPS (git smart HTTP protocol)
       v
+----------------------------------------------------------+
|  Cloudflare Worker (TypeScript)                          |
|  +-----------+  +-------------+  +------------------+   |
|  | info-refs |  | upload-pack |  | receive-pack     |   |
|  | (GET)     |  | (clone/     |  | (push)           |   |
|  |           |  |  fetch)     |  |  + worktree sync  |   |
|  +-----------+  +-------------+  +------------------+   |
|       |              |                   |               |
|       v              v                   v               |
|  +------------------------------------------------+     |
|  |  Zig WASM Engine (791KB, SIMD128)              |     |
|  |  - SHA-1 hashing        - Delta compression    |     |
|  |  - Packfile encode/decode  - Zlib inflate       |     |
|  |  - Object serialization - Tree walking          |     |
|  |  - Server-side checkout (tree -> R2 files)      |     |
|  +------------------------------------------------+     |
|       |              |                   |               |
+----------------------------------------------------------+
        |                                  |
   +----+----+                    +--------+--------+
   |   R2    |                    | Durable Objects  |
   | objects |                    | (per-repo SQLite)|
   | + work- |                    | - refs           |
   |   trees |                    | - commits index  |
   +---------+                    | - repo metadata  |
                                  | - file size cache|
                                  +-----------------+

+----------------------------------------------------------+
|  vinext UI (React Server Components)                     |
|  - Reads files directly from R2 worktree (no git ops)    |
|  - Reads commit log from DO SQLite                       |
|  - Reads refs from DO SQLite                             |
|  - Same Worker, same bindings, zero API hops             |
+----------------------------------------------------------+
```

---

## Storage Layout

### R2 (Objects + Worktree)

```
{owner}/{repo}/objects/{sha1[0:2]}/{sha1[2:]}   -- zlib-compressed git objects
{owner}/{repo}/worktrees/{branch}/{filepath}     -- materialized files (real content)
```

Objects are the git database. Worktrees are materialized on push —
real files that the UI reads directly without decompression.

### DO SQLite (Refs + Metadata)

Each repo gets its own Durable Object with an embedded SQLite database.

Tables:
- `refs` — name, sha (branches, tags, HEAD)
- `repo_meta` — owner, name, description, visibility, default_branch
- `commits` — sha, author_name, author_email, message, timestamp (indexed for search)
- `file_sizes` — sha, size (blob size cache for stats endpoint)
- `permissions` — username, role (read/write/admin)

---

## Zig WASM Engine

### Modules

| Module | Purpose | SIMD |
|--------|---------|------|
| `sha1.zig` | SHA-1 hashing for object IDs | Message schedule expansion |
| `object.zig` | Parse/serialize blob, tree, commit, tag | - |
| `pack.zig` | Packfile v2 encode/decode | - |
| `delta.zig` | Delta compression with index matching | SIMD memcmp for copy regions |
| `zlib.zig` | Inflate (flate) + deflate (stored blocks) | - |
| `protocol.zig` | pkt-line framing | - |
| `simd.zig` | memchr, memeql, memcount | Full SIMD128 |
| `r2_backend.zig` | R2 key formatting for objects + worktrees | - |
| `checkout.zig` | Tree walk -> materialize files to R2 | - |
| `libgit2.zig` | libgit2 bindings (diff, blame, revwalk) | - |

### Host Imports

The WASM module imports these functions from the TypeScript host:

```
env.r2_get(key_ptr, key_len, buf_ptr, buf_cap) -> i32  (bytes read or -1)
env.r2_put(key_ptr, key_len, data_ptr, data_len) -> i32  (0 or -1)
env.r2_head(key_ptr, key_len) -> i32  (size or -1)
env.log_msg(ptr, len) -> void
```

### Build

```
Target: wasm32-freestanding + SIMD128
Optimize: ReleaseSmall (791KB binary)
Build: zig build wasm
Tests: zig build test (native target)
```

---

## TypeScript Worker Layer

### Request Routing

```
GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack    -> info-refs.ts
GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   -> info-refs.ts
POST /{owner}/{repo}.git/git-upload-pack                      -> upload-pack.ts
POST /{owner}/{repo}.git/git-receive-pack                     -> receive-pack.ts (via DO)
/*   (everything else)                                        -> vinext UI
```

### Push Flow

1. Client sends ref update commands + packfile
2. Worker routes to RepoStore DO (one per repo, strongly consistent)
3. DO calls receive-pack handler
4. Zig WASM parses packfile, extracts objects
5. Phase 1: Objects prepared in CPU (hash + zlib compress) — no I/O
6. Phase 2: Objects batch-written to R2 (50 concurrent PUTs)
7. Refs updated in DO SQLite
8. Commits indexed in DO SQLite (author, message, timestamp)
9. Worktree materialization:
   - Incremental: diffs old tree vs new tree, writes only changed/added files
   - Optimistic: uses in-memory objects from packfile unpack (no R2 re-reads)
   - Full: only on first push or when old commit is unavailable
10. File sizes cached in DO SQLite for stats endpoint
11. Report-status returned to client

### Clone/Fetch Flow

1. Client sends want/have negotiation
2. Worker calls upload-pack handler
3. Object graph walked from wanted refs (stops at client's haves)
4. Objects fetched from R2
5. Zig WASM assembles packfile (zlib + delta compression)
6. Packfile streamed to client

---

## Performance Optimizations

### Implemented

| Optimization | Impact | How |
|---|---|---|
| **Batch R2 writes** | Push 19x faster (972ms -> 52ms for 500 files) | `prepareObject()` (CPU-only) then `putObjects()` (50 concurrent PUTs) |
| **Incremental worktree** | Incremental push 69x faster (827ms -> 12ms) | Diff old/new trees, only write changed files |
| **Optimistic object cache** | Eliminates all R2 reads during worktree materialization | In-memory map from packfile unpack passed to checkout |
| **SQLite file size cache** | Stats 2.5x faster (167ms -> 68ms) | `file_sizes` table stores blob SHA -> size |

### Future Considerations

| Optimization | Expected Impact |
|---|---|
| Pack storage (store packfiles as-is in R2) | Faster push, native clone |
| SIMD-accelerated delta encoding | Faster clone/fetch for large repos |
| DO alarm-based debounce | Coalesce rapid pushes into one worktree update |

---

## vinext UI

### Technology

- vinext (Vite + React RSC) deployed on the same Cloudflare Worker
- Server Components read directly from R2/DO SQLite bindings (zero API hops)
- Client Components for interactive elements (active tabs, search)

### Pages

| Route | Description | Data Source |
|-------|-------------|-------------|
| `/` | Landing page / repo list | DO SQLite: repos |
| `/{owner}` | User's repos | DO SQLite: repos filtered by owner |
| `/{owner}/{repo}` | Repo overview (README + file tree) | R2 worktree + DO SQLite refs |
| `/{owner}/{repo}/tree/{branch}/[...path]` | File/directory browser | R2 worktree |
| `/{owner}/{repo}/blob/{branch}/[...path]` | File viewer with syntax highlight | R2 worktree |
| `/{owner}/{repo}/commits/{branch}` | Commit history | DO SQLite: commits table |
| `/{owner}/{repo}/commit/{sha}` | Single commit diff + changed files | R2: objects + libgit2 diff |
| `/{owner}/{repo}/branches` | Branch list | DO SQLite: refs |
| `/{owner}/{repo}/tags` | Tag list | DO SQLite: refs |
| `/{owner}/{repo}/settings` | Repo settings | DO SQLite: repo_meta + permissions |

### Layout Hierarchy

```
app/
  layout.tsx              -- root layout (html, head, body)
  page.tsx                -- landing / repo discovery
  [owner]/
    page.tsx              -- user profile / repo list
    [repo]/
      layout.tsx          -- repo header (name, branches, tabs)
      tab-link.tsx        -- client component (active tab indicator)
      page.tsx            -- repo overview (README + tree)
      tree/
        [...path]/
          page.tsx        -- directory listing
      blob/
        [...path]/
          page.tsx        -- file viewer
      commits/
        [branch]/
          page.tsx        -- commit log
      commit/
        [sha]/
          page.tsx        -- commit detail + diff
      branches/
        page.tsx          -- branch list
      tags/
        page.tsx          -- tag list
      settings/
        page.tsx          -- repo config
```

---

## libgit2 Integration

### Purpose

Server-side git operations that go beyond protocol handling:
- `git_diff()` — compute diffs for commit view (working)
- `git_blame()` — blame annotations in file viewer (ODB callbacks need wiring)
- `git_merge()` — three-way merge for branches (working)
- `git_revwalk()` — commit history traversal (working)

### Approach

1. libgit2 C source (deps/libgit2/) compiled to WASM via `zig cc`
2. Custom `git_odb_backend` vtable pointing to R2 host imports
3. Custom `git_refdb_backend` vtable pointing to DO SQLite host imports
4. POSIX shims for filesystem calls
5. Ships zlib, pcre, SHA1, xdiff — zero external deps

---

## SSH Support

SSH proxy translates SSH git commands to HTTP protocol:
- SSH connection received by proxy
- Git command parsed (git-upload-pack / git-receive-pack)
- Proxied to Worker HTTP endpoint
- Sideband passthrough for progress messages

---

## Deployment

### One-Click Deploy

Deploy button in README triggers:
1. Fork repo to user's GitHub
2. GitHub Actions workflow runs
3. Creates R2 bucket + Durable Object bindings
4. Builds Zig WASM
5. Deploys Worker via Wrangler

### Manual Deploy

```bash
git clone <repo>
cd gitmode
./scripts/setup.sh   # provisions resources + deploys
```

---

## Development Phases

### Phase 1 — MVP (complete)
- [x] Zig WASM engine (SHA-1, packfile, delta, zlib, protocol)
- [x] Git smart HTTP (info-refs, upload-pack, receive-pack)
- [x] R2 object storage + DO SQLite (refs, metadata)
- [x] Server-side checkout (worktree materialization)
- [x] Deploy button + GitHub Actions
- [x] vinext UI (10 pages: repo browser, commit history, file viewer, etc.)
- [x] REST API (35+ endpoints: CRUD, merge, cherry-pick, diff, log, stats)
- [x] SSH transport
- [x] Performance optimizations (batch writes, incremental worktree, optimistic cache)
- [x] Integration tests (87 tests)
- [x] Performance benchmarks

### Phase 2 — Production Ready
- [ ] Authentication (API key / JWT + permissions table)
- [ ] Git protocol v2
- [ ] Webhooks on push
- [ ] Branch protection rules
- [ ] Wire up libgit2 blame to R2 ODB
- [ ] Shallow clone support
- [ ] Git LFS (R2 backend)

### Phase 3 — Platform
- [ ] Pull request model via API
- [ ] Code search via DO SQLite or Workers AI
- [ ] Web editor (edit files, create commits from UI)
- [ ] Template repos / server-side fork
- [ ] CI/CD integration (trigger Workers on push)
