# Interview Tracker

## Summary

| ID | Date | Segment | Stack | Git pain signal | REST API signal | Edge signal |
|----|------|---------|-------|-----------------|-----------------|-------------|
| D1 | 2026-03-06 | Dogfood | gitmode local dev | Merge data loss, concurrent commit loss | 30+ endpoints work, missing metadata/stats | Sub-50ms DO wake |
| P1 |      |         |       |                 |                 |             |
| P2 |      |         |       |                 |                 |             |
| P3 |      |         |       |                 |                 |             |
| P4 |      |         |       |                 |                 |             |
| P5 |      |         |       |                 |                 |             |

---

## D1 — Dogfood (self-interview)

**Date:** 2026-03-06
**Segment:** Dogfood
**Current stack:** gitmode (Cloudflare Workers + Zig WASM)
**Role/context:** Developer building a todo app to test all 37 git operations

### Git Pain
- Merge data loss (both sides modified same directory → files dropped)
- Concurrent commits lose data (no optimistic locking)
- Deploy workflow broken (missing Zig, binaryen, libgit2 build steps)
- Production wrangler.jsonc pointed to deleted file

### REST API
- 30+ endpoints all work correctly once bugs fixed
- Missing: repo metadata, commit detail, file history, contributors, stats
- Diff params (`?a=`/`?b=`) non-obvious, needed `?from=`/`?to=` aliases
- No CORS headers blocked browser clients

### Edge
- Durable Object wake time ~50ms is good
- Per-repo DO isolation works perfectly
- R2 object storage is transparent and reliable
- SSH proxy works for dev but needs proper SSH server for production

### Key quotes
1. "The basic create → clone → edit → push cycle works exactly as expected. No surprises."
2. "All three directions work — SSH push → HTTP pull, HTTP push → SSH pull, API commit → SSH pull."
3. "Binary integrity preserved perfectly through push → R2 storage → packfile → clone."

### Surprise
- Three-way merge bug was critical — silently lost files. Would have been a data loss incident in production.
- The REST API is actually the killer feature, not the git protocol. Being able to `POST /merge` with JSON is something no other self-hosted git server offers.

---

## P1

**Date:**
**Segment:** A / B
**Current stack:**
**Role/context:**

### Git Pain
- Current setup:
- What's hard:
- Programmatic needs:

### REST API
- Would they use it:
- What operations matter:
- Compared to their current API:

### Edge
- Latency requirements:
- Multi-region needs:
- Cloudflare experience:

### Key quotes
1.
2.
3.

### Surprise


---

## P2

**Date:**
**Segment:** A / B
**Current stack:**
**Role/context:**

### Git Pain
- Current setup:
- What's hard:
- Programmatic needs:

### REST API
- Would they use it:
- What operations matter:
- Compared to their current API:

### Edge
- Latency requirements:
- Multi-region needs:
- Cloudflare experience:

### Key quotes
1.
2.
3.

### Surprise


---

## P3

**Date:**
**Segment:** A / B
**Current stack:**
**Role/context:**

### Git Pain
- Current setup:
- What's hard:
- Programmatic needs:

### REST API
- Would they use it:
- What operations matter:
- Compared to their current API:

### Edge
- Latency requirements:
- Multi-region needs:
- Cloudflare experience:

### Key quotes
1.
2.
3.

### Surprise


---

## P4

**Date:**
**Segment:** A / B
**Current stack:**
**Role/context:**

### Git Pain
- Current setup:
- What's hard:
- Programmatic needs:

### REST API
- Would they use it:
- What operations matter:
- Compared to their current API:

### Edge
- Latency requirements:
- Multi-region needs:
- Cloudflare experience:

### Key quotes
1.
2.
3.

### Surprise


---

## P5

**Date:**
**Segment:** A / B
**Current stack:**
**Role/context:**

### Git Pain
- Current setup:
- What's hard:
- Programmatic needs:

### REST API
- Would they use it:
- What operations matter:
- Compared to their current API:

### Edge
- Latency requirements:
- Multi-region needs:
- Cloudflare experience:

### Key quotes
1.
2.
3.

### Surprise


---

## Synthesis (fill after 5+ interviews)

### Git Infrastructure Pain — what we learned

**Pattern:**
**Our assumption was:** Serverless git removes real infrastructure pain.
**What actually matters:**
**Action:**

### REST API — what we learned

**Pattern:**
**Our assumption was:** The REST API (not just git protocol) is what differentiates us.
**What actually matters:**
**Action:**

### Edge Deployment — what we learned

**Pattern:**
**Our assumption was:** Edge deployment matters for git workflows.
**What actually matters:**
**Action:**

### Biggest surprise across all interviews

### What we should build next (evidence-based)
1.
2.
3.
