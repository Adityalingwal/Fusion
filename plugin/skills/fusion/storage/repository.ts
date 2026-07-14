import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { runText } from "../lib/subprocess";
import { now } from "./db";

// Reuse the shared timeout-bounded runText — the hand-rolled spawn here dropped the timeout, so a
// hung git would hang every resolveProject indefinitely.
async function gitToplevel(dir: string): Promise<string | null> {
  const out = await runText(["git", "rev-parse", "--show-toplevel"], dir, 10_000);
  return out?.split("\n")[0]?.trim() || null;
}

export interface Project {
  id: string;
  name: string;
  root: string;
}

export async function resolveProject(dir: string): Promise<Project> {
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  const root = (await gitToplevel(abs)) || abs;
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return { id, name: basename(root), root };
}

export function ensureProject(db: Database, p: Project): void {
  db.query(
    `INSERT INTO projects (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path`,
  ).run(p.id, p.name, p.root, now());
}

// One row per project for the multi-project sidebar. Aggregates run count + last activity in a
// single LEFT JOIN so the tree can render every project (even zero-run ones) and sort by recency
// without a per-project follow-up query. Deliberately excludes run rows and artifact bodies — the
// sidebar loads a project's runs lazily (getRuns) only when its folder is expanded.
export interface ProjectSummary {
  id: string;
  name: string;
  runCount: number;
  // ISO timestamp of the most recent run, or the project's own created_at when it has no runs.
  lastActivity: string;
}

export function getProjects(db: Database): ProjectSummary[] {
  const rows = db
    .query(
      `SELECT p.id AS id, p.name AS name, p.created_at AS created_at,
              COUNT(r.id) AS run_count, MAX(r.created_at) AS last_run_at
       FROM projects p
       LEFT JOIN runs r ON r.project_id = p.id
       GROUP BY p.id, p.name, p.created_at`,
    )
    .all() as Array<{
    id: string;
    name: string | null;
    created_at: string | null;
    run_count: number;
    last_run_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? r.id,
    runCount: r.run_count,
    lastActivity: r.last_run_at ?? r.created_at ?? "",
  }));
}

// Look up a single project by id — used to label a run's detail header with its OWN project name,
// which can differ from the project the dashboard was launched from now that the sidebar spans all
// projects. Returns null if the id is unknown.
export function getProject(db: Database, id: string): Project | null {
  const row = db.query(`SELECT id, name, root_path FROM projects WHERE id = ?`).get(id) as
    | { id: string; name: string | null; root_path: string | null }
    | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name ?? row.id, root: row.root_path ?? "" };
}

export const ARTIFACT_TYPES = ["brief", "claude_report", "codex_report", "plan"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const DEFAULT_RUN_TITLE = "Untitled run";

const artifactColumns: Record<ArtifactType, ArtifactType> = {
  brief: "brief",
  claude_report: "claude_report",
  codex_report: "codex_report",
  plan: "plan",
};

export function parseArtifactType(value: string): ArtifactType {
  if ((ARTIFACT_TYPES as readonly string[]).includes(value)) return value as ArtifactType;
  throw new Error(`invalid artifact type '${value}'; expected one of: ${ARTIFACT_TYPES.join(", ")}`);
}

export function startRun(
  db: Database,
  args: { runId: string; projectId: string; title?: string },
): void {
  const title = args.title?.trim() || DEFAULT_RUN_TITLE;
  db.query(
    `INSERT INTO runs (id, project_id, title, status, created_at)
     VALUES (?, ?, ?, 'running', ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(args.runId, args.projectId, title, now());
}

export function finishRun(db: Database, runId: string): void {
  const res = db.query(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(runId);
  if (res.changes === 0) console.error(`finishRun: matched no run — unknown id '${runId}'`);
}

// The category the runner attaches to a dropped Codex leg (see runner/codex.ts classifyCodexFailure).
export const CODEX_FAIL_CATEGORIES = ["transient", "quota", "fixable", "unknown"] as const;
export type CodexFailCategory = (typeof CODEX_FAIL_CATEGORIES)[number];

// Persist WHY the Codex leg dropped onto the run row. Replaces the old fake "# Codex — UNAVAILABLE"
// placeholder artifact: a codex_report in the DB is now always a real report, and the failure lives
// here instead so `status` / the dashboard can still explain the drop. Warns (never throws) on a
// missing row — this is called from the failure path, where a second throw would bury the real cause.
export function recordCodexFailure(db: Database, runId: string, reason: string, category: CodexFailCategory): void {
  const res = db
    .query(`UPDATE runs SET codex_fail_reason = ?, codex_fail_category = ? WHERE id = ?`)
    .run(reason, category, runId);
  if (res.changes === 0) console.error(`recordCodexFailure: matched no run — unknown id '${runId}'`);
}

// Clear a previously-recorded Codex failure — called when a later leg succeeds (the retry/resume
// case) so a stale drop reason never lingers on a now-healthy run.
export function clearCodexFailure(db: Database, runId: string): void {
  db.query(`UPDATE runs SET codex_fail_reason = NULL, codex_fail_category = NULL WHERE id = ?`).run(runId);
}

export function putArtifact(db: Database, runId: string, type: ArtifactType, content: string): void {
  const column = artifactColumns[type];
  const res = db.query(`UPDATE runs SET ${column} = ? WHERE id = ?`).run(content, runId);
  if (res.changes === 0) throw new Error(`run not found: ${runId}`);
}

export function getArtifact(db: Database, runId: string, type: ArtifactType): string | null {
  const column = artifactColumns[type];
  const row = db.query(`SELECT ${column} AS content FROM runs WHERE id = ?`).get(runId) as
    | { content: string | null }
    | undefined;
  return row?.content ?? null;
}

export interface RunSummary {
  runId: string;
  projectId: string;
  title: string;
  status: string;
  createdAt: string;
}

// projectId is required: every run view is project-scoped. An optional all-projects branch was a
// latent scoping foot-gun (a no-arg call would leak every project's runs) and had no callers.
export function getRuns(db: Database, projectId: string): RunSummary[] {
  const rows = db
    .query(`SELECT id, project_id, title, status, created_at FROM runs WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as Array<{ id: string; project_id: string; title: string; status: string; created_at: string }>;
  return rows.map((r) => ({
    runId: r.id,
    projectId: r.project_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function getRunDetails(db: Database, runId: string) {
  const run = db
    .query(
      `SELECT id, project_id, title, status, created_at, brief, claude_report, codex_report, plan,
              codex_fail_reason, codex_fail_category
       FROM runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        project_id: string;
        title: string;
        status: string;
        created_at: string;
        brief: string | null;
        claude_report: string | null;
        codex_report: string | null;
        plan: string | null;
        codex_fail_reason: string | null;
        codex_fail_category: string | null;
      }
    | undefined;
  if (!run) throw new Error(`run not found: ${runId}`);
  return {
    runId: run.id,
    projectId: run.project_id,
    title: run.title,
    status: run.status,
    createdAt: run.created_at,
    brief: run.brief,
    claudeReport: run.claude_report,
    codexReport: run.codex_report,
    plan: run.plan,
    codexFailReason: run.codex_fail_reason,
    codexFailCategory: run.codex_fail_category,
  };
}

export function deleteRun(db: Database, runId: string): boolean {
  const res = db.query(`DELETE FROM runs WHERE id = ?`).run(runId);
  return res.changes > 0;
}

// Direct PK lookup for an ownership check — avoids scanning + JSON-parsing every run just to test
// whether one id belongs to a project. Returns null if the run doesn't exist.
export function getRunProjectId(db: Database, runId: string): string | null {
  const row = db.query(`SELECT project_id FROM runs WHERE id = ?`).get(runId) as
    | { project_id: string }
    | undefined;
  return row?.project_id ?? null;
}
