CREATE TABLE web_attendance_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_session_id INTEGER NOT NULL REFERENCES auth_sessions(id),
  client_session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  UNIQUE (auth_session_id, client_session_id)
);

CREATE INDEX idx_web_attendance_auth_session ON web_attendance_sessions(auth_session_id, started_at);