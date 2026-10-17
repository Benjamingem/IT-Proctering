CREATE TABLE employee_camera_consents (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  consent_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE employee_camera_checkins (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_session_id INTEGER NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  activity_event_id INTEGER NOT NULL UNIQUE REFERENCES activity_events(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  encrypted_image BLOB NOT NULL
);

CREATE INDEX idx_camera_checkins_user_captured
  ON employee_camera_checkins (user_id, captured_at DESC);
