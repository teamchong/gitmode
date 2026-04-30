# Claude Code → prompt-blame hook

Adds a `PostToolUse` hook to Claude Code that POSTs commit provenance to a prompt-blame Worker after every tool use (Edit, Write, Bash, etc).

## What it does

After Claude Code runs a tool, it invokes the hook command with a JSON payload on stdin:

```json
{
  "session_id": "...",
  "tool_name": "Edit",
  "tool_input": { "file_path": "..." },
  "transcript_path": "/Users/.../session.jsonl"
}
```

The hook command:

1. Detects the current repo's remote URL (via `git config --get remote.origin.url`)
2. Detects the current `HEAD` SHA
3. POSTs `{ repo_id, commit_sha, agent: "claude-code", session_id, metadata_json: { tool } }` to the Worker
4. Exits 0 silently (errors don't propagate, so Claude Code is never blocked)

If there's no commit yet (e.g., HEAD detached or empty repo), the hook exits 0 without posting.

## Why this design

- **Silent failure** — hooks must not block the user's editing flow. Network errors, missing repos, timeouts all exit 0.
- **Lowest-friction integration** — uses the existing `prompt-blame` CLI; no new dependencies.
- **Composable with timeline** — timeline already installs its own `PostToolUse` hook for snapshots. Claude Code allows multiple hooks; both run.

## Install

Edit `~/.claude/settings.json` and add a hook entry under `hooks.PostToolUse`. The command runs `prompt-blame hook`, reading stdin from Claude Code.

If `@gitmode/prompt-blame` is **installed globally** (or via `pnpm link`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "prompt-blame hook --worker=https://prompt-blame.example.workers.dev"
          }
        ]
      }
    ]
  }
}
```

If running from this repo (development mode):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/gitmode/packages/prompt-blame/bin/prompt-blame.mjs hook --worker=http://localhost:8787"
          }
        ]
      }
    ]
  }
}
```

## Verify

After installing, edit a file in Claude Code, then query the Worker:

```bash
prompt-blame get --sha=$(git rev-parse HEAD) --repo=$(git config --get remote.origin.url)
```

You should see the metadata stored, including the Claude session ID.

## Compatibility with timeline

If you also use [timeline](https://github.com/teamchong/timeline), keep both hooks. They serve different purposes:

| Hook | Captures | Where it stores | When it runs |
|---|---|---|---|
| timeline | Working-tree snapshot at edit time | Local git notes | After every tool use |
| prompt-blame | Provenance of latest committed SHA | Cloudflare D1 via Worker | After every tool use |

If you only want server-side capture without per-edit snapshots, install only this hook.

## Limitations

- The hook posts the **latest commit at hook time**, not necessarily the commit produced by *this* edit. If the user hasn't committed since the agent's last edit, you'll get duplicate metadata for the previous commit.
- Provenance is at the commit level. Per-line attribution requires the deferred `line_provenance` table — not in Phase 2.
- Authentication is not yet implemented. Don't expose your Worker publicly without adding auth (see package `README.md`).
