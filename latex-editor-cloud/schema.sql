-- Schema D1 cho LaTeX Editor Cloud
-- Apply: wrangler d1 execute latex-editor-db --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  head        TEXT NOT NULL,
  bundle_key  TEXT NOT NULL,
  protocol    TEXT NOT NULL DEFAULT 'git-bundle-v1',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  inviter_id  TEXT NOT NULL REFERENCES users(id),
  email       TEXT,
  token_hash  TEXT,
  role        TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_project ON invitations(project_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token_hash);

CREATE TABLE IF NOT EXISTS user_templates (
  id           TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  engine       TEXT NOT NULL DEFAULT 'pdflatex',
  description  TEXT,
  bundle_key   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_user_templates_user ON user_templates(user_id);

CREATE TABLE IF NOT EXISTS project_publications (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  id           TEXT NOT NULL UNIQUE,
  pdf_key      TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  source_head  TEXT NOT NULL,
  size         INTEGER NOT NULL CHECK(size >= 0),
  published_by TEXT NOT NULL REFERENCES users(id),
  published_at TEXT NOT NULL,
  expires_at   INTEGER,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publications_id ON project_publications(id);
CREATE INDEX IF NOT EXISTS idx_publications_pdf_key ON project_publications(pdf_key);

