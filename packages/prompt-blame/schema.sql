-- @gitmode/prompt-blame — D1 schema
--
-- Sidecar metadata for git commits produced by AI agents.
-- See ./README.md for design rationale.
--
-- This schema runs in Cloudflare D1 (multi-tenant SQLite).
-- D1 dialect notes:
--   - INTEGER PRIMARY KEY auto-rowid; otherwise compound primary keys are fine
--   - No foreign keys enforced by default; treat as advisory
--   - Indexes are CREATE INDEX, no concurrent option
--
-- Migration strategy: this is the initial schema (v0). Future migrations
-- live in ./migrations/ and run via `wrangler d1 migrations apply`.

-- ============================================================================
-- Commit-level metadata
-- ============================================================================
-- One row per (repo, commit_sha) capturing who/what produced the commit.
-- This is the primary write target for the POST /metadata endpoint.

CREATE TABLE IF NOT EXISTS commit_metadata (
  -- Identity
  repo_id TEXT NOT NULL,           -- canonical remote URL, lowercased (see README)
  commit_sha TEXT NOT NULL,        -- 40-char lowercase hex SHA-1

  -- Provenance
  prompt_id TEXT,                  -- opaque ID; UUID, hash of prompt text, or agent-assigned
  model TEXT,                      -- e.g., 'claude-opus-4-7', 'gpt-5', 'gemini-2.5-pro'
  agent TEXT,                      -- e.g., 'claude-code', 'cursor', 'copilot', 'aider'
  session_id TEXT,                 -- agent session/conversation ID
  parent_session_id TEXT,          -- for forked or resumed sessions

  -- Human signals
  human_edited INTEGER NOT NULL DEFAULT 0,  -- 0/1: did human modify before commit?
  human_author_email TEXT,         -- optional; git committer is authoritative for who pushed

  -- Extensibility hatch (for fields we haven't designed yet)
  metadata_json TEXT,              -- arbitrary JSON; query with json_extract()

  -- Bookkeeping
  created_at INTEGER NOT NULL,     -- unix epoch milliseconds (server-side, not client clock)

  PRIMARY KEY (repo_id, commit_sha)
);

-- Lookups by session ("show me every commit from session X")
CREATE INDEX IF NOT EXISTS idx_commit_metadata_session
  ON commit_metadata (session_id)
  WHERE session_id IS NOT NULL;

-- Lookups by prompt ("which commits did prompt X produce")
CREATE INDEX IF NOT EXISTS idx_commit_metadata_prompt
  ON commit_metadata (prompt_id)
  WHERE prompt_id IS NOT NULL;

-- Lookups by agent ("which commits did claude-code produce in this repo")
CREATE INDEX IF NOT EXISTS idx_commit_metadata_repo_agent
  ON commit_metadata (repo_id, agent)
  WHERE agent IS NOT NULL;

-- Time-ordered scans within a repo
CREATE INDEX IF NOT EXISTS idx_commit_metadata_repo_time
  ON commit_metadata (repo_id, created_at DESC);


-- ============================================================================
-- Prompt text storage (opt-in)
-- ============================================================================
-- Stores prompt text only when the client opts in. Default is to omit.
-- Privacy reasons: prompts often contain secrets, customer data, internal code.
--
-- For prompts larger than ~64KB we'll move to R2 keyed by prompt_id; see README.
-- This table is for the small-prompt happy path.

CREATE TABLE IF NOT EXISTS prompt_text (
  prompt_id TEXT PRIMARY KEY,      -- same as commit_metadata.prompt_id
  text TEXT NOT NULL,              -- the prompt content
  text_hash TEXT NOT NULL,         -- sha-256 hex of text, for dedup verification
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);


-- ============================================================================
-- Line-level provenance (deferred, schema reserved)
-- ============================================================================
-- Phase 2 stores commit-level only. This table is here so that adding
-- per-line provenance later doesn't require a breaking migration.
--
-- Populated by a future capture step that knows the line ranges the agent
-- generated vs. ranges the human edited.

CREATE TABLE IF NOT EXISTS line_provenance (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,     -- 1-indexed, inclusive
  line_end INTEGER NOT NULL,       -- 1-indexed, inclusive
  prompt_id TEXT,                  -- which prompt produced this range; NULL = human-only
  source TEXT NOT NULL,            -- 'agent' | 'human' | 'merge' | 'unknown'
  PRIMARY KEY (repo_id, commit_sha, file_path, line_start)
);

CREATE INDEX IF NOT EXISTS idx_line_provenance_path
  ON line_provenance (repo_id, commit_sha, file_path);
