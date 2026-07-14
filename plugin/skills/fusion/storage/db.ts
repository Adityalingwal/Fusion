import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function dbPath(): string {
  return process.env.FUSION_DB || join(homedir(), ".fusion", "fusion.db");
}

const handles = new Map<string, Database>();

export function closeAll(): void {
  for (const db of handles.values()) db.close();
  handles.clear();
}

export function open(): Database {
  const path = dbPath();
  const cached = handles.get(path);
  if (cached) return cached;
  mkdirSync(dirname(path), { recursive: true });
  const db = openConfigured(path);
  handles.set(path, db);
  return db;
}

function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

// Open + configure with a retry. Concurrent cold-starts race on the journal_mode=WAL switch, which
// takes a lock — busy_timeout MUST be the FIRST pragma so that switch WAITS rather than failing
// immediately with SQLITE_BUSY (which used to crash the process and lose writes). The retry loop is
// a backstop for the rare case the wait still loses the race.
function openConfigured(path: string): Database {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const db = new Database(path, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      initSchema(db);
      return db;
    } catch (err) {
      db.close();
      if (attempt >= MAX_ATTEMPTS || !isBusy(err)) throw err;
      Bun.sleepSync(20 * attempt);
    }
  }
}

// Current on-disk schema. v4 adds the two codex-failure columns and the 'aborted' run status; see
// migrateV3toV4 for the upgrade from v0.1.x databases (v3). v2 and older stay unsupported.
const SCHEMA_VERSION = 4;

function initSchema(db: Database): void {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version !== 0 && version !== 3 && version !== 4) {
    throw new Error(`unsupported Fusion DB schema version ${version}; back up and reset the local database`);
  }
  // Existing v0.1.x database: upgrade in place before the idempotent CREATEs below run. A fresh DB
  // (version 0) skips straight to the CREATE, which builds the v4 shape directly.
  if (version === 3) migrateV3toV4(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      root_path  TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL REFERENCES projects(id),
      title               TEXT NOT NULL DEFAULT 'Untitled run',
      status              TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted')),
      created_at          TEXT NOT NULL,
      brief               TEXT,
      claude_report       TEXT,
      codex_report        TEXT,
      plan                TEXT,
      codex_fail_reason   TEXT,
      codex_fail_category TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at DESC);
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

// v3 → v4: additive columns (codex_fail_reason / codex_fail_category) AND a widened status CHECK
// (adds 'aborted'). SQLite cannot ALTER a CHECK constraint, so the status change needs a table
// rebuild; we fold the two new columns into the same rebuild so an existing user DB upgrades in one
// pass. Nothing references runs (the only FK is runs.project_id → projects, preserved by copying
// every row's project_id), so the rebuild is safe with foreign_keys left ON. Wrapped in a
// transaction so a mid-migration crash can't leave a half-built table.
function migrateV3toV4(db: Database): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE runs_v4 (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL REFERENCES projects(id),
        title               TEXT NOT NULL DEFAULT 'Untitled run',
        status              TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted')),
        created_at          TEXT NOT NULL,
        brief               TEXT,
        claude_report       TEXT,
        codex_report        TEXT,
        plan                TEXT,
        codex_fail_reason   TEXT,
        codex_fail_category TEXT
      );
      INSERT INTO runs_v4 (id, project_id, title, status, created_at, brief, claude_report, codex_report, plan)
        SELECT id, project_id, title, status, created_at, brief, claude_report, codex_report, plan FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_v4 RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at DESC);
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function now(): string {
  return new Date().toISOString();
}
