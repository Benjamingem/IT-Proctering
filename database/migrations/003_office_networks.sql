CREATE TABLE office_networks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  ssid TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

ALTER TABLE auth_sessions ADD COLUMN last_network_ssid TEXT;
ALTER TABLE auth_sessions ADD COLUMN last_network_match INTEGER CHECK (last_network_match IN (0, 1));
CREATE INDEX idx_office_networks_active ON office_networks(active, ssid);
