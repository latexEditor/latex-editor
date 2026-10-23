-- Public, unlisted PDF results. The random publication id is the share link.
-- Source bundles remain private and separate from generated PDF objects.
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
