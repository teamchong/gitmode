# User Interview: Dogfooding GitMode

**Date:** 2026-03-06
**Method:** Hands-on usage audit + browser testing + performance benchmarks
**Persona:** Developer using gitmode as their git server for real work

---

## Executive Summary

GitMode has a **unique and defensible position** as the only full git server that runs entirely on Cloudflare Workers with zero infrastructure. The git protocol implementation is solid (clone, push, fetch all work correctly over HTTP and SSH), and the REST API adds a powerful programmatic layer. The vinext web UI now works end-to-end. Performance is strong for small-medium repos but push latency at 500 files needs optimization.

**Verdict:** Core protocol solid. Web UI functional. Performance acceptable. Ready for alpha testing.

---

## Part 1: Issues Found and Fixed

### Session 1 — API & Protocol Audit (17 issues, all fixed)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Three-way merge drops files in subdirectories | P0 | **FIXED** |
| 2 | Concurrent commits lose data (last-writer-wins) | P0 | **FIXED** |
| 3 | Init + immediate commit race condition | P1 | **FIXED** |
| 4 | Missing author produces `"undefined <undefined>"` | P1 | **FIXED** |
| 5 | Deploy fails: worker imports deleted `RepoLock` | P1 | **FIXED** |
| 6 | Deploy CI missing Zig + binaryen setup | P1 | **FIXED** |
| 7 | `multi_ack_detailed` advertised but not implemented | P1 | **FIXED** |
| 8 | Diff params non-obvious (`?a=` vs `?from=`) | P2 | **FIXED** |
| 9 | SSH fetch shows noisy "no common commits" warning | P2 | **FIXED** |
| 10 | No `GET /api/repos` endpoint | P2 | **FIXED** |
| 11 | No repo metadata GET/PATCH API | P2 | **FIXED** |
| 12 | No commit detail by SHA endpoint | P2 | **FIXED** |
| 13 | No file history endpoint | P2 | **FIXED** |
| 14 | No contributors endpoint | P2 | **FIXED** |
| 15 | No repo stats endpoint | P2 | **FIXED** |
| 16 | No CORS headers on API | P2 | **FIXED** |
| 17 | Docs say wrong dev command | P2 | **FIXED** |

### Session 2 — Web UI Testing (8 issues, all fixed)

Tested all 8 vinext RSC pages with real repos via browser automation (CDP).

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 18 | cherry-pick/revert/reset crash on undefined field names | P1 | **FIXED** |
| 19 | Repo meta not initialized on `git push` | P1 | **FIXED** |
| 20 | Commits not indexed after `git push` (stats/contributors empty) | P1 | **FIXED** |
| 21 | `/show` endpoint broken (only accepted raw SHA, not refs) | P1 | **FIXED** |
| 22 | Stats shows `commits: 0` for pushed repos | P1 | **FIXED** |
| 23 | Commit detail page missing diff/changed files | P2 | **FIXED** |
| 24 | No active tab indicator in navigation | P2 | **FIXED** |
| 25 | README rendered as raw text (no markdown) | P2 | **FIXED** |

---

## Part 2: Performance Benchmarks

**Environment:** macOS, localhost dev server (vite dev), single Durable Object

### Git Protocol Operations

| Operation | Small (3 files) | Medium (50 files) | Large (500 files) |
|---|---|---|---|
| **Initial push** | 283ms | 183ms | 972ms |
| **Incremental push** | 85ms | 192ms (10 commits) | 827ms (5 commits) |
| **Clone** | 95ms | 152ms | 372ms |
| **Fetch** | 98ms | 153ms | 340ms |

### REST API Response Times

| Endpoint | Latency |
|---|---|
| GET /api/repos (list) | 54ms |
| GET /api/repos/:o/:r (meta) | 44ms |
| GET /branches | 43ms |
| GET /log (50 commits) | 61ms |
| GET /files (root listing) | 42ms |
| GET /files/all (500 files) | 62ms |
| GET /stats (500 files) | 167ms |
| GET /contributors | 42ms |

### Analysis

**What's fast:**
- API reads are consistently under 65ms (except stats which walks all file objects)
- Clone and fetch are fast — 372ms for 500 files is acceptable
- Incremental push for small repos is 85ms — competitive with any git host

**What's slow:**
- **Large initial push (972ms):** Bottleneck is R2 object writes — each of 500+ objects is a separate R2 PUT. Could batch with `putMany()` or use packfile storage.
- **Large incremental push (827ms):** Worktree materialization re-writes all files on every push. Should diff and only update changed files.
- **Stats endpoint (167ms):** Reads every blob to sum sizes. Could cache in SQLite.

### Performance Optimization Priorities

| Priority | Optimization | Expected Impact |
|---|---|---|
| 1 | **Batch R2 writes** during packfile unpack | Push 2-3x faster for large repos |
| 2 | **Incremental worktree update** — only write changed files | Incremental push 5-10x faster |
| 3 | **Cache file size in SQLite** during commit | Stats endpoint instant |
| 4 | **Pack storage** — store packfiles as-is instead of unpacking to loose | Push much faster, clone uses existing pack |
| 5 | **SIMD-accelerated delta encoding** for upload-pack | Faster clone/fetch for large repos |

---

## Part 3: What Works Well

### Git Protocol
- Clone/push/fetch all work correctly over HTTP and SSH
- Incremental push sends only deltas
- Branch operations (create, push, delete, rename) all work
- Tags (lightweight and annotated) work via API and git push
- Cross-protocol interop — push via SSH, pull via HTTP, commit via API
- Binary files preserve integrity through full round-trip

### REST API (35+ endpoints)
- Full CRUD for branches, tags, commits
- Merge (fast-forward + three-way), cherry-pick, revert, reset
- File read/list/list-all with ref support
- Rev-parse supports branches, tags, HEAD, HEAD~N, HEAD^, raw SHAs
- Diff, log, file-log, contributors, stats
- CORS enabled for browser clients

### Web UI (vinext RSC)
- 10 pages: homepage, owner, repo overview, file tree, blob viewer, commits, commit detail, branches, tags
- Active tab indicator, markdown README rendering
- Commit detail shows changed files with A/M/D indicators
- All pages work with real data from RepoStore DO

### Architecture
- Durable Objects provide strong consistency for refs
- R2 provides scalable content-addressed object storage
- Zig WASM (791KB) handles SHA-1, zlib, packfile, delta
- SSH proxy translates SSH→HTTP with sideband passthrough

---

## Part 4: Competitive Landscape

| | GitMode | GitHub | GitLab | Gitea | Soft Serve |
|---|---|---|---|---|---|
| **Self-hostable** | Yes (CF Workers) | No (SaaS) | Yes (heavy) | Yes (Go binary) | Yes (Go binary) |
| **Serverless** | Yes | N/A | No | No | No |
| **Infrastructure** | Zero (CF edge) | Managed | VMs/K8s | Single binary | Single binary |
| **REST API** | 35+ git ops | Yes (extensive) | Yes (extensive) | Partial | No |
| **Web UI** | Basic (10 pages) | Full | Full | Full | TUI only |
| **Auth** | None (yet) | OAuth/PAT/SSH | OAuth/LDAP/SAML | OAuth/LDAP | SSH keys |
| **Git protocol** | Smart HTTP v1 | Smart HTTP v2 | Smart HTTP v2 | Smart HTTP v2 | SSH only |
| **CI/CD** | None | Actions | CI/CD | Actions | None |

### GitMode's Unique Position
1. **Zero-infrastructure git server** — deploy to CF Workers, done
2. **Git as an API** — 35+ REST endpoints, no git binary needed
3. **Per-repo isolation** via Durable Objects with embedded SQLite
4. **Edge-native** — sub-50ms from any CF datacenter
5. **Zig WASM engine** — SHA-1, zlib, packfile, delta in 791KB WASM

---

## Part 5: Remaining Gaps

### Must-have for alpha release

| Feature | Impact |
|---------|--------|
| **Authentication** | Any client can push/pull. `permissions` table exists but unused. |
| **Git protocol v2** | Modern git clients prefer v2. |
| **Webhooks** | No event notifications for push/merge events. |

### Nice-to-have for competitive parity

| Feature | Impact |
|---------|--------|
| **Blame** | WASM export exists but ODB callbacks not wired to R2. |
| **Pull requests** | No PR model — merge is direct via API. |
| **Shallow clone** | Full history always transferred. |
| **Branch protection** | No rules for preventing force-push. |
| **Code search** | No full-text search across repos. |

---

## Part 6: Recommendations

### Now: Performance + Auth (production readiness)
1. Batch R2 writes during push (biggest perf win)
2. Add authentication (API key / JWT + permissions table)
3. Incremental worktree updates (only write changed files)

### Next: Protocol + Integrations
4. Git protocol v2 support
5. Webhooks (post-push, post-merge events)
6. Branch protection rules

### Later: Platform features
7. Pull request model via API
8. Wire up libgit2 blame
9. Code search via DO SQLite or Workers AI
10. Template repos / server-side fork
