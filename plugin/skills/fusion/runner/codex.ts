import { Database } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../storage";
import { lastStderr, runProc } from "../lib/subprocess";

type LegStatus = "ok" | "failed";

export interface LegResult {
  status: LegStatus;
  reason?: string;
  formatWarning?: boolean;
}

// A report is "structured" if it kept at least two of the requested `##` sections. We only WARN on a
// miss (never fail the leg) — the content may still be usable.
function hasStructuredFormat(text: string): boolean {
  return (text.match(/^##\s+/gm) || []).length >= 2;
}

// Single source of truth for the `codex exec` flags the runner relies on. doctor asserts the installed
// codex still exposes EXACTLY these, and the runner builds its argv from the same builder — so a flag
// the doctor green-lights is precisely a flag the runner uses (no long-vs-short drift).
export const CODEX_REQUIRED_FLAGS = ["-C", "-o", "--sandbox", "--json", "--ephemeral", "--skip-git-repo-check"] as const;

// Model + reasoning effort are NOT set here. We deliberately pass no `-m` (and no effort override), so
// codex falls back to the user's own `~/.codex/config.toml` — the single place they already configure
// which model / effort their subscription uses. Fusion respects that instead of pinning its own copy.
export function buildCodexArgs(projectDir: string, outPath: string): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
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
    if (res.code !== 0) throw new Error(`codex exited ${res.code}: ${lastStderr(res.stderr)}`);
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
    return {
      status: "ok",
      formatWarning: !hasStructuredFormat(text),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    storage.putArtifact(
      db,
      runId,
      "codex_report",
      `# Codex — UNAVAILABLE\n\nThis leg failed (fail-open): ${reason}\n`,
    );
    return { status: "failed", reason };
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}
