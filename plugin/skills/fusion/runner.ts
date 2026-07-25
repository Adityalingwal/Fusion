#!/usr/bin/env bun
// Fusion runner (v1) — orchestrates the EXTERNAL Codex legs of a Fusion run
// (via `codex exec` — ChatGPT subscription → zero API cost). Two legs, selected by --leg:
//   - relay (default): the blind Codex planning leg (steps 4-6)
//   - advisor: the blind final check of the synthesized plan (step 8)
//
// It deliberately does NOT run the Claude leg or the synthesis. The host Claude Code session
// contributes its own (Claude) leg and does the final synthesis via the skill — a runner subprocess
// cannot capture its parent session anyway. So the runner's whole job is the deterministic part: run
// Codex with a hard timeout and persist the raw report to the SHARED SQLite store
// (skills/fusion/storage.ts). If Codex drops, the runner does NOT fabricate a report or silently
// degrade the run — it records the drop reason + a category (transient|quota|fixable|unknown) on the
// run row and surfaces both in its JSON summary, so the skill can let the USER choose what happens
// next (retry / resume later / single-model / abort). The runner itself stays fail-safe as a PROCESS:
// it always prints its JSON summary line and never crashes without one.
// NOTHING is written into the project dir.
//
// Brief source (priority): the run's stored `brief` for --run-id · else --brief-file · else stdin.
// Storage: the run row and its content live in ~/.fusion/fusion.db (FUSION_DB).
// Two-writer model: the runner writes the Codex report; the host writes the rest. SQLite
// WAL + busy_timeout (set in storage.ts) makes that safe. The runner leaves the run `status=running`;
// the HOST flips it to completed after synthesis.
//
// Usage:
//   bun runner.ts --run-id <id> [--title <title>] [--project-dir <dir>] [--brief-file <path>]
//                 [--timeout-ms <n>]
//   (the brief may also be piped on stdin instead of --brief-file)
//   bun runner.ts --leg advisor --run-id <id> [--timeout-ms <n>]
//   (the advisor leg reads everything — including the project dir — from the DB)

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import { runCodexLeg } from "./runner/codex";
import { DEFAULT_ADVISOR_TIMEOUT_MS, runAdvisorLeg } from "./runner/advisor";
import { parseStringArgs, type StringArgs } from "./lib/args";
import * as storage from "./storage";

const RUNNER_ARG_NAMES = ["leg", "run-id", "title", "project-dir", "brief-file", "timeout-ms"] as const;

function resolvePath(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : join(baseDir, p);
}

// A bad --timeout-ms / FUSION_TIMEOUT_MS (NaN, 0, negative) used to flow straight into setTimeout,
// which fires ~immediately and instant-kills codex → a silent single-model run. Validate to a safe
// default and warn loudly instead.
// Ceiling, not a fixed wait: runProc returns the instant codex exits (subprocess.ts raceDeadline),
// so a larger default never slows a fast run — it only gives a genuinely long plan room to finish
// before the timeout SIGTERM. 20 min balances that headroom against how long a truly-hung leg
// stalls the host at SKILL.md step 6. Override per-run via --timeout-ms / FUSION_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 1_200_000;
function parseTimeoutMs(raw: string | undefined, defaultMs: number): number {
  if (raw === undefined) return defaultMs;
  const t = Number(raw);
  if (Number.isFinite(t) && t > 0) return t;
  console.error(`fusion-runner: invalid timeout '${raw}' — using default ${defaultMs}ms`);
  return defaultMs;
}

// Brief source: the persisted DB artifact first (the host writes it before launching us), then
// --brief-file, then stdin. Whichever wins is also persisted so the dashboard always shows it.
async function readBrief(
  db: Database,
  runId: string,
  args: StringArgs,
  projectDir: string,
): Promise<string> {
  // Return the exact stored bytes. The emptiness check trims only to decide whether content exists.
  const fromDb = storage.getArtifact(db, runId, "brief");
  if (fromDb && fromDb.trim()) {
    if (args["brief-file"]) {
      console.error(`fusion-runner: --brief-file ignored — using the stored 'brief' artifact for ${runId}`);
    }
    return fromDb;
  }
  if (args["brief-file"]) {
    return await readFile(resolvePath(projectDir, args["brief-file"]), "utf8");
  }
  return await Bun.stdin.text();
}

// Hoisted so the fatal-path handlers below can attach them to the receipt. runId is null until
// parsed — a crash before parsing still emits a receipt, just with runId: null.
let runId: string | null = null;
let leg: "relay" | "advisor" = "relay";

// The runner's hard spec constraint: it must ALWAYS end with a machine-readable JSON summary line on
// stdout, even on a fatal path, so the host gets a reason + category instead of a bare exit code.
// The availability key matches the leg's summary contract (codexAvailable vs advisorAvailable).
function printReceipt(reason: string): void {
  const availability = leg === "advisor" ? { advisorAvailable: false } : { codexAvailable: false };
  console.log(JSON.stringify({ runId, ...availability, reason, category: "unknown" }));
}

// The advisor leg. Unlike relay, the project dir is resolved from the DB (the run's stored
// projects.root_path), NEVER from the invocation cwd — a resumed session elsewhere would silently
// point codex at the wrong repo. The advise CLI enforces the run-exists + brief/plan ordering
// guard before spawning us; runAdvisorLeg backstops both.
async function advisorMain(args: StringArgs): Promise<void> {
  const db = storage.open();
  const projectId = storage.getRunProjectId(db, runId!);
  const projectDir = projectId === null ? null : storage.getProject(db, projectId)?.root || null;
  if (projectDir === null) {
    const reason = projectId === null ? `run not found: ${runId}` : `project directory unknown for run ${runId}`;
    console.error(`fusion-runner: ${reason}`);
    printReceipt(reason);
    process.exit(2);
  }
  const timeoutMs = parseTimeoutMs(args["timeout-ms"], DEFAULT_ADVISOR_TIMEOUT_MS);

  console.error(`fusion-runner: advisor for run ${runId} → ${storage.dbPath()}`);
  console.error(`fusion-runner: launching codex advisor (timeout ${timeoutMs}ms)…`);

  const advisor = await runAdvisorLeg(db, runId!, projectDir, timeoutMs);

  console.error(`fusion-runner: advisor=${advisor.status}${advisor.mode ? ` (mode ${advisor.mode})` : ""}`);
  if (advisor.status === "failed") console.error(`  advisor dropped: ${advisor.reason}`);

  const summary = advisor.status === "ok"
    ? { runId, advisorAvailable: true, mode: advisor.mode, verdict: advisor.verdict, ...(advisor.degradedReason ? { degradedReason: advisor.degradedReason } : {}) }
    : { runId, advisorAvailable: false, ...(advisor.mode ? { mode: advisor.mode } : {}), ...(advisor.degradedReason ? { degradedReason: advisor.degradedReason } : {}), reason: advisor.reason, category: advisor.category };
  console.log(JSON.stringify(summary));
}

async function main(): Promise<void> {
  const args = parseStringArgs(process.argv.slice(2), RUNNER_ARG_NAMES, "fusion-runner");
  runId = args["run-id"] || crypto.randomUUID();
  if (args.leg === "advisor") {
    leg = "advisor";
    await advisorMain(args);
    return;
  }
  const invocationDir = process.cwd();
  const projectDir = args["project-dir"] ? resolvePath(invocationDir, args["project-dir"]) : invocationDir;
  const timeoutMs = parseTimeoutMs(args["timeout-ms"] || process.env.FUSION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const db = storage.open();
  const proj = await storage.resolveProject(projectDir);
  storage.ensureProject(db, proj);

  const brief = await readBrief(db, runId, args, projectDir);
  if (!brief.trim()) {
    const reason = "empty brief (use --brief-file <path> or pipe on stdin)";
    console.error(`fusion-runner: ${reason}`);
    printReceipt(reason);
    process.exit(2);
  }
  // Idempotent: the host normally creates the run + brief first, but make the runner self-contained.
  storage.startRun(db, { runId, projectId: proj.id, title: args.title });
  if (!storage.getArtifact(db, runId, "brief")) storage.putArtifact(db, runId, "brief", brief);

  console.error(`fusion-runner: run ${runId} (project ${proj.id}) → ${storage.dbPath()}`);
  console.error(`fusion-runner: launching codex (timeout ${timeoutMs}ms)…`);

  const codex = await runCodexLeg(db, brief, runId, projectDir, timeoutMs);

  console.error(`fusion-runner: codex=${codex.status}`);
  if (codex.status === "failed") console.error(`  codex dropped: ${codex.reason}`);
  if (codex.formatWarning) console.error("  codex: format_warning — report missing the requested ## sections");

  // Machine-readable summary as the LAST stdout line (the skill parses this). On a drop it carries
  // BOTH the raw reason and its category so the skill can present the right choice menu.
  const summary = codex.status === "ok"
    ? { runId, codexAvailable: true }
    : { runId, codexAvailable: false, reason: codex.reason, category: codex.category };
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error("fusion-runner: fatal —", err);
  printReceipt(reason);
  process.exit(1);
});
