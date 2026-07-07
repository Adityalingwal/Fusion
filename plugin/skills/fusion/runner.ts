#!/usr/bin/env bun
// Fusion runner (v1) — orchestrates the EXTERNAL relay of a Fusion run:
//   - Codex via `codex exec`  (ChatGPT subscription → zero API cost)
//
// It deliberately does NOT run the Claude leg or the synthesis. The host Claude Code session
// contributes its own (Claude) leg and does the final synthesis via the skill — a runner subprocess
// cannot capture its parent session anyway. So the runner's whole job is the deterministic part: run
// Codex with a hard timeout, FAIL-OPEN (relay down → note the drop, synthesize with what's available),
// and persist the raw report to the SHARED SQLite store (skills/fusion/storage.ts).
// NOTHING is written into the project dir. It prints a JSON summary as the last stdout line so the
// skill can read what happened.
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

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import { runCodexLeg } from "./runner/codex";
import { parseStringArgs, type StringArgs } from "./lib/args";
import * as storage from "./storage";

const RUNNER_ARG_NAMES = ["run-id", "title", "project-dir", "brief-file", "timeout-ms"] as const;

function resolvePath(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : join(baseDir, p);
}

// A bad --timeout-ms / FUSION_TIMEOUT_MS (NaN, 0, negative) used to flow straight into setTimeout,
// which fires ~immediately and instant-kills codex → a silent single-model run. Validate to a safe
// default and warn loudly instead.
// Ceiling, not a fixed wait: runProc returns the instant codex exits (subprocess.ts raceDeadline),
// so a larger default never slows a fast run — it only gives a genuinely long plan room to finish
// before the fail-open SIGTERM. 12 min balances that headroom against how long a truly-hung leg
// stalls the host at SKILL.md step 7. Override per-run via --timeout-ms / FUSION_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 720_000;
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const t = Number(raw);
  if (Number.isFinite(t) && t > 0) return t;
  console.error(`fusion-runner: invalid timeout '${raw}' — using default ${DEFAULT_TIMEOUT_MS}ms`);
  return DEFAULT_TIMEOUT_MS;
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

async function main(): Promise<void> {
  const args = parseStringArgs(process.argv.slice(2), RUNNER_ARG_NAMES, "fusion-runner");
  const runId = args["run-id"] || crypto.randomUUID();
  const invocationDir = process.cwd();
  const projectDir = args["project-dir"] ? resolvePath(invocationDir, args["project-dir"]) : invocationDir;
  const timeoutMs = parseTimeoutMs(args["timeout-ms"] || process.env.FUSION_TIMEOUT_MS);

  const db = storage.open();
  const proj = await storage.resolveProject(projectDir);
  storage.ensureProject(db, proj);

  const brief = await readBrief(db, runId, args, projectDir);
  if (!brief.trim()) {
    console.error("fusion-runner: empty brief (use --brief-file <path> or pipe on stdin)");
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

  // Machine-readable summary as the LAST stdout line (the skill parses this).
  const summary = codex.status === "ok"
    ? { runId, codexAvailable: true }
    : { runId, codexAvailable: false, reason: codex.reason };
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  console.error("fusion-runner: fatal —", err);
  process.exit(1);
});
