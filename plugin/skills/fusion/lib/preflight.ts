// Shared Codex preflight — the single source of truth for "can Fusion actually run Codex right now?".
// `fusion.ts start` is the only caller: the fail-fast gate that refuses to create a run when Codex is
// broken. On failure it surfaces `failures[0]` (reason + copy-paste fix) and creates nothing.
//
// The checks run in order and short-circuit: install → login → real model ping. The ping is the
// load-bearing one — version/login both pass even when the PATH `codex` is too old for the user's
// configured model (stale binary → its argv is rejected / the model 400s "requires a newer version")
// or the provider is out of credits (authed but 400 insufficient credits). Both are false-greens that
// only firing the ACTUAL configured model catches, so preflight does it every time. (No separate
// exec-flags help-text check: a flag the runner can't pass makes THIS ping's argv fail instantly, so
// the check added nothing but false-block risk on help-format drift.)

import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgs, extractCodexError, actionableHint } from "../runner/codex";
import { runProc } from "./subprocess";

export type PreflightCheck = "install" | "login" | "ping";

export interface PreflightFailure {
  check: PreflightCheck;
  reason: string;
  fix: string;
}

export interface PreflightResult {
  ok: boolean;
  // Ordered failures; failures[0] is the headline the start gate emits (reason + copy-paste fix).
  failures: PreflightFailure[];
}

// Reuse the shared runProc (timeout + drain + spawn-catch), adapting it to the {code, out} shape the
// checks want.
async function run(cmd: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  const res = await runProc(cmd, { timeoutMs });
  return { code: res.code, out: `${res.stdout}\n${res.stderr}`.trim() };
}

// The model ping's hard timeout. Named (not inline) so the timeout message below can't drift from it.
const PING_TIMEOUT_MS = 90_000;

// The exact detail a ping TIMEOUT surfaces. A timeout is usually temporary (slow network / busy
// model), so give a concrete reason + a plain "just retry" fix instead of the generic splitHint
// fallback. The `→` tail lets splitHint break it into {reason, fix}. Exported for tests: a 90s
// hardcoded timeout can't be driven to fire in a unit test without a 90s wait, so the message
// transformation is verified directly.
export function pingTimeoutDetail(): string {
  return `Codex did not reply within ${Math.round(PING_TIMEOUT_MS / 1000)}s → This is usually temporary (slow network or a busy model) — just run /fusion again.`;
}

function shortErr(text: string): string {
  const last = text.trim().split("\n").filter(Boolean).at(-1) || "no output";
  return last.length > 80 ? `${last.slice(0, 80)}…` : last;
}

function codexLoggedIn(output: string): boolean {
  // Anchor on the POSITIVE success phrase ("Logged in as …" / "Logged in using …"). The old negative
  // match (`not logged in`) false-greened on "not currently logged in" — any word wedged between
  // "not" and "logged in" slipped past it.
  return /logged in (as|using)\b/i.test(output);
}

// The ping detail already embeds its actionable fix as a "… → <fix>" tail (via actionableHint). Split
// it back into {reason, fix} so the start gate can surface the fix as its own field. No arrow → no
// recognized fix, so hand back a plain-English next step (never point at a diagnostic command).
export function splitHint(detail: string): { reason: string; fix: string } {
  const idx = detail.indexOf("→");
  if (idx === -1) return { reason: detail.trim(), fix: "Fix that, then run /fusion again." };
  return {
    reason: detail.slice(0, idx).replace(/[|\s]+$/, "").trim(),
    fix: detail.slice(idx + 1).trim(),
  };
}

export async function preflightCodex(cwd: string): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];

  // 1. Installed / on PATH?
  const version = await run(["codex", "--version"]);
  if (version.code !== 0) {
    failures.push({
      check: "install",
      reason: "Codex CLI not found (or not on PATH)",
      fix: "npm i -g @openai/codex — then run: codex login",
    });
    return { ok: false, failures };
  }

  // 2. Authenticated?
  const status = await run(["codex", "login", "status"]);
  if (!codexLoggedIn(status.out)) {
    failures.push({ check: "login", reason: "Codex is installed but not logged in", fix: "codex login" });
    return { ok: false, failures };
  }

  // 3. Real model ping — reuse the runner's EXACT argv (buildCodexArgs) so the ping exercises the real
  // invocation path (a stale CLI that can't parse the runner's flags fails here, before any model
  // runs), and assert the model actually replied READY (exit 0 alone can mask an empty answer).
  // Model/effort come from ~/.codex/config.toml, same as a real run.
  const outPath = join(tmpdir(), `fusion-preflight-${process.pid}-${Date.now()}.txt`);
  try {
    const ping = await runProc(["codex", ...buildCodexArgs(cwd, outPath)], {
      stdin: "Reply with the single word READY.",
      timeoutMs: PING_TIMEOUT_MS,
      cwd,
    });
    const out = await readFile(outPath, "utf8").catch(() => "");
    const pingOk = !ping.timedOut && ping.code === 0 && /READY/i.test(out);
    if (!pingOk) {
      // Explain WHY, honestly. A codex failure reports its real cause as a JSON error event on stdout
      // (stderr stays empty) — the same trap the runner hit — so read it the same way and attach the
      // actionable fix. Only parse stdout errors on a non-zero exit (mirrors the runner): on a 0-exit
      // the "errors" are benign warnings, so show the actual reply instead.
      let detail: string;
      if (ping.timedOut) {
        detail = pingTimeoutDetail();
      } else if (ping.code !== 0) {
        const stdoutErr = extractCodexError(ping.stdout);
        const stderrTail = ping.stderr.trim() ? shortErr(ping.stderr) : null;
        detail = actionableHint([stdoutErr, stderrTail].filter(Boolean).join(" | ") || "no error output");
      } else {
        detail = shortErr(out || "empty reply");
      }
      const { reason, fix } = splitHint(detail);
      failures.push({ check: "ping", reason, fix });
    }
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }

  return { ok: failures.length === 0, failures };
}
