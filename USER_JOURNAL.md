# User Journal: Building a Todo App on gitmode

> Testing gitmode as a real user — creating a project, developing across HTTP and SSH, exercising every feature. Conducted on a local `wrangler dev` instance with the SSH proxy.

---

## Day 1: Project Setup

### Creating the repo (REST API)

I initialized a new repo `steven/todo-app` via the REST API and committed a 6-file project scaffold in a single request:

```bash
curl -X POST http://localhost:8787/api/repos/steven/todo-app/init
curl -X POST http://localhost:8787/api/repos/steven/todo-app/commits \
  -d '{"ref":"main", "files":[...6 files...], "message":"initial project scaffold"}'
```

**Worked perfectly.** The commit returned a SHA immediately. I verified with the files API — all 6 files present, content correct. The `files/all` endpoint recursively lists everything including nested `src/` files, which was handy.

### Cloning over HTTP

```bash
git clone http://localhost:8787/steven/todo-app.git
```

Seamless. Got all files, correct commit history. Feels exactly like cloning from GitHub.

### Local development cycle

Made two commits locally (added `store.ts`, updated `types.ts`) and pushed:

```bash
git push
# To http://localhost:8787/steven/todo-app.git
#    3cf83ea..d4b8f0d  main -> main
```

Verified via the REST API that both files were updated server-side. The incremental push was fast — only sends the delta.

**Verdict: The basic create → clone → edit → push cycle works exactly as expected.** No surprises.

---

## Day 2: Feature Branch Workflow

### Branch, develop, merge

Created `feature/filters` locally, added `filters.ts` and `sort.ts` across two commits, pushed:

```bash
git checkout -b feature/filters
git push -u origin feature/filters
```

Meanwhile, I simulated another developer (Alice) committing to `main` via the REST API — updating the README with badges.

### Three-way merge

Used the merge API to bring the feature branch into main:

```bash
curl -X POST .../merge -d '{"target":"main","source":"feature/filters"}'
# {"sha":"fc81e29c","strategy":"merge"}
```

**The merge was correct** — main now has both Alice's README changes AND the new filter/sort files. The `strategy: "merge"` response confirms it did a real three-way merge, not fast-forward.

### Diff API

Before merging, I checked the diff:

```
GET /diff?a=main&b=feature/filters
→ modified README.md, added src/filters.ts, added src/sort.ts
```

**Note:** The diff params are `?a=` and `?b=`, not `?from=` and `?to=`. Tripped me up the first time.

---

## Day 3: Tags, Cherry-pick, Revert, Reset

### Tagging

Created an annotated tag `v0.1.0` via API, and a lightweight tag `v0.1.0-local` via git push:

```bash
git tag v0.1.0-local
git push origin v0.1.0-local
```

Both showed up in the tags API — annotated with tagger/message metadata, lightweight with just the SHA.

### Cherry-pick

Created a hotfix branch, committed a rate limiter, then cherry-picked onto main:

```bash
curl -X POST .../cherry-pick -d '{"commit":"<sha>","target":"main"}'
```

**Worked.** The file appeared on main without the hotfix branch's other history.

### Revert

Immediately reverted the cherry-pick:

```bash
curl -X POST .../revert -d '{"commit":"<cherry-sha>","target":"main"}'
```

**The `ratelimit.ts` file was correctly removed.** The revert created a new commit that undid exactly the cherry-picked changes.

### Reset

Reset main back to the merge commit, erasing both the cherry-pick and revert:

```bash
curl -X POST .../reset -d '{"ref":"main","target":"fc81e29c..."}'
```

**Before:** 9 commits (including cherry-pick + revert)
**After:** 7 commits — clean history back to the merge

**Reset works correctly.** It moves the branch pointer and the log walks only the reachable commits.

---

## Day 4: SSH Transport

### SSH clone

```bash
git clone ssh://git@localhost:2222/steven/todo-app.git
```

Got all 7 commits, all files. Identical to the HTTP clone.

### SSH push + cross-protocol verification

Added `api.ts` via SSH push, then verified via REST API:

```bash
# Push via SSH
GIT_SSH_COMMAND="ssh -p 2222 ..." git push

# Verify via REST API
curl .../files?ref=main&path=src/api.ts
# {"content":"import { addTodo, getTodos...","size":...}
```

### Cross-protocol round-trips

The real test — can HTTP and SSH clones talk to each other through the server?

1. **SSH push → HTTP pull**: Pushed `api.ts` via SSH, pulled in HTTP clone. ✓
2. **HTTP push → SSH pull**: Pushed `middleware.ts` via HTTP, pulled in SSH clone. ✓
3. **API commit → SSH pull**: Committed via REST API, pulled in SSH clone. ✓

**All three directions work.** The server doesn't care which transport delivered the data — it's all the same refs and objects.

### SSH branch delete

```bash
git push origin --delete feature-ssh
```

**Works.** The proxy correctly handles delete-only pushes (no packfile, just ref-update commands).

### Binary files

Pushed a 32KB random binary file, cloned via SSH, compared SHA-1:

```
Original:  2af6f972a611ce8103f65a9dac6b8490676e8b9b
Clone:     2af6f972a611ce8103f65a9dac6b8490676e8b9b
PASS
```

**Binary integrity preserved perfectly** through push → R2 storage → packfile → clone.

---

## Day 5: Housekeeping

### Branch management

- **Renamed** `feature/filters` → `archive/filters` via API
- **Deleted** the `hotfix` branch via API
- Both worked without issues

### Tag cleanup

- Deleted `v0.1.0-local` via REST API
- Deleted `v0.1.0` via SSH push (`git push origin --delete v0.1.0`)
- Both methods work for tag deletion

### ls-remote via SSH

```bash
git ls-remote ssh://git@localhost:2222/steven/todo-app.git
# 323c6c89... HEAD
# 6f0214d0... refs/heads/archive/filters
# 323c6c89... refs/heads/main
```

**Correct** — shows HEAD, both branches, no deleted refs.

### Repo isolation

Created `alice/blog` separately — confirmed it has zero cross-contamination with `steven/todo-app`. Different DOs, different R2 key prefixes, completely isolated.

---

## Final State

```
steven/todo-app
├── Branches: main*, archive/filters
├── Tags: (none — all cleaned up)
├── Commits: 10 on main
└── Files:
    ├── .gitignore
    ├── README.md
    ├── assets/logo.bin (32KB binary)
    ├── package.json
    └── src/
        ├── api.ts
        ├── app.ts
        ├── filters.ts
        ├── index.ts
        ├── middleware.ts
        ├── sort.ts
        ├── store.ts
        └── types.ts
```

---

## Operations Tested

| # | Operation | Transport | Result |
|---|-----------|-----------|--------|
| 1 | Init repo | REST API | ✓ |
| 2 | Commit (6 files) | REST API | ✓ |
| 3 | Read file | REST API | ✓ |
| 4 | List all files | REST API | ✓ |
| 5 | Log | REST API | ✓ |
| 6 | Clone | HTTP | ✓ |
| 7 | Push | HTTP | ✓ |
| 8 | Incremental push | HTTP | ✓ |
| 9 | Create branch + push | HTTP | ✓ |
| 10 | Commit on branch (API) | REST API | ✓ |
| 11 | Diff | REST API | ✓ |
| 12 | Three-way merge | REST API | ✓ |
| 13 | Create annotated tag | REST API | ✓ |
| 14 | Push lightweight tag | HTTP | ✓ |
| 15 | List tags | REST API | ✓ |
| 16 | Create branch (API) | REST API | ✓ |
| 17 | Cherry-pick | REST API | ✓ |
| 18 | Revert | REST API | ✓ |
| 19 | Reset | REST API | ✓ |
| 20 | Clone | SSH | ✓ |
| 21 | Push | SSH | ✓ |
| 22 | SSH push → HTTP pull | Cross | ✓ |
| 23 | HTTP push → SSH pull | Cross | ✓ |
| 24 | API commit → SSH pull | Cross | ✓ |
| 25 | Rename branch | REST API | ✓ |
| 26 | Delete branch | REST API | ✓ |
| 27 | Delete tag (API) | REST API | ✓ |
| 28 | Delete tag (SSH push) | SSH | ✓ |
| 29 | Binary file roundtrip | HTTP+SSH | ✓ |
| 30 | rev-parse | REST API | ✓ |
| 31 | Show object | REST API | ✓ |
| 32 | ls-remote | SSH | ✓ |
| 33 | Repo isolation | HTTP | ✓ |
| 34 | Pull (fast-forward) | HTTP | ✓ |
| 35 | Pull (fast-forward) | SSH | ✓ |
| 36 | Fetch | HTTP | ✓ |
| 37 | Fetch | SSH | ✓ |

**37/37 operations passed.**

---

## Issues Found

### Bug: Init + immediate commit can silently fail

When chaining `init` and `commit` in rapid succession (same shell line), the commit can return a SHA but the branch doesn't get created. Running the commit as a separate request a moment later works fine. This is likely a race condition in the Durable Object — the init may not have fully committed its SQLite state before the commit request arrives. This should be fixed by ensuring `init` awaits all writes before responding.

### UX: Diff query params are non-obvious

The diff endpoint uses `?a=` and `?b=` instead of more intuitive names like `?from=` and `?to=`. Easy to get wrong on first try.

### UX: SSH proxy "warning: no common commits" on every fetch

After the first clone, every subsequent `git fetch` shows "warning: no common commits". This is harmless but noisy — it happens because the server's packfile doesn't include the common-commit negotiation that suppresses this warning. The data is correct regardless.

---

## Overall Impression

gitmode delivers on its promise — a fully functional git server running on Cloudflare Workers. The core git operations (clone, push, fetch, branches, tags) work correctly across both HTTP and SSH transports. The REST API adds a powerful programmatic layer on top.

The development experience is smooth: `wrangler dev` starts instantly, the SSH proxy is a single command, and all three interfaces (git HTTP, git SSH, REST API) interoperate seamlessly.

For a proof-of-concept, this is remarkably complete.
