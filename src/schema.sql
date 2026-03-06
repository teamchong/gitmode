-- gitmode D1 schema — metadata, commit index, permissions, SSH keys

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  visibility TEXT DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  default_branch TEXT DEFAULT 'main',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  sha1 TEXT NOT NULL,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  UNIQUE(repo, sha1)
);

CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_commits_author ON commits(repo, author);

CREATE TABLE IF NOT EXISTS ssh_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ssh_keys_fingerprint ON ssh_keys(fingerprint);

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
  UNIQUE(repo, username)
);

CREATE INDEX IF NOT EXISTS idx_permissions_repo ON permissions(repo);
