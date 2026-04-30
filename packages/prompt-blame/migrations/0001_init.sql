-- @gitmode/prompt-blame — initial schema (v0)
-- See ../schema.sql for the canonical schema and design rationale.

CREATE TABLE IF NOT EXISTS commit_metadata (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  prompt_id TEXT,
  model TEXT,
  agent TEXT,
  session_id TEXT,
  parent_session_id TEXT,
  human_edited INTEGER NOT NULL DEFAULT 0,
  human_author_email TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_commit_metadata_session
  ON commit_metadata (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commit_metadata_prompt
  ON commit_metadata (prompt_id)
  WHERE prompt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commit_metadata_repo_agent
  ON commit_metadata (repo_id, agent)
  WHERE agent IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commit_metadata_repo_time
  ON commit_metadata (repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prompt_text (
  prompt_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS line_provenance (
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  prompt_id TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (repo_id, commit_sha, file_path, line_start)
);

CREATE INDEX IF NOT EXISTS idx_line_provenance_path
  ON line_provenance (repo_id, commit_sha, file_path);
