import { Database } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../storage";
import { lastStderr, runProc } from "../lib/subprocess";
import {
  NOT_INSTALLED_PATTERN,
  NOT_LOGGED_IN_PATTERN,
  QUOTA_PATTERN,
  STALE_CLI_PATTERN,
  buildCodexArgs,
  classifyCodexFailure,
  extractCodexError,
} from "./codex";
import {
  buildAdvisorPrompt,
  extractVerdict,
  selectAdvisorMode,
  type AdvisorMode,
  type Verdict,
} from "./advisorPrompt";

import type { CodexFailCategory } from "../storage";

// Ceiling, not a fixed wait (same semantics as the relay's — runProc returns the instant codex
// exits). 15 min: the advisor reviews four documents and may verify claims against the repo/web,
// which runs longer than a preflight ping but shorter than a full planning leg.
export const DEFAULT_ADVISOR_TIMEOUT_MS = 900_000;

export interface AdvisorLegResult {
  status: "ok" | "failed";
  mode?: AdvisorMode;
  degradedReason?: "size";
  verdict?: Verdict;
  reason?: string;
  category?: CodexFailCategory;
}

// Unique per attempt: pid + a UUID, so concurrent invocations for the same run can never race on
// one file. The runId is sanitized before it becomes a filesystem path (same rule as the relay leg:
// anything but [A-Za-z0-9._-] → "_", leaving no "/" to traverse with).
export function advisorOutPath(runId: string): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(tmpdir(), `fusion-advisor-${safeRunId}-${process.pid}-${crypto.randomUUID()}.txt`);
}

// The advisor reuses the relay's failure CLASSIFICATION (classifyCodexFailure) and its detection
// patterns (shared constants in runner/codex.ts) but not its message text: advisor reasons are
// single-line and advise-appropriate — the host shows exactly one plain line and the fix is
// "re-run advise", never "run /fusion again".
export function advisorFailureReason(message: string): string {
  const oneLine = message.replace(/\s*\n\s*/g, " ").trim();
  if (QUOTA_PATTERN.test(oneLine)) {
    return "GPT quota exhausted — re-run advise after it resets";
  }
  if (NOT_INSTALLED_PATTERN.test(oneLine)) {
    return "Codex isn't installed (or not on PATH) — install: npm i -g @openai/codex, then: codex login";
  }
  if (STALE_CLI_PATTERN.test(oneLine)) {
    return "Codex CLI is stale — update: npm i -g @openai/codex@latest, then re-run advise";
  }
  if (NOT_LOGGED_IN_PATTERN.test(oneLine)) {
    return "Codex isn't logged in — run: codex login, then re-run advise";
  }
  return oneLine;
}

// Blind final check of the synthesized plan via `codex exec` — the advisor leg, mirroring
// runCodexLeg's transport exactly (stdin prompt, -o temp file, timeout ceiling, finally-delete).
// It reads all documents from the DB itself: the advisor process NEVER gets DB access, run ids, or
// file paths to fetch — only the assembled packet on stdin. Fail-open by design: every failure
// (including the size skip and a malformed verdict) records a marker on the run row and returns
// `failed`; the host shows one line and the flow continues.
export async function runAdvisorLeg(
  db: Database,
  runId: string,
  projectDir: string,
  timeoutMs: number,
): Promise<AdvisorLegResult> {
  const brief = storage.getArtifact(db, runId, "brief");
  const plan = storage.getArtifact(db, runId, "plan");
  if (brief === null || plan === null) {
    // The advise CLI's ordering guard refuses before spawning us; this is the standalone backstop.
    const reason = plan === null ? "plan missing — save the plan draft first" : "brief missing — save the brief first";
    storage.recordAdvisorFailure(db, runId, reason, "fixable");
    return { status: "failed", reason, category: "fixable" };
  }
  const docs = {
    brief,
    plan,
    claudeReport: storage.getArtifact(db, runId, "claude_report"),
    codexReport: storage.getArtifact(db, runId, "codex_report"),
  };
  const { mode, degradedReason } = selectAdvisorMode(docs);
  if (mode === "skip") {
    const reason = "brief + plan alone exceed 500 KB — advisor skipped";
    storage.recordAdvisorFailure(db, runId, reason, "unknown");
    return { status: "failed", mode, reason, category: "unknown" };
  }
  const prompt = buildAdvisorPrompt(mode, docs);
  const outPath = advisorOutPath(runId);
  try {
    const res = await runProc(
      ["codex", ...buildCodexArgs(projectDir, outPath)],
      { stdin: prompt, timeoutMs, cwd: projectDir },
    );
    if (res.timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
    if (res.code !== 0) {
      // Same two-channel extraction as the relay leg (stdout JSON error events + stderr tail),
      // minus actionableHint — advisorFailureReason rewrites the message in the catch below.
      const stdoutErr = extractCodexError(res.stdout);
      const stderrTail = res.stderr.trim() ? lastStderr(res.stderr) : null;
      const detail = [stdoutErr, stderrTail].filter(Boolean).join(" | ") || "no error output";
      throw new Error(res.code === null ? `codex could not start: ${detail}` : `codex exited ${res.code}: ${detail}`);
    }
    let text: string;
    try {
      text = (await readFile(outPath, "utf8")).trim();
    } catch (readErr) {
      throw new Error(`could not read codex output: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
    }
    // Malformed OR empty verdict: the raw text is STILL saved (debugging) — saved FIRST, so an
    // empty output also evicts a stale previous report and the on-demand fetch always shows the
    // latest attempt. The failure marker stays set so the host never folds it — resume decides by
    // the marker, not by artifact presence.
    storage.putArtifact(db, runId, "advisor_report", text);
    const verdict = extractVerdict(text);
    if (verdict === null) {
      const reason = "malformed verdict — the advisor output has no VERDICT line";
      storage.recordAdvisorFailure(db, runId, reason, "unknown");
      return { status: "failed", mode, degradedReason, reason, category: "unknown" };
    }
    storage.clearAdvisorFailure(db, runId);
    return { status: "ok", mode, degradedReason, verdict };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // A failed retry keeps any previously stored advisor_report (one slot, always latest VALID or
    // latest raw) — only the marker is stamped, which is what invalidates the slot for folding.
    const category = classifyCodexFailure(raw);
    const reason = advisorFailureReason(raw);
    storage.recordAdvisorFailure(db, runId, reason, category);
    return { status: "failed", mode, degradedReason, reason, category };
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}
