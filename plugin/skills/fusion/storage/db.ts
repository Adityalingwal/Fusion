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

// Current on-disk schema. Fusion is pre-release with no installed users, so there is deliberately
// NO migration machinery: the CREATE below builds the final shape directly, and this number resets
// to 1 as the one-and-only pre-release schema. A DB stamped with any other version predates this
// reset — the fix is a fresh start (delete the file), not an upgrade path. Migrations begin when
// real users exist.
const SCHEMA_VERSION = 1;

function initSchema(db: Database): void {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new Error(
      `this Fusion database predates a pre-release schema reset (found v${version}); ` +
        `delete ${dbPath()} and run Fusion again for a fresh start`,
    );
  }
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

export function now(): string {
  return new Date().toISOString();
}
