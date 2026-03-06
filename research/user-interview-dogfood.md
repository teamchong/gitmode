# User Interview: Dogfooding GitMode

**Date:** 2026-03-06
**Method:** Hands-on usage audit + competitive analysis
**Persona:** Developer building a todo app project using gitmode as their git server

---

## Executive Summary

GitMode has a **unique and defensible position** as the only full git server that runs entirely on Cloudflare Workers with zero infrastructure. The git protocol implementation is solid (clone, push, fetch all work correctly over HTTP and SSH), and the REST API adds a powerful programmatic layer that no other self-hosted git server provides. However, **data integrity bugs, missing features, and documentation drift** would cause serious problems in production.

**Verdict:** Solid core protocol, impressive REST API, needs hardening.

---

## Part 1: Issues Encountered (as a first-time user)

### P0 - Critical (data loss / corruption)

| # | Issue | Detail | Status |
|---|-------|--------|--------|
| 1 | **Three-way merge drops files** | When both sides modify the same directory, `mergeTrees()` takes one side's tree wholesale instead of recursing into subdirectories. Files silently lost. | **FIXED** |
| 2 | **Concurrent commits lose data** | 5 parallel API commits to same branch → only 2 files survive. Each commit reads the same parent ref, creating divergent histories where the last writer wins. | **FIXED** |

### P1 - Significant (blocks basic workflows)

| # | Issue | Detail | Status |
|---|-------|--------|--------|
| 3 | **Init + immediate commit race condition** | Chaining `POST /init` and `POST /commits` in rapid succession can fail because init may not have committed SQLite state before commit arrives. | **FIXED** (auto-init in commit) |
| 4 | **Missing author produces "undefined"** | Commit without author/email creates literal `"undefined <undefined>"` strings in git history. | **FIXED** (defaults to "unknown") |
| 5 | **Deploy fails: wrangler.jsonc points to deleted file** | Production config referenced `./worker/index.ts` which imports deleted `RepoLock` and `vinext`. | **FIXED** |
| 6 | **Deploy fails: CI missing Zig + binaryen** | Deploy workflow had no Zig setup, no libgit2 build, and apt binaryen was too old for Zig's WASM features. | **FIXED** |
| 7 | **`multi_ack_detailed` advertised but not implemented** | Server advertised this capability but never implemented it, causing git clients to use a negotiation mode the server couldn't handle. | **FIXED** (removed capability) |

### P2 - UX Friction

| # | Issue | Detail | Status |
|---|-------|--------|--------|
| 8 | **Diff params non-obvious** | `?a=` and `?b=` instead of `?from=` and `?to=`. | **FIXED** (both accepted) |
| 9 | **SSH "no common commits" warning** | Every `git fetch` shows a harmless but noisy warning because server didn't ACK recognized objects. | **FIXED** (proper ACK) |
| 10 | **No `GET /api/repos` endpoint** | Can't list repositories. | **FIXED** (R2 prefix listing) |
| 11 | **No repo metadata API** | `repo_meta` table exists with description/visibility but no GET/PATCH API. | **FIXED** |
| 12 | **No commit detail by SHA** | Must reconstruct from `log` + `show`. No `GET /commits/:sha`. | **FIXED** |
| 13 | **No file history** | Can't get commits affecting a specific file. | **FIXED** |
| 14 | **No contributors endpoint** | Can't get author statistics. | **FIXED** |
| 15 | **No repo stats** | No commit count, file count, size info. | **FIXED** |
| 16 | **No CORS headers** | Browser-based clients can't access the API. | **FIXED** |
| 17 | **Docs say `pnpm run dev`** | Correct command is `pnpm wrangler dev`. | **FIXED** |

---

## Part 2: What Works Well

### Git Protocol
- **Clone/push/fetch all work correctly** over both HTTP and SSH
- **Incremental push** sends only deltas — fast for iterative development
- **Branch operations** (create, push, delete, rename) all work
- **Tags** (lightweight and annotated) work via API and git push
- **Cross-protocol interop** — push via SSH, pull via HTTP, commit via API: all three directions work seamlessly
- **Binary files** preserve integrity through push → R2 → clone cycle
- **Repo isolation** — different DOs, different R2 prefixes, zero contamination

### REST API
- **30+ endpoints** covering all common git operations
- **Merge** supports both fast-forward and three-way with automatic conflict resolution
- **Cherry-pick and revert** work correctly with three-way merge
- **Reset** moves branch pointers cleanly
- **Rev-parse** supports branches, tags, HEAD, HEAD~N, HEAD^, raw SHAs
- **File operations** (read, list, list-all) with ref support

### Architecture
- **Durable Objects** provide strong consistency for refs — no stale reads
- **R2** provides cheap, scalable object storage with content-addressed keys
- **Zig WASM** handles all binary ops (SHA-1, zlib, packfile, delta) efficiently
- **SSH proxy** cleanly translates SSH → HTTP with sideband passthrough

---

## Part 3: Competitive Landscape

### Direct Competitors

| | GitMode | GitHub | GitLab | Gitea | Soft Serve |
|---|---|---|---|---|---|
| **Self-hostable** | Yes (CF Workers) | No (SaaS) | Yes (heavy) | Yes (Go binary) | Yes (Go binary) |
| **Serverless** | Yes | N/A | No | No | No |
| **Infrastructure** | Zero (CF edge) | Managed | VMs/K8s | Single binary | Single binary |
| **Cold start** | ~50ms (DO wake) | N/A | N/A | N/A | N/A |
| **REST API** | 30+ git ops | Yes (extensive) | Yes (extensive) | Partial | No |
| **SSH transport** | Dev proxy | Native | Native | Native | Native |
| **Git protocol** | Smart HTTP v1 | Smart HTTP v2 | Smart HTTP v2 | Smart HTTP v2 | SSH only |
| **Auth** | None (yet) | OAuth/PAT/SSH keys | OAuth/LDAP/SAML | OAuth/LDAP | SSH keys |
| **Web UI** | None | Full | Full | Full | TUI only |
| **CI/CD** | None | Actions | CI/CD | Actions | None |
| **Issues/PRs** | None | Full | Full | Full | None |
| **Cost** | CF Workers pricing | Free tier + paid | Free tier + paid | Free | Free |
| **Multi-region** | Yes (CF edge) | Yes (managed) | Manual | Manual | No |

### GitMode's Unique Position (what nobody else does)

1. **Zero-infrastructure git server** — Deploy to Cloudflare Workers, get a globally distributed git server. No VMs, no Docker, no maintenance.
2. **Programmatic-first REST API** — 30+ endpoints for all git operations via JSON. Create repos, commit files, merge branches, cherry-pick — all via HTTP. No git binary required.
3. **Per-repo isolation via Durable Objects** — Each repo is a strongly consistent DO with embedded SQLite. No shared database, no locking across repos.
4. **Edge-native** — Sub-50ms git operations from any Cloudflare datacenter. No single point of failure.
5. **Zig WASM engine** — SHA-1, zlib, packfile parsing, and delta encoding in optimized WASM with SIMD acceleration. 791KB binary.

### Where GitMode Overlaps (competitors do it better today)

| Area | Better Alternative | Why |
|------|-------------------|-----|
| Full-featured git hosting | GitHub / GitLab | Web UI, issues, PRs, CI/CD, code review |
| Simple self-hosted git | Gitea | Single binary, full UI, mature ecosystem |
| SSH-only minimal server | Soft Serve | Beautiful TUI, zero config, SSH native |
| Git protocol v2 | All competitors | GitMode only supports v1 |
| Enterprise features | GitLab | LDAP, SAML, audit logs, compliance |

### Where GitMode Wins (nobody else does this)

| Use Case | Why GitMode |
|----------|-------------|
| Serverless git for automation | REST API + zero infrastructure. Spin up repos on demand for CI, code review bots, or template generation. |
| Multi-tenant code storage | One DO per repo, isolated by design. Perfect for platforms that store user code (like Replit, CodeSandbox). |
| Edge-native version control | Git operations from any CF datacenter. Ideal for distributed teams or global dev platforms. |
| Git-backed data versioning | Use git semantics (branch, merge, diff) for config files, schemas, or structured data — all via API. |
| Embedded git for apps | No git binary needed. Commit files, create branches, merge — all from your application code. |

---

## Part 4: Remaining Gaps

### Must-have (blocks adoption)

| Feature | Impact |
|---------|--------|
| **Authentication** | Any client can push/pull. `permissions` table exists but unused. |
| **Web UI** | No way to browse repos, view commits, or read files in a browser. |
| **Git protocol v2** | Modern git clients prefer v2. GitMode only speaks v1. |
| **Signed commits** | No GPG/SSH signature verification. |
| **Webhooks** | No event notifications for post-push, post-merge, etc. |

### Nice-to-have (competitive parity)

| Feature | Impact |
|---------|--------|
| **Blame** | WASM export exists (`libgit2_blame`) but ODB callbacks not wired to R2. |
| **Pull requests** | No PR model — merge is direct via API. |
| **Code search** | No full-text search across repos. |
| **Repo forking** | No fork/clone-on-server support. |
| **Branch protection** | No rules for preventing force-push or requiring reviews. |
| **Shallow clone** | Full history always transferred. Needs upload-pack depth negotiation. |
| **LFS** | Large files stored as regular git objects. |

---

## Part 5: Recommendations

### Tier 1: Production readiness (week 1-2)

1. **Add authentication** — API key or JWT. Wire up the existing `permissions` table. Without auth, nobody can deploy this publicly.
2. **Add webhooks** — POST to a URL on push/merge/branch events. Essential for CI/CD integration.
3. **Add branch protection** — Prevent force-push to main, require specific refs for push.

### Tier 2: Close the adoption gap (weeks 3-6)

4. **Build a minimal web UI** — Repo list, file browser, commit log, diff viewer. Use the REST API as the backend. Even a read-only viewer dramatically improves discoverability.
5. **Git protocol v2** — Modern clients use v2 by default. Supporting it removes the "old protocol" feel.
6. **Wire up libgit2 blame** — Connect ODB host callbacks to R2 reads. The WASM export exists, just needs the bridge.

### Tier 3: Strategic differentiation (month 2+)

7. **PR model** — Create/review/merge pull requests via API. The programmatic PR workflow would be unique.
8. **Code search** — Full-text search across repos using Workers AI or a search index in DO SQLite.
9. **Template repos** — `POST /api/repos/:owner/:repo/fork` to clone a repo server-side. Enables "create from template" flows.
10. **Git-backed CMS** — Position GitMode as a headless CMS: commit Markdown files via API, read them at the edge. Compete with Contentful/Sanity for static content.

---

## Part 6: Positioning Recommendation

### Current: "Serverless git hosting on Cloudflare Workers"
**Problem:** Sounds like infrastructure tooling. Doesn't convey the "why".

### Proposed: "Git as an API"
**Tagline:** "Full git server as a REST API. Create repos, commit files, merge branches — all serverless on Cloudflare."

### Target personas (in order):
1. **Platform builders** — Building dev tools that need git storage (code playgrounds, template engines, config management)
2. **Automation engineers** — CI/CD pipelines that need to create/modify repos programmatically
3. **Cloudflare-native teams** — Already using Workers + R2, want integrated git without external dependencies

### Anti-personas (don't target yet):
- Teams wanting to replace GitHub/GitLab (need web UI, issues, PRs)
- Solo developers (just use GitHub)
- Enterprise (need LDAP, audit logs, compliance)
