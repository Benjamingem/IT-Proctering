CREATE TABLE IF NOT EXISTS application_switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  auth_session_id INTEGER NOT NULL REFERENCES auth_sessions(id),
  previous_application TEXT,
  previous_window_title TEXT,
  application TEXT NOT NULL,
  window_title TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_application_switch_user_time ON application_switch_events(user_id, occurred_at, id);