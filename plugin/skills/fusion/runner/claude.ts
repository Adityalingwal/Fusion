import { Database } from "bun:sqlite";
import * as storage from "../storage";
import { lastStderr, runProc } from "../lib/subprocess";
import { LEG_ROLE_PREAMBLE, countSections, isHollowReport } from "./shared";

import type { ClaudeFailCategory } from "../storage";

export interface ClaudeLegResult {
  status: "ok" | "failed";
  reason?: string;
  category?: ClaudeFailCategory;
  formatWarning?: boolean;
}

export function buildClaudeArgs(): string[] {
  // Keep Fusion out of Claude's model/tool/prompt decisions. The brief is stdin; these flags only
  // make the one-shot provider invocation planning-safe and prevent raw session persistence.
  return ["-p", "--permission-mode", "plan", "--no-session-persistence"];
}

export function classifyClaudeFailure(reason: string): ClaudeFailCategory {
  const value = reason.toLowerCase();
  if (/insufficient credit|usage limit|rate limit|\b429\b|too many requests|quota|max budget/.test(value)) {
    return "quota";
  }
  if (
    /not logged in|loggedin[^a-z]*false|not authenticated|unauthorized|\b401\b|unexpected argument|unknown option|unrecognized option|executable not found|not found in \$?path|\benoent\b|no such file/.test(
      value,
    )
  ) {
    return "fixable";
  }
  // Likely to succeed on a plain retry: timeouts, network blips, 5xx — and a hollow/off-task report
  // (the model wandered; the same relay usually lands on retry, verified live on run d7eed0a0).
  if (/hollow report|timed out|timeout|network|connection|econn|socket|stream error|\b5(?:00|02|03|04)\b|server error/.test(value)) {
    return "transient";
  }
  return "unknown";
}

export function claudeActionableHint(message: string): string {
  if (/insufficient credit|usage limit|quota|\b429\b|too many requests|rate limit|max budget/i.test(message)) {
    return `${message}\n  → Claude usage is exhausted — wait for it to reset, then run /fusion again.`;
  }
  if (/executable not found|not found in \$?path|\benoent\b|no such file/i.test(message)) {
    return `${message}\n  → Claude Code isn't installed (or not on PATH). Install it, then run: claude auth login`;
  }
  if (/not logged in|loggedin[^a-z]*false|not authenticated|unauthorized|\b401\b/i.test(message)) {
    return `${message}\n  → Run: claude auth login`;
  }
  if (/unexpected argument|unknown option|unrecognized option/i.test(message)) {
    return `${message}\n  → Your Claude Code CLI is incompatible/stale. Update it, then run /fusion again.`;
  }
  return message;
}

function safeClaudeFailureReason(code: number | null, category: ClaudeFailCategory): string {
  const prefix = code === null ? "claude could not start" : `claude exited ${code}`;
  const summary: Record<ClaudeFailCategory, string> = {
    quota: "usage limit or quota error",
    fixable: "authentication, installation, or CLI compatibility error",
    transient: "temporary network or service error",
    unknown: "provider error",
  };
  return `${prefix}: ${summary[category]}`;
}

export async function runClaudeLeg(
  db: Database,
  brief: string,
  runId: string,
  projectDir: string,
  timeoutMs: number,
): Promise<ClaudeLegResult> {
  try {
    // Role preamble rides the relayed stdin ONLY — the stored `brief` artifact stays exactly what
    // the host wrote (see runner/shared.ts).
    const result = await runProc(["claude", ...buildClaudeArgs()], {
      stdin: `${LEG_ROLE_PREAMBLE}\n\n${brief}`,
      timeoutMs,
      cwd: projectDir,
    });
    if (result.timedOut) {
      const reason = `claude timed out after ${timeoutMs}ms`;
      storage.recordClaudeFailure(db, runId, reason, "transient");
      return { status: "failed", reason, category: "transient" };
    }
    if (result.code !== 0) {
      // Claude can emit a partial report on stdout before failing. Use both streams only to classify
      // the failure; never persist or return either raw stream, otherwise the blind Codex host could
      // see provider content before saving its own report.
      const rawDetail = [result.stdout.trim(), result.stderr.trim() ? lastStderr(result.stderr) : null]
        .filter(Boolean)
        .join(" | ") || "no error output";
      const category = classifyClaudeFailure(rawDetail);
      const reason = safeClaudeFailureReason(result.code, category);
      storage.recordClaudeFailure(db, runId, reason, category);
      return { status: "failed", reason, category };
    }
    const text = result.stdout.trim();
    if (!text) {
      const reason = "claude returned an empty final message";
      storage.recordClaudeFailure(db, runId, reason, "unknown");
      return { status: "failed", reason, category: "unknown" };
    }
    // A hollow report is a DROP, not a warning: nothing here is usable by the critique. Checked
    // BEFORE putArtifact so the "claude_report is always a real report" invariant holds. Unlike the
    // codex leg, the reason carries NO text preview — this file's redaction rule (the blind Codex
    // host must never see provider content before saving its own report) outranks diagnosability,
    // so only the char count travels.
    if (isHollowReport(text)) {
      const reason = `hollow report (no ## sections, ${text.length} chars) — the leg likely went off-task; retry`;
      storage.recordClaudeFailure(db, runId, reason, "transient");
      return { status: "failed", reason, category: "transient" };
    }
    storage.putArtifact(db, runId, "claude_report", text);
    storage.clearClaudeFailure(db, runId);
    return { status: "ok", formatWarning: countSections(text) < 2 };
  } catch (error) {
    // Unexpected failures may also carry provider output in an exception message. Keep the raw
    // message local for classification and expose only a stable, report-free summary.
    const detail = error instanceof Error ? error.message : String(error);
    const category = classifyClaudeFailure(detail);
    const reason = `claude provider failed unexpectedly: ${
      category === "fixable" ? "local setup error" : category === "quota" ? "usage limit or quota error" :
      category === "transient" ? "temporary error" : "internal error"
    }`;
    storage.recordClaudeFailure(db, runId, reason, category);
    return { status: "failed", reason, category };
  }
}
