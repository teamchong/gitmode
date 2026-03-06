-- gitmode per-repo DO SQLite schema
-- Each RepoStore Durable Object instance creates these tables
-- in its embedded SQLite database on first access.

-- Git refs (branches, tags)
CREATE TABLE IF NOT EXISTS refs (
  name TEXT PRIMARY KEY,
  sha TEXT NOT NULL
);

-- HEAD (symbolic ref, e.g. "ref: refs/heads/main")
CREATE TABLE IF NOT EXISTS head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL
);

-- Repo metadata (one row per DO instance)
CREATE TABLE IF NOT EXISTS repo_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  visibility TEXT DEFAULT 'public',
  default_branch TEXT DEFAULT 'main',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Commit index (for log, search, API)
CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commits_timestamp ON commits(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(author);

-- Access permissions
CREATE TABLE IF NOT EXISTS permissions (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin'))
);
