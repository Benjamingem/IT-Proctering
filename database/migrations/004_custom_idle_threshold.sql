CREATE TABLE application_settings_new (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  idle_threshold_seconds INTEGER NOT NULL DEFAULT 60 CHECK (idle_threshold_seconds BETWEEN 1 AND 3600),
  camera_enabled INTEGER NOT NULL DEFAULT 0 CHECK (camera_enabled IN (0, 1)),
  camera_requires_office_network INTEGER NOT NULL DEFAULT 1 CHECK (camera_requires_office_network IN (0, 1)),
  organization_timezone TEXT NOT NULL DEFAULT 'UTC'
);

INSERT INTO application_settings_new (id, idle_threshold_seconds, camera_enabled, camera_requires_office_network, organization_timezone)
SELECT id, idle_threshold_seconds, camera_enabled, camera_requires_office_network, organization_timezone FROM application_settings;

DROP TABLE application_settings;
ALTER TABLE application_settings_new RENAME TO application_settings;