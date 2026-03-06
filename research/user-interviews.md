# GitMode User Interview Plan

## Goal

Validate three assumptions before building more features:
1. Serverless git hosting removes a real infrastructure pain
2. The REST API (not just git protocol) is what differentiates us
3. Edge deployment (low latency from any datacenter) matters for git workflows

Target: 5-8 interviews across two segments. 30 min each.

---

## Segments

### Segment A: "Platform builders" (3-4 people)
People building developer tools, CI/CD pipelines, or platforms that need git server functionality.

**Where to find them:**
- Gitea / Soft Serve GitHub Discussions — people asking about self-hosting
- r/selfhosted — "git server" threads
- HN threads about GitHub alternatives (commenters building their own)
- DevOps Slack communities — people managing git infrastructure

**Screener:**
- Do you self-host or manage git infrastructure?
- Have you built a tool that programmatically creates repos, commits, or branches?
- What's your current git hosting setup? (GitHub, GitLab, Gitea, bare repos?)
- Do you have latency or availability concerns with your current setup?

**Disqualify if:** Only uses GitHub.com as an end-user, no programmatic git needs.

### Segment B: "Edge/Serverless developers" (2-4 people)
People building on Cloudflare Workers, Vercel Edge, Deno Deploy who need data persistence.

**Where to find them:**
- Cloudflare Discord #workers — people asking about persistent storage
- X/Twitter — search "cloudflare workers database" or "durable objects"
- Dev.to / blog posts about "serverless storage" or "edge persistence"
- IndieHackers — developers building SaaS on Workers

**Screener:**
- Are you building on Cloudflare Workers or another edge platform?
- Do you need version-controlled or git-like data storage?
- What's your current approach to data persistence at the edge?
- Would a git-based API for storing/versioning data be useful?

**Disqualify if:** Traditional server-side only, no edge/serverless interest.

---

## Interview Guide

### Opening (2 min)

> Thanks for chatting. I'm researching how developers think about git infrastructure and serverless storage — not pitching anything. There are no wrong answers. I'll ask about your experience, not about a specific tool.

### Part 1: Git infrastructure pain (10 min)

**Context question:**
> Walk me through your current git hosting setup. What works well and what doesn't?

**Follow-ups (use as needed):**
- Have you ever needed to programmatically create repos or commits?
- What did you use? (GitHub API, libgit2, shell out to git CLI?)
- Where did you get frustrated?
- If you self-host: what's the maintenance burden like?
- How do you handle multi-region or edge access to git?

**Probe for specifics:**
> If they mention friction: "Can you describe the exact scenario? What were you trying to do and what went wrong?"
> If they say "GitHub works fine": "Is there anything you can't do with GitHub's API that you wish you could?"

**Key signal:**
- Do they have programmatic git needs beyond what GitHub provides?
- Is self-hosting git a real pain or just a "nice to have"?
- Do they care about latency to git operations?

### Part 2: REST API vs git protocol (10 min)

**Context question:**
> When you interact with git repositories programmatically, do you use the git CLI, a library like libgit2, or an HTTP API?

**Follow-ups:**
- What operations do you do most? (create repos, commit files, read files, merge?)
- If you use the GitHub/GitLab API: what's your experience been?
- Have you ever wanted to do something that wasn't possible through an API?
- Would a JSON REST API for all git operations (commit, merge, cherry-pick, diff) be useful?

**Probe for the REST API value prop:**
> Imagine you could do `POST /api/repos/myorg/myrepo/merge` with a JSON body and get back the merge result. How would that change your workflow compared to shelling out to git?

**Key signal:**
- Is the REST API the differentiator, or is the git protocol enough?
- What operations do they need that aren't well served by existing APIs?
- Do they prefer REST or git CLI for automation?

### Part 3: Edge deployment (5 min)

**Context question:**
> How important is latency for your git operations? Does it matter if a commit takes 50ms vs 500ms?

**Follow-ups:**
- Do you have users in multiple regions?
- Would you use a git server that runs at the edge (sub-50ms from any datacenter)?
- What about the tradeoff: edge deployment means some limits (100MB request size, 30s CPU)?
- How do you feel about git hosting on Cloudflare Workers specifically?

**Key signal:**
- Does edge deployment matter, or is a central server fine?
- Are they already on Cloudflare and want to consolidate?
- Do the Workers limits concern them?

### Closing (3 min)

> If you could design the perfect git hosting solution for your use case, what's the #1 feature?

> Is there anything I didn't ask about that matters to you?

> Can I follow up if I have one more question?

---

## After each interview

Fill in the tracking sheet (research/interview-tracker.md):
- Participant ID (P1, P2, ...)
- Segment (A or B)
- Current stack
- Key quotes (verbatim, not paraphrased)
- Git pain: what's hard about their current setup
- REST API: would they use it, what operations matter
- Edge: does latency/distribution matter
- Surprise: anything unexpected

---

## Outreach templates

### Cold DM (Discord/Twitter)

> Hey — I'm researching how devs manage git infrastructure, especially self-hosting and programmatic access. Not selling anything. Would you be up for a 30-min chat about your experience? Happy to share findings afterward.

### Forum/thread reply

> Interesting setup. I'm doing user research on git hosting and automation — specifically what pain points exist beyond GitHub/GitLab. Would you be open to a quick 30-min chat? DM me if interested.

### Follow-up after agreement

> Thanks! Here's a Calendly/time link: [LINK]
>
> Quick context: I'll ask about your experience with git hosting, programmatic git access, and edge deployment. No prep needed. I'll share anonymized findings afterward if you're interested.

---

## Decision framework

After 5+ interviews, synthesize into:

| Assumption | Validated? | Evidence | Action |
|-----------|-----------|----------|--------|
| Serverless git removes real infra pain | Yes/No/Partial | Quotes + patterns | Keep/kill/pivot the "zero infrastructure" messaging |
| REST API is the differentiator | Yes/No/Partial | Quotes + patterns | Keep/kill/pivot API-first positioning |
| Edge deployment matters for git | Yes/No/Partial | Quotes + patterns | Keep/kill/pivot the Cloudflare Workers story |

**Decision rules:**
- If 4/5+ people validate → double down, ship prominently
- If 2-3/5 validate → keep but don't prioritize, dig deeper on the alternative
- If 0-1/5 validate → kill or radically rethink

What we learn should directly change the README messaging, feature priority, and what we build next.
