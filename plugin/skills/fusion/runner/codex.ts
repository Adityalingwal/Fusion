import { Database } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../storage";
import { lastStderr, runProc } from "../lib/subprocess";

import type { CodexFailCategory } from "../storage";

type LegStatus = "ok" | "failed";

export interface LegResult {
  status: LegStatus;
  reason?: string;
  category?: CodexFailCategory;
  formatWarning?: boolean;
}

// Classify a Codex drop reason so the skill can offer only the choices that make sense for it
// (retry / resume-later / fix / single-model / abort). Pure string → string, so it is unit-tested
// directly against the reason strings this file already produces (via extractCodexError /
// actionableHint / timeout / spawn errors). Order matters: quota is checked before the generic
// rate/5xx transient bucket so a 429 lands as quota, not transient.
export function classifyCodexFailure(reason: string): CodexFailCategory {
  const r = reason.toLowerCase();
  // Out of credits / hit a usage or rate cap → retrying now just fails again; the user must wait.
  if (/insufficient credit|usage limit|rate limit|\b429\b|too many requests|quota/.test(r)) return "quota";
  // A concrete, user-fixable setup problem: not authed, or a stale/absent CLI (the last two should be
  // pre-caught by preflight, but classify them anyway for a mid-run relay that regressed).
  if (
    /not logged in|not authenticated|unauthorized|\b401\b|newer version of codex|requires a newer version|upgrade the cli|unexpected argument|unrecognized option|executable not found|not found in \$?path|\benoent\b|no such file/.test(
      r,
    )
  ) {
    return "fixable";
  }
  // Likely to succeed on a plain retry: timeouts, network blips, 5xx.
  if (/timed out|timeout|network|connection|econn|socket|stream error|\b5(?:00|02|03|04)\b|server error/.test(r)) {
    return "transient";
  }
  return "unknown";
}

// A report is "structured" if it kept at least two of the requested `##` sections. We only WARN on a
// miss (never fail the leg) — the content may still be usable.
function hasStructuredFormat(text: string): boolean {
  return (text.match(/^##\s+/gm) || []).length >= 2;
}

// In `--json` mode codex reports API / model failures as JSON *events on stdout* (stderr stays empty),
// so a bare stderr read yields "no stderr" and hides the real cause. Pull the error text out of the
// stdout event stream instead. Two shapes occur: a top-level `{"type":"error",...}` event and an
// item-wrapped `{"item":{"type":"error",...}}` event.
//
// IMPORTANT: benign warnings ALSO arrive as `type:"error"` items on a *successful* run (e.g.
// "Under-development features enabled…"). This is why we only ever call this on a NON-ZERO exit — on
// success the report comes from the `-o` file, never from these events, so warnings never mislead us.
export function extractCodexError(stdout: string): string | null {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // non-JSON / partial line — skip
    }
    const event = parsed as { type?: unknown; item?: unknown; message?: unknown; status?: unknown };
    const node =
      event.type === "error"
        ? event
        : event.item && (event.item as { type?: unknown }).type === "error"
          ? (event.item as { message?: unknown; status?: unknown })
          : null;
    if (node && typeof node.message === "string") {
      const status = typeof node.status === "number" ? `[${node.status}] ` : "";
      messages.push(`${status}${node.message}`);
    }
  }
  // The fatal error is emitted LAST, right before codex aborts; any earlier `error` items are warnings.
  return messages.length ? messages[messages.length - 1] : null;
}

// Map recognizable failures to an actionable one-liner, appended to the raw message. This run-time
// reason is the only place the user sees what broke, so keep every branch a concrete copy-paste fix
// or a plain next step, not an ambiguous message. (No silent auto-install: we surface the command,
// the user runs it.) The `→ <fix>` tail is what lib/preflight.ts splits back into its `fix` field.
export function actionableHint(message: string): string {
  // Out of credits / usage cap / rate-limited (429). Retrying now would just fail again — the model
  // quota has to reset first, so the "fix" is to wait, not a command. (Named "GPT" — it's the model,
  // not the CLI tool.)
  if (/insufficient credit|usage limit|quota|\b429\b|too many requests|rate limit/i.test(message)) {
    return `${message}\n  → Your GPT usage limit is exhausted — wait for it to reset, then run /fusion again.`;
  }
  // Codex not installed / not on PATH (spawn ENOENT). Only the npm global CLI is usable — the
  // ChatGPT-app binary isn't on PATH — so the fix is always the global install + login.
  if (/executable not found|not found in \$?path|\benoent\b|no such file/i.test(message)) {
    return `${message}\n  → Codex isn't installed (or not on PATH). Install it: npm i -g @openai/codex — then run: codex login`;
  }
  // Stale PATH `codex`: it either announces "requires a newer version", or its argv parser rejects a
  // flag the runner passes ("unexpected argument" / "unrecognized option") because the installed CLI
  // predates it — both mean the same fix: update the CLI.
  if (/newer version of codex|requires a newer version|upgrade the cli|unexpected argument|unrecognized option/i.test(message)) {
    return `${message}\n  → Your codex CLI is incompatible/stale. Fix: npm i -g @openai/codex@latest`;
  }
  // Present but unauthenticated (kept distinct from a 400 credits/quota error, which is self-explanatory).
  if (/not logged in|not authenticated|unauthorized|\b401\b/i.test(message)) {
    return `${message}\n  → Run: codex login`;
  }
  return message;
}

// Model + reasoning effort are NOT set here. We deliberately pass no `-m` (and no effort override), so
// codex falls back to the user's own `~/.codex/config.toml` — the single place they already configure
// which model / effort their subscription uses. Fusion respects that instead of pinning its own copy.
//
// `-c tools.web_search=true` gives the Codex leg the native `web_search` tool so it CAN look things up
// on the live web when the brief warrants it (docs, versions, external facts the repo can't answer). Codex
// decides per-run whether to actually search — it stays offline when the task is self-contained.
// Verified: `--search` is top-level-only (rejected by `codex exec`); `-c tools.web_search=true` is the
// exec-compatible form, and it works under `--sandbox read-only` (web_search is model-native, not a shell op).
export function buildCodexArgs(projectDir: string, outPath: string): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-c",
    "tools.web_search=true",
    "-C",
    projectDir,
    "-o",
    outPath,
    "-",
  ];
}

// Codex via `codex exec` (model/effort come from the user's ~/.codex/config.toml — see buildCodexArgs).
// The final message is captured to a TEMP file via `-o` (outside the project dir), read back, and
// stored as the `codex_report` artifact in the DB.
export async function runCodexLeg(
  db: Database,
  brief: string,
  runId: string,
  projectDir: string,
  timeoutMs: number,
): Promise<LegResult> {
  // Sanitize the runId before it becomes a filesystem path: a runId like "../../x" would otherwise
  // let the `-o` write and the `rm` cleanup escape tmpdir. Stripping path separators (anything but
  // [A-Za-z0-9._-] → "_") leaves no "/" to traverse with.
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  const outPath = join(tmpdir(), `fusion-codex-${safeRunId}.txt`);
  try {
    const res = await runProc(
      ["codex", ...buildCodexArgs(projectDir, outPath)],
      { stdin: brief, timeoutMs, cwd: projectDir },
    );
    if (res.timedOut) throw new Error(`timed out after ${timeoutMs}ms`);
    if (res.code !== 0) {
      // Surface BOTH channels so nothing is hidden: the real cause is usually a stdout JSON error
      // event (e.g. a 400 "requires a newer version"), while stderr carries spawn/panic output.
      const stdoutErr = extractCodexError(res.stdout);
      const stderrTail = res.stderr.trim() ? lastStderr(res.stderr) : null;
      const detail = actionableHint([stdoutErr, stderrTail].filter(Boolean).join(" | ") || "no error output");
      // code === null means codex never started (spawn failure / not on PATH) — "exited null" reads as
      // a bug, so phrase it as a start failure. A real non-zero exit keeps the code for diagnostics.
      throw new Error(res.code === null ? `codex could not start: ${detail}` : `codex exited ${res.code}: ${detail}`);
    }
    // Distinguish a real read failure (propagate its cause) from a legitimately empty file —
    // swallowing the error to "" mislabeled every read failure as "empty final message".
    let text: string;
    try {
      text = (await readFile(outPath, "utf8")).trim();
    } catch (readErr) {
      throw new Error(`could not read codex output: ${readErr instanceof Error ? readErr.message : String(readErr)}`);
    }
    if (!text) throw new Error("empty final message");
    storage.putArtifact(db, runId, "codex_report", text);
    // Retry/resume case: a prior failed attempt may have stamped a drop reason on the row — clear it
    // now that a real report landed, so the run reads as healthy.
    storage.clearCodexFailure(db, runId);
    return {
      status: "ok",
      formatWarning: !hasStructuredFormat(text),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const category = classifyCodexFailure(reason);
    // NO placeholder artifact: a codex_report in the DB is always a real report now. Persist the
    // reason + category on the run row instead, so `status` / the dashboard can still explain the drop.
    storage.recordCodexFailure(db, runId, reason, category);
    return { status: "failed", reason, category };
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}
