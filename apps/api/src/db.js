import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..');
dotenv.config({ path: resolve(projectRoot, '.env') });
const databasePath = resolve(projectRoot, process.env.DATABASE_PATH || 'data/activity-monitor.sqlite');

mkdirSync(dirname(databasePath), { recursive: true });
export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
const appliedMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
const recordMigration = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
for (const migration of readdirSync(resolve(projectRoot, 'database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
	if (appliedMigration.get(migration)) continue;
	db.exec('BEGIN IMMEDIATE');
	try {
		db.exec(readFileSync(resolve(projectRoot, 'database/migrations', migration), 'utf8'));
		recordMigration.run(migration, new Date().toISOString());
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}
