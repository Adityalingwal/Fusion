#!/usr/bin/env bun
// Fusion runner — orchestrates the EXTERNAL provider leg of a Fusion run:
//   - Claude host → Codex via `codex exec`
//   - Codex host  → Claude via `claude -p`
//
// The host supplies its own blind report and performs synthesis; this subprocess only runs the
// selected external provider with a hard timeout and persists its raw report to the shared SQLite
// store. A provider drop never creates a placeholder report: the runner records the reason/category
// in that provider's failure columns and returns both in its JSON summary so the skill can offer
// retry / resume later / single-model / abort. The runner itself stays fail-safe as a process:
// it always prints its JSON summary line and never crashes without one.
// NOTHING is written into the project dir.
//
// Brief source (priority): the run's stored `brief` for --run-id · else --brief-file · else stdin.
// Storage: the run row and its content live in ~/.fusion/fusion.db (FUSION_DB).
// Two-writer model: the runner writes the provider report; the host writes the rest. SQLite
// WAL + busy_timeout (set in storage.ts) makes that safe. The runner leaves the run `status=running`;
// the HOST flips it to completed after synthesis.
//
// Usage:
//   bun runner.ts --run-id <id> [--host <claude|codex>] [--provider <codex|claude>]
//                 [--title <title>] [--project-dir <dir>] [--brief-file <path>] [--timeout-ms <n>]
//   (the brief may also be piped on stdin instead of --brief-file)

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import { runCodexLeg } from "./runner/codex";
import { runClaudeLeg } from "./runner/claude";
import { parseStringArgs, type StringArgs } from "./lib/args";
import * as storage from "./storage";

const RUNNER_ARG_NAMES = ["run-id", "title", "project-dir", "brief-file", "timeout-ms", "host", "provider"] as const;

function resolvePath(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : join(baseDir, p);
}

// A bad --timeout-ms / FUSION_TIMEOUT_MS (NaN, 0, negative) used to flow straight into setTimeout,
// which fires ~immediately and instant-kills the provider → a silent single-model run. Validate to a safe
// default and warn loudly instead.
// Ceiling, not a fixed wait: runProc returns the instant codex exits (subprocess.ts raceDeadline),
// so a larger default never slows a fast run — it only gives a genuinely long report room to finish
// before the timeout SIGTERM. 12 min balances that headroom against how long a truly-hung leg
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

// Hoisted so the fatal-path handlers below can attach it to the receipt. Null until parsed — a crash
// before parsing still emits a receipt, just with runId: null.
let runId: string | null = null;
let receiptProvider: storage.ProviderModel = "codex";

// The runner's hard spec constraint: it must ALWAYS end with a machine-readable JSON summary line on
// stdout, even on a fatal path, so the host gets a reason + category instead of a bare exit code.
function printReceipt(reason: string): void {
  const availability = receiptProvider === "codex" ? { codexAvailable: false } : { claudeAvailable: false };
  console.log(JSON.stringify({ runId, ...availability, reason, category: "unknown" }));
}

function resolveSelection(
  db: Database,
  id: string,
  args: StringArgs,
): { hostModel: storage.HostModel; providerModel: storage.ProviderModel } {
  const storedHost = storage.getRunHostModel(db, id);
  const hasExplicitSelection = args.host !== undefined || args.provider !== undefined;
  if (storedHost === null) return storage.resolveHostProvider(args.host, args.provider);

  const stored = { hostModel: storedHost, providerModel: storage.oppositeModel(storedHost) };
  if (!hasExplicitSelection) return stored;
  const requested = storage.resolveHostProvider(args.host, args.provider);
  if (requested.hostModel !== stored.hostModel || requested.providerModel !== stored.providerModel) {
    throw new Error(
      `host/provider mismatch for ${id}: stored ${stored.hostModel}/${stored.providerModel}, requested ${requested.hostModel}/${requested.providerModel}`,
    );
  }
  return stored;
}

async function main(): Promise<void> {
  const args = parseStringArgs(process.argv.slice(2), RUNNER_ARG_NAMES, "fusion-runner");
  runId = args["run-id"] || crypto.randomUUID();
  // Resolve an explicitly requested provider before opening SQLite. If opening the DB itself fails,
  // the fatal receipt must still use the correct availability key (for example claudeAvailable for
  // a Codex-hosted run), rather than the legacy Codex default.
  if (args.host !== undefined || args.provider !== undefined) {
    receiptProvider = storage.resolveHostProvider(args.host, args.provider).providerModel;
  }
  const invocationDir = process.cwd();
  const projectDir = args["project-dir"] ? resolvePath(invocationDir, args["project-dir"]) : invocationDir;
  const timeoutMs = parseTimeoutMs(args["timeout-ms"] || process.env.FUSION_TIMEOUT_MS);

  const db = storage.open();
  const selection = resolveSelection(db, runId, args);
  receiptProvider = selection.providerModel;
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
  storage.startRun(db, { runId, projectId: proj.id, title: args.title, hostModel: selection.hostModel });
  if (!storage.getArtifact(db, runId, "brief")) storage.putArtifact(db, runId, "brief", brief);

  console.error(`fusion-runner: run ${runId} (project ${proj.id}) → ${storage.dbPath()}`);
  console.error(`fusion-runner: launching ${selection.providerModel} (timeout ${timeoutMs}ms)…`);

  const leg = selection.providerModel === "codex"
    ? await runCodexLeg(db, brief, runId, projectDir, timeoutMs)
    : await runClaudeLeg(db, brief, runId, projectDir, timeoutMs);

  console.error(`fusion-runner: ${selection.providerModel}=${leg.status}`);
  if (leg.status === "failed") console.error(`  ${selection.providerModel} dropped: ${leg.reason}`);
  if (leg.formatWarning) console.error(`  ${selection.providerModel}: format_warning — report missing the requested ## sections`);

  // Machine-readable summary as the LAST stdout line (the skill parses this). On a drop it carries
  // BOTH a safe reason and its category so the skill can present the right choice menu. Provider
  // output itself is never part of the Claude failure receipt because it could break the blind rule.
  const availability = selection.providerModel === "codex" ? "codexAvailable" : "claudeAvailable";
  const summary = leg.status === "ok"
    ? { runId, [availability]: true }
    : { runId, [availability]: false, reason: leg.reason, category: leg.category };
  console.log(JSON.stringify(summary));
}

main().catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error("fusion-runner: fatal —", err);
  printReceipt(reason);
  process.exit(1);
});
