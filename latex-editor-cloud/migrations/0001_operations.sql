-- Apply once to existing databases before deploying the operations Worker.
CREATE TABLE IF NOT EXISTS account_deletions (
  user_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_storage (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_storage_user ON cloud_storage(user_id);
CREATE INDEX IF NOT EXISTS idx_cloud_storage_project ON cloud_storage(project_id);
CREATE INDEX IF NOT EXISTS idx_cloud_storage_created ON cloud_storage(created_at);
CREATE INDEX IF NOT EXISTS idx_projects_bundle_key ON projects(bundle_key);
CREATE INDEX IF NOT EXISTS idx_templates_bundle_key ON user_templates(bundle_key);
CREATE TABLE IF NOT EXISTS cloud_maintenance (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Conservatively account for existing bundles until the scheduled reconciler
-- reads their exact R2 sizes. Do not undercount existing accounts after upgrade.
INSERT OR IGNORE INTO cloud_storage (key, user_id, project_id, bytes, created_at)
SELECT p.bundle_key, m.user_id, p.id, 52428800, 0 FROM projects p
JOIN project_members m ON m.project_id = p.id AND m.role = 'owner';
INSERT OR IGNORE INTO cloud_storage (key, user_id, project_id, bytes, created_at)
SELECT bundle_key, user_id, NULL, 52428800, 0 FROM user_templates;

-- Close races between a deletion request and already-running OAuth/invitations.
CREATE TRIGGER IF NOT EXISTS reject_deleted_session BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM account_deletions WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion pending'); END;
CREATE TRIGGER IF NOT EXISTS reject_deleted_member BEFORE INSERT ON project_members
WHEN EXISTS (SELECT 1 FROM account_deletions WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion pending'); END;
CREATE TRIGGER IF NOT EXISTS reject_deleted_template_insert BEFORE INSERT ON user_templates
WHEN EXISTS (SELECT 1 FROM account_deletions WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion pending'); END;
CREATE TRIGGER IF NOT EXISTS reject_deleted_template_update BEFORE UPDATE ON user_templates
WHEN EXISTS (SELECT 1 FROM account_deletions WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account deletion pending'); END;
