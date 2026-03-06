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
       |
       v
+----------------------------------------------------------+
|  Cloudflare Worker (TypeScript)                          |
|  +-----------+  +-------------+  +------------------+   |
|  | info-refs |  | upload-pack |  | receive-pack     |   |
|  | (GET)     |  | (clone/     |  | (push)           |   |
|  |           |  |  fetch)     |  |  + checkout to R2 |   |
|  +-----------+  +-------------+  +------------------+   |
|       |              |                   |               |
|       v              v                   v               |
|  +------------------------------------------------+     |
|  |  Zig WASM Engine (936K, SIMD128)               |     |
|  |  - SHA-1 hashing        - Delta compression    |     |
|  |  - Packfile encode/decode  - Zlib inflate       |     |
|  |  - Object serialization - Tree walking          |     |
|  |  - Server-side checkout (tree -> R2 files)      |     |
|  +------------------------------------------------+     |
|       |              |                   |               |
+----------------------------------------------------------+
        |              |                   |
   +----+----+    +----+----+    +----+----+----+
   |   KV    |    |   R2    |    |   D1    | DO |
   |  refs   |    | objects |    | metadata|lock|
   |         |    | + files |    |         |    |
   +---------+    +---------+    +---------+----+

+----------------------------------------------------------+
|  vinext UI (React Server Components)                     |
|  - Reads files directly from R2 worktree (no git ops)    |
|  - Reads commit log from D1 (SQL)                        |
|  - Reads refs from KV                                    |
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

### KV (Refs)

```
{owner}/{repo}/refs/heads/{branch}    -- SHA-1 hex string (40 bytes)
{owner}/{repo}/refs/tags/{tag}        -- SHA-1 hex string
{owner}/{repo}/HEAD                   -- "ref: refs/heads/main"
```

### D1 (Metadata)

Tables:
- `repos` — owner, name, description, visibility, default_branch
- `commits` — repo, sha1, author, message, timestamp (indexed for search)
- `ssh_keys` — owner, fingerprint, public_key
- `permissions` — repo, username, role (read/write/admin)

### Durable Objects (Locks)

One DO per repo. Used only during `git push` to serialize ref updates.
Holds no persistent state — refs live in KV.

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

### Host Imports

The WASM module imports these functions from the TypeScript host:

```
env.r2_get(key_ptr, key_len, buf_ptr, buf_cap) -> i32  (bytes read or -1)
env.r2_put(key_ptr, key_len, data_ptr, data_len) -> i32  (0 or -1)
env.r2_head(key_ptr, key_len) -> i32  (size or -1)
env.kv_get(key_ptr, key_len, buf_ptr, buf_cap) -> i32
env.kv_put(key_ptr, key_len, val_ptr, val_len) -> i32
env.log_msg(ptr, len) -> void
```

### Build

```
Target: wasm32-freestanding + SIMD128
Optimize: ReleaseSmall (936K binary)
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
POST /{owner}/{repo}.git/git-receive-pack                     -> receive-pack.ts (via DO lock)
GET  /{owner}/{repo}.git/HEAD                                 -> KV lookup
/*   (everything else)                                        -> vinext UI
```

### Push Flow

1. Client sends ref update commands + packfile
2. Worker routes to RepoLock DO (atomic per-repo)
3. DO calls receive-pack handler
4. Zig WASM parses packfile, extracts objects
5. Objects stored in R2 (zlib-compressed)
6. Refs updated in KV
7. Checkout: Zig WASM walks commit tree, writes files to R2 worktree
8. Commit indexed in D1
9. Report-status returned to client

### Clone/Fetch Flow

1. Client sends want/have negotiation
2. Worker calls upload-pack handler
3. Object graph walked from wanted refs (stops at client's haves)
4. Objects fetched from R2
5. Zig WASM assembles packfile (zlib + delta compression)
6. Packfile streamed to client

---

## vinext UI

### Technology

- vinext (Vite + React RSC) deployed on the same Cloudflare Worker
- Server Components read directly from R2/KV/D1 bindings (zero API hops)
- Client Components for interactive elements (search, code highlighting)

### Pages

| Route | Description | Data Source |
|-------|-------------|-------------|
| `/` | Landing page / repo list | D1: `SELECT * FROM repos` |
| `/{owner}` | User's repos | D1: `SELECT * FROM repos WHERE owner = ?` |
| `/{owner}/{repo}` | Repo overview (README + file tree) | R2 worktree + KV refs |
| `/{owner}/{repo}/tree/{branch}/[...path]` | File/directory browser | R2 worktree |
| `/{owner}/{repo}/blob/{branch}/[...path]` | File viewer with syntax highlight | R2 worktree |
| `/{owner}/{repo}/commits/{branch}` | Commit history | D1: commits table |
| `/{owner}/{repo}/commit/{sha}` | Single commit diff | R2: objects + Zig diff |
| `/{owner}/{repo}/branches` | Branch list | KV: list refs/heads/* |
| `/{owner}/{repo}/tags` | Tag list | KV: list refs/tags/* |
| `/{owner}/{repo}/settings` | Repo settings | D1: repos + permissions |

### Layout Hierarchy

```
app/
  layout.tsx              -- root layout (html, head, body)
  page.tsx                -- landing / repo discovery
  [owner]/
    page.tsx              -- user profile / repo list
    [repo]/
      layout.tsx          -- repo header (name, branches, tabs)
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

### Design Language

- Monospace-first (code hosting)
- Dark/light mode via CSS custom properties
- No component library — plain HTML + CSS
- File icons based on extension
- Syntax highlighting via a lightweight WASM-based highlighter or server-rendered

---

## libgit2 Integration (Phase 2)

### Purpose

Server-side git operations that go beyond protocol handling:
- `git_diff()` — compute diffs for commit view
- `git_blame()` — blame annotations in file viewer
- `git_merge()` — merge branches server-side
- `git_checkout_tree()` — worktree materialization (replace our Zig checkout)

### Approach

1. libgit2 C source (deps/libgit2/) compiled to WASM via `zig cc`
2. Custom `git_odb_backend` vtable pointing to R2 host imports
3. Custom `git_refdb_backend` vtable pointing to KV host imports
4. POSIX shims for filesystem calls (same pattern as pymode/CPython)
5. Ships zlib, pcre, SHA1, xdiff — zero external deps

### Backend Vtable

```c
struct git_odb_backend {
    int (*read)(void **data, size_t *len, git_object_t *type, git_odb_backend *, const git_oid *);
    int (*write)(git_odb_backend *, const git_oid *, const void *, size_t, git_object_t);
    int (*exists)(git_odb_backend *, const git_oid *);
    void (*free)(git_odb_backend *);
    // ... more callbacks
};
```

We implement each callback to call R2 via host imports.

---

## SSH Support (Phase 2)

Cloudflare Workers support TCP via the `connect()` API.

Options:
1. Implement SSH key exchange in Zig WASM (curve25519 + ed25519)
2. Use Cloudflare Tunnel to bridge SSH -> Worker HTTP
3. Compile a minimal SSH library (e.g., libssh2) to WASM alongside libgit2

---

## Deployment

### One-Click Deploy

Deploy button in README triggers:
1. Fork repo to user's GitHub
2. GitHub Actions workflow runs
3. Creates R2 bucket, KV namespace, D1 database
4. Runs D1 schema migration
5. Builds Zig WASM
6. Deploys Worker via Wrangler

### Manual Deploy

```bash
git clone <repo>
cd gitmode
./scripts/setup.sh   # provisions resources + deploys
```

---

## Development Phases

### Phase 1 — MVP (current)
- [x] Zig WASM engine (SHA-1, packfile, delta, zlib, protocol)
- [x] Git smart HTTP (info-refs, upload-pack, receive-pack)
- [x] R2 object storage + KV refs + D1 metadata
- [x] Server-side checkout (worktree materialization)
- [x] Deploy button + GitHub Actions
- [ ] vinext UI (repo browser, commit history, file viewer)
- [ ] Test with real git client

### Phase 2 — Full Git
- [ ] libgit2 compiled to WASM (diff, blame, merge)
- [ ] SSH transport
- [ ] Git LFS (R2 backend)
- [ ] Protocol v2
- [ ] Shallow clone support

### Phase 3 — Platform
- [ ] Authentication (GitHub OAuth, SSH keys)
- [ ] Webhooks on push
- [ ] CI/CD integration (trigger Workers on push)
- [ ] Web editor (edit files directly, create commits from UI)
- [ ] API (REST + GraphQL for programmatic access)
