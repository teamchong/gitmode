# timeline → prompt-blame bridge

Reads snapshots produced by [timeline](https://github.com/teamchong/timeline) (stored as git notes under `refs/notes/timeline-metadata`) and POSTs the metadata to a prompt-blame Worker.

## Why

Timeline captures local Claude Code edits as snapshot commits with session/tool metadata in git notes. This bridge moves that metadata to the server side so it's queryable across machines, editable repos, and longer history horizons.

## Usage

Run from inside a repo where timeline has been recording:

```bash
# Import all snapshots, posting to localhost:8787
node import.mjs

# Override the Worker URL
node import.mjs --worker=https://prompt-blame.example.workers.dev

# Only snapshots created after a known commit
node import.mjs --since=<sha>

# Print what would be sent without POSTing
node import.mjs --dry-run
```

Set the Worker URL via env:

```bash
export PROMPT_BLAME_URL=https://prompt-blame.example.workers.dev
node import.mjs
```

## What gets posted

For each timeline snapshot:

```json
{
  "repo_id": "https://github.com/user/repo.git",
  "commit_sha": "<snapshot-commit-sha>",
  "agent": "claude-code",
  "session_id": "<from-timeline-note>",
  "metadata_json": {
    "tool": "Edit",
    "files": [...],
    "snapshot_at": "...",
    "branch": "..."
  }
}
```

Note: `commit_sha` is the timeline *snapshot* commit, not the user's working-branch commit. Snapshots represent agent activity at a moment in time, not finalized commits.

## Limitations

- One-shot import; not real-time. Re-run after new snapshots accumulate.
- Idempotent: re-running upserts (latest write wins) thanks to the Worker's `ON CONFLICT DO UPDATE`.
- Doesn't currently attach prompt text. That's stored in Claude Code's session JSONL — a future enhancement could parse those and include `prompt_id`.
