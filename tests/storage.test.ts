import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import * as storage from "../plugin/skills/fusion/storage";
import { parseStringArgs } from "../plugin/skills/fusion/lib/args";
import { useTempDirs } from "./helpers/temp";

const makeTempDir = useTempDirs("fusion-storage-");

async function freshDb(): Promise<{ db: ReturnType<typeof storage.open>; dir: string }> {
  const dir = await makeTempDir();
  process.env.FUSION_DB = join(dir, "fusion.db");
  return { db: storage.open(), dir };
}

test("run content roundtrips via getRunDetails", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x/proj" });
  storage.startRun(db, { runId: "r1", projectId: "p1", title: "  Plan auth refresh  " });
  storage.putArtifact(db, "r1", "brief", "the brief");
  storage.putArtifact(db, "r1", "claude_report", "claude leg");
  storage.putArtifact(db, "r1", "codex_report", "codex leg");
  storage.putArtifact(db, "r1", "plan", "the plan");
  storage.finishRun(db, "r1");

  const d = storage.getRunDetails(db, "r1");
  expect(d.brief).toBe("the brief");
  expect(d.claudeReport).toBe("claude leg");
  expect(d.codexReport).toBe("codex leg");
  expect(d.plan).toBe("the plan");
  expect(d.title).toBe("Plan auth refresh");
  expect(d.status).toBe("completed");
  expect(d.createdAt).toBeTruthy();
});

test("fresh schema v2 has host metadata and separate provider-failure columns", async () => {
  const { db } = await freshDb();
  const tables = db
    .query(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  expect(tables.map((row) => row.name)).toEqual(["projects", "runs"]);

  const columns = db.query(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>;
  expect(columns.map((row) => row.name)).toEqual([
    "id",
    "project_id",
    "title",
    "status",
    "created_at",
    "host_model",
    "brief",
    "claude_report",
    "codex_report",
    "plan",
    "codex_fail_reason",
    "codex_fail_category",
    "claude_fail_reason",
    "claude_fail_category",
  ]);
  expect((db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version).toBe(2);
  const titleColumn = (db.query(`PRAGMA table_info(runs)`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((column) => column.name === "title");
  expect(titleColumn).toMatchObject({ notnull: 1, dflt_value: "'Untitled run'" });
  expect((db.query(`PRAGMA foreign_key_list(runs)`).get() as { table: string }).table).toBe("projects");
  expect((db.query(`SELECT sql FROM sqlite_schema WHERE name = 'runs'`).get() as { sql: string }).sql).toContain(
    "CHECK (status IN ('running', 'completed', 'aborted'))",
  );
  expect((db.query(`PRAGMA index_info(idx_runs_project)`).all() as Array<{ name: string }>).map((r) => r.name)).toEqual([
    "project_id",
    "created_at",
  ]);
});

test("v1 database migrates transactionally to v2 and preserves existing content", async () => {
  const dir = await makeTempDir();
  const dbFile = join(dir, "v1.db");
  const v1 = new Database(dbFile, { create: true });
  v1.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, created_at TEXT);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL DEFAULT 'Untitled run',
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted')),
      created_at TEXT NOT NULL,
      brief TEXT,
      claude_report TEXT,
      codex_report TEXT,
      plan TEXT,
      codex_fail_reason TEXT,
      codex_fail_category TEXT
    );
    INSERT INTO projects VALUES ('p1', 'project', '/x', '2026-01-01T00:00:00.000Z');
    INSERT INTO runs VALUES ('r1', 'p1', 'old run', 'running', '2026-01-01T00:00:00.000Z',
      'brief-v1', 'claude-v1', 'codex-v1', 'plan-v1', 'old failure', 'transient');
    PRAGMA user_version = 1;
  `);
  v1.close();

  process.env.FUSION_DB = dbFile;
  const db = storage.open();
  const detail = storage.getRunDetails(db, "r1");
  expect(detail).toMatchObject({
    hostModel: "claude",
    providerModel: "codex",
    brief: "brief-v1",
    claudeReport: "claude-v1",
    codexReport: "codex-v1",
    plan: "plan-v1",
    codexFailReason: "old failure",
    claudeFailReason: null,
  });
  expect((db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version).toBe(2);
});

test("concurrent v1 opens converge on one complete v2 migration", async () => {
  const dir = await makeTempDir();
  const dbFile = join(dir, "concurrent-v1.db");
  const v1 = new Database(dbFile, { create: true });
  v1.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, created_at TEXT);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL DEFAULT 'Untitled run',
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted')),
      created_at TEXT NOT NULL, brief TEXT, claude_report TEXT, codex_report TEXT, plan TEXT,
      codex_fail_reason TEXT, codex_fail_category TEXT
    );
    PRAGMA user_version = 1;
  `);
  v1.close();

  const storagePath = join(import.meta.dir, "../plugin/skills/fusion/storage.ts");
  const worker = `
    process.env.FUSION_DB = ${JSON.stringify(dbFile)};
    const storage = await import(${JSON.stringify(storagePath)});
    storage.open();
  `;
  const workers = Array.from({ length: 6 }, () =>
    Bun.spawn(["bun", "-e", worker], { stdout: "ignore", stderr: "pipe" }),
  );
  const results = await Promise.all(workers.map(async (proc) => ({
    code: await proc.exited,
    stderr: await new Response(proc.stderr).text(),
  })));
  expect(results, results.map((result) => result.stderr).join("\n")).toEqual(
    Array.from({ length: 6 }, () => ({ code: 0, stderr: "" })),
  );

  process.env.FUSION_DB = dbFile;
  const db = storage.open();
  expect((db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version).toBe(2);
  expect((db.query(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map((row) => row.name)).toContain(
    "claude_fail_category",
  );
});

test("a DB stamped with an unknown schema version refuses to open instead of running against it", async () => {
  const dir = await makeTempDir();
  const dbFile = join(dir, "stale.db");
  const oldDb = new Database(dbFile, { create: true });
  oldDb.exec("PRAGMA user_version = 3;");
  oldDb.close();
  process.env.FUSION_DB = dbFile;

  expect(() => storage.open()).toThrow("unsupported Fusion DB schema version 3");
});

test("recordCodexFailure and clearCodexFailure round-trip the drop reason on a run row", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "r1", projectId: "p1" });

  storage.recordCodexFailure(db, "r1", "codex exited 1: 429 too many requests", "quota");
  let detail = storage.getRunDetails(db, "r1");
  expect(detail.codexFailReason).toContain("429");
  expect(detail.codexFailCategory).toBe("quota");

  storage.clearCodexFailure(db, "r1");
  detail = storage.getRunDetails(db, "r1");
  expect(detail.codexFailReason).toBeNull();
  expect(detail.codexFailCategory).toBeNull();
});

test("host/provider metadata and Claude provider failures round-trip", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "r1", projectId: "p1", hostModel: "codex" });
  storage.recordClaudeFailure(db, "r1", "claude exited 1: 429 usage limit", "quota");

  expect(storage.resolveHostProvider(undefined, "claude")).toEqual({ hostModel: "codex", providerModel: "claude" });
  expect(storage.resolveHostProvider("codex", undefined)).toEqual({ hostModel: "codex", providerModel: "claude" });
  expect(() => storage.resolveHostProvider("codex", "codex")).toThrow("must be different");
  expect(storage.getRunDetails(db, "r1")).toMatchObject({
    hostModel: "codex",
    providerModel: "claude",
    claudeFailCategory: "quota",
    providerFailCategory: "quota",
  });

  storage.clearClaudeFailure(db, "r1");
  expect(storage.getRunDetails(db, "r1").providerFailReason).toBeNull();
});

test("startRun normalizes missing titles and preserves the original title on idempotent starts", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "explicit", projectId: "p1", title: "  Explicit title  " });
  storage.startRun(db, { runId: "missing", projectId: "p1" });
  storage.startRun(db, { runId: "blank", projectId: "p1", title: "   " });
  storage.startRun(db, { runId: "explicit", projectId: "p1", title: "Replacement title" });

  expect(storage.getRunDetails(db, "explicit").title).toBe("Explicit title");
  expect(storage.getRunDetails(db, "missing").title).toBe(storage.DEFAULT_RUN_TITLE);
  expect(storage.getRunDetails(db, "blank").title).toBe(storage.DEFAULT_RUN_TITLE);
});

test("putArtifact overwrites the selected embedded content column", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "r1", projectId: "p1" });
  storage.putArtifact(db, "r1", "plan", "v1");
  storage.putArtifact(db, "r1", "plan", "v2");
  expect(storage.getArtifact(db, "r1", "plan")).toBe("v2");
  expect(() => storage.parseArtifactType("review")).toThrow("invalid artifact type");
});

test("getRuns returns only lifecycle fields ordered by created_at", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "r-a", projectId: "p1" });
  storage.startRun(db, { runId: "r-b", projectId: "p1" });
  storage.putArtifact(db, "r-a", "brief", "large content must not enter the list response");
  db.query(`UPDATE runs SET created_at = ? WHERE id = ?`).run("2026-01-01T00:00:00.000Z", "r-a");
  db.query(`UPDATE runs SET created_at = ? WHERE id = ?`).run("2026-01-02T00:00:00.000Z", "r-b");

  const runs = storage.getRuns(db, "p1");
  expect(runs).toHaveLength(2);
  expect(runs.map((run) => run.runId)).toEqual(["r-b", "r-a"]);
  expect(runs[0]).toEqual({
    runId: "r-b",
    projectId: "p1",
    title: "Untitled run",
    status: "running",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  expect("brief" in runs[0]).toBe(false);
});

test("deleteRun removes the run and its embedded content", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "r1", projectId: "p1" });
  storage.putArtifact(db, "r1", "plan", "the plan");

  expect(storage.deleteRun(db, "r1")).toBe(true);
  expect(storage.getArtifact(db, "r1", "plan")).toBeNull();
  expect(storage.deleteRun(db, "missing")).toBe(false);
});

test("abortRun aborts a running run but refuses completed and already-aborted runs", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "run", projectId: "p1" });
  storage.startRun(db, { runId: "done", projectId: "p1" });
  storage.finishRun(db, "done");

  storage.abortRun(db, "run");
  expect(storage.getRunDetails(db, "run").status).toBe("aborted");
  expect(() => storage.abortRun(db, "run")).toThrow("already aborted");
  expect(() => storage.abortRun(db, "done")).toThrow("cannot abort a completed run");
  expect(() => storage.abortRun(db, "ghost")).toThrow("run not found");
});

test("finishRun refuses to complete an aborted run and leaves its status untouched", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/x" });
  storage.startRun(db, { runId: "discarded", projectId: "p1" });
  storage.abortRun(db, "discarded");

  expect(() => storage.finishRun(db, "discarded")).toThrow("cannot complete an aborted run");
  expect(storage.getRunDetails(db, "discarded").status).toBe("aborted");

  // A running run still completes normally.
  storage.startRun(db, { runId: "live", projectId: "p1" });
  storage.finishRun(db, "live");
  expect(storage.getRunDetails(db, "live").status).toBe("completed");
});

test("getIncompleteRuns lists only running runs newest-first with artifact presence and drop reason", async () => {
  const { db } = await freshDb();
  storage.ensureProject(db, { id: "p1", name: "proj", root: "/repo/proj" });
  storage.startRun(db, { runId: "old", projectId: "p1", title: "Old run" });
  storage.startRun(db, { runId: "new", projectId: "p1", title: "New run" });
  storage.startRun(db, { runId: "done", projectId: "p1", title: "Done run" });
  db.query(`UPDATE runs SET created_at = ? WHERE id = ?`).run("2026-01-01T00:00:00.000Z", "old");
  db.query(`UPDATE runs SET created_at = ? WHERE id = ?`).run("2026-01-02T00:00:00.000Z", "new");
  storage.finishRun(db, "done"); // completed → excluded from the incomplete list
  storage.putArtifact(db, "new", "brief", "the brief");
  storage.putArtifact(db, "new", "claude_report", "my leg");
  storage.recordCodexFailure(db, "new", "429 too many requests", "quota");

  const incomplete = storage.getIncompleteRuns(db);
  expect(incomplete.map((r) => r.runId)).toEqual(["new", "old"]); // newest first, no completed run
  const newRun = incomplete[0];
  expect(newRun.projectDir).toBe("/repo/proj");
  expect(newRun.artifacts).toEqual({ brief: true, claudeReport: true, codexReport: false, plan: false });
  expect(newRun.codexFailReason).toContain("429");
  expect(newRun.codexFailCategory).toBe("quota");

  // getRunStatusRecord returns any status (incl. completed) and null for an unknown id.
  expect(storage.getRunStatusRecord(db, "done")?.status).toBe("completed");
  expect(storage.getRunStatusRecord(db, "ghost")).toBeNull();
});

test("cold-start: concurrent opens don't crash or lose writes (busy_timeout ordering)", async () => {
  // Regression guard for the WAL/busy_timeout ordering bug: if busy_timeout is set AFTER
  // journal_mode=WAL, concurrent cold-start opens hit SQLITE_BUSY and lose writes. Each worker is a
  // fresh process (own connection) so they actually race on the first open.
  const dir = await makeTempDir();
  const dbFile = join(dir, "fusion.db");
  const storagePath = join(import.meta.dir, "../plugin/skills/fusion/storage.ts");
  const WORKERS = 6;
  const WRITES = 30;
  const workerSrc = (w: number) => `
    process.env.FUSION_DB = ${JSON.stringify(dbFile)};
    const s = await import(${JSON.stringify(storagePath)});
    const db = s.open();
    s.ensureProject(db, { id: "p1", name: "p", root: "/x" });
    for (let i = 0; i < ${WRITES}; i++) s.startRun(db, { runId: "w${w}-" + i, projectId: "p1" });
  `;

  const procs = Array.from({ length: WORKERS }, (_, w) =>
    Bun.spawn(["bun", "-e", workerSrc(w)], { stdout: "ignore", stderr: "ignore" }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  expect(codes.every((c) => c === 0)).toBe(true);

  process.env.FUSION_DB = dbFile;
  expect(storage.getRuns(storage.open(), "p1")).toHaveLength(WORKERS * WRITES);
});

test("parseStringArgs accepts equals syntax and rejects missing, unknown, or command-irrelevant options", async () => {
  // Covers the shared arg parser (lib/args.ts), used by runner.ts and fusion.ts's CLIs. The success
  // path is pure, so it runs in-process; the rejection paths call process.exit(2), so they run in a
  // subprocess (an in-process exit would kill this test runner).
  const OPTS = ["run-id", "project-dir", "title"] as const;

  const ok = parseStringArgs(["--run-id=equals-r1", "--project-dir=/tmp/x", "--title=Equals title"], OPTS, "test");
  expect(ok["run-id"]).toBe("equals-r1");
  expect(ok.title).toBe("Equals title");

  const argsPath = join(import.meta.dir, "../plugin/skills/fusion/lib/args.ts");
  for (const badArgs of [
    ["--run-id"], // missing value
    ["--run-idd", "typo"], // unknown option
    ["--type", "brief"], // option not in this command's set
  ]) {
    const src = `
      const { parseStringArgs } = await import(${JSON.stringify(argsPath)});
      parseStringArgs(${JSON.stringify(badArgs)}, ${JSON.stringify(OPTS)}, "test");
    `;
    const proc = Bun.spawn(["bun", "-e", src], { stdout: "ignore", stderr: "pipe" });
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(error.length).toBeGreaterThan(0);
  }
});
