PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  full_name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  designation TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  last_heartbeat_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_started ON auth_sessions(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  auth_session_id INTEGER NOT NULL REFERENCES auth_sessions(id),
  previous_status TEXT NOT NULL CHECK (previous_status IN ('unknown', 'available', 'away', 'offline')),
  status TEXT NOT NULL CHECK (status IN ('unknown', 'available', 'away', 'offline')),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_user_time ON activity_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activity_session_time ON activity_events(auth_session_id, occurred_at);

CREATE TABLE IF NOT EXISTS application_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  idle_threshold_seconds INTEGER NOT NULL DEFAULT 60 CHECK (idle_threshold_seconds IN (60, 120, 300, 600)),
  camera_enabled INTEGER NOT NULL DEFAULT 0 CHECK (camera_enabled IN (0, 1)),
  camera_requires_office_network INTEGER NOT NULL DEFAULT 1 CHECK (camera_requires_office_network IN (0, 1)),
  organization_timezone TEXT NOT NULL DEFAULT 'UTC'
);
INSERT OR IGNORE INTO application_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id INTEGER REFERENCES users(id),
  details TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(occurred_at);
