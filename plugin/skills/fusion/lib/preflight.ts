// Shared Codex preflight — the single source of truth for "can Fusion actually run Codex right now?".
// BOTH `fusion.ts start` (the fail-fast gate that refuses to create a run when Codex is broken) and
// `doctor.ts` (the human diagnostic) call this, so the check logic lives in exactly one place and can
// never drift between them.
//
// The checks run in order and short-circuit: install → login + exec flags → real model ping. The ping
// is the load-bearing one — version/login/flag checks all pass even when the PATH `codex` is too old
// for the user's configured model (stale binary → 400 "requires a newer version") or the provider is
// out of credits (authed but 400 insufficient credits). Both are false-greens that only firing the
// ACTUAL configured model catches, so preflight does it every time.

import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_REQUIRED_FLAGS, buildCodexArgs, extractCodexError, actionableHint } from "../runner/codex";
import { runProc } from "./subprocess";

export type PreflightCheck = "install" | "login" | "flags" | "ping";

export interface PreflightFailure {
  check: PreflightCheck;
  reason: string;
  fix: string;
}

export interface PreflightResult {
  ok: boolean;
  // Per-check outcomes for the human presenter (doctor). A check is null when an earlier failure
  // short-circuited before it ran (e.g. login/flags/ping are null when codex isn't installed).
  install: boolean;
  login: boolean | null;
  flags: boolean | null;
  ping: boolean | null;
  pingDetail: string | null; // human-readable cause when the ping fails
  // Ordered failures; failures[0] is the headline the start gate emits (reason + copy-paste fix).
  failures: PreflightFailure[];
  // Non-fatal caveats (e.g. auth passed but credits aren't guaranteed by status).
  warnings: string[];
}

// Reuse the shared runProc (timeout + drain + spawn-catch), adapting it to the {code, out} shape the
// checks want — same adapter doctor used before this logic moved here.
async function run(cmd: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  const res = await runProc(cmd, { timeoutMs });
  return { code: res.code, out: `${res.stdout}\n${res.stderr}`.trim() };
}

function shortErr(text: string): string {
  const last = text.trim().split("\n").filter(Boolean).at(-1) || "no output";
  return last.length > 80 ? `${last.slice(0, 80)}…` : last;
}

function hasAll(text: string, needles: readonly string[]): boolean {
  return needles.every((needle) => text.includes(needle));
}

function codexLoggedIn(output: string): boolean {
  // Anchor on the POSITIVE success phrase ("Logged in as …" / "Logged in using …"). The old negative
  // match (`not logged in`) false-greened on "not currently logged in" — any word wedged between
  // "not" and "logged in" slipped past it.
  return /logged in (as|using)\b/i.test(output);
}

// The ping detail already embeds its actionable fix as a "… → <fix>" tail (via actionableHint). Split
// it back into {reason, fix} so the start gate can surface the fix as its own field without the
// wording drifting from doctor. No arrow → no known fix, so point the user at the full diagnostic.
function splitHint(detail: string): { reason: string; fix: string } {
  const idx = detail.indexOf("→");
  if (idx === -1) return { reason: detail.trim(), fix: "Run `fusion doctor` for the full diagnostic." };
  return {
    reason: detail.slice(0, idx).replace(/[|\s]+$/, "").trim(),
    fix: detail.slice(idx + 1).trim(),
  };
}

export async function preflightCodex(cwd: string): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];
  const warnings: string[] = [];
  const result: PreflightResult = {
    ok: false,
    install: false,
    login: null,
    flags: null,
    ping: null,
    pingDetail: null,
    failures,
    warnings,
  };

  // 1. Installed / on PATH?
  const version = await run(["codex", "--version"]);
  result.install = version.code === 0;
  if (!result.install) {
    failures.push({
      check: "install",
      reason: "Codex CLI not found (or not on PATH)",
      fix: "npm i -g @openai/codex — then run: codex login",
    });
    return result;
  }

  // 2. Authenticated + exec exposes the flags the runner builds its argv from.
  const status = await run(["codex", "login", "status"]);
  const help = await run(["codex", "exec", "--help"]);
  result.login = codexLoggedIn(status.out);
  result.flags = help.code === 0 && hasAll(help.out, CODEX_REQUIRED_FLAGS);
  if (!result.login) {
    failures.push({ check: "login", reason: "Codex is installed but not logged in", fix: "codex login" });
    return result;
  }
  if (!result.flags) {
    failures.push({
      check: "flags",
      reason: "Codex is authed but its exec flags are incompatible (the CLI looks stale)",
      fix: "npm i -g @openai/codex@latest",
    });
    return result;
  }
  warnings.push("Codex auth passed, but provider credits/quota are not guaranteed by status.");

  // 3. Real model ping — reuse the runner's EXACT argv (buildCodexArgs) so the ping exercises the real
  // invocation path, and assert the model actually replied READY (exit 0 alone can mask an empty
  // answer). Model/effort come from ~/.codex/config.toml, same as a real run.
  const outPath = join(tmpdir(), `fusion-preflight-${process.pid}-${Date.now()}.txt`);
  try {
    const ping = await runProc(["codex", ...buildCodexArgs(cwd, outPath)], {
      stdin: "Reply with the single word READY.",
      timeoutMs: 90_000,
      cwd,
    });
    const out = await readFile(outPath, "utf8").catch(() => "");
    result.ping = !ping.timedOut && ping.code === 0 && /READY/i.test(out);
    if (!result.ping) {
      // Explain WHY, honestly. A codex failure reports its real cause as a JSON error event on stdout
      // (stderr stays empty) — the same trap the runner hit — so read it the same way and attach the
      // actionable fix. Only parse stdout errors on a non-zero exit (mirrors the runner): on a 0-exit
      // the "errors" are benign warnings, so show the actual reply instead.
      let detail: string;
      if (ping.timedOut) {
        detail = "timed out";
      } else if (ping.code !== 0) {
        const stdoutErr = extractCodexError(ping.stdout);
        const stderrTail = ping.stderr.trim() ? shortErr(ping.stderr) : null;
        detail = actionableHint([stdoutErr, stderrTail].filter(Boolean).join(" | ") || "no error output");
      } else {
        detail = shortErr(out || "empty reply");
      }
      result.pingDetail = detail;
      const { reason, fix } = splitHint(detail);
      failures.push({ check: "ping", reason, fix });
    }
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }

  result.ok = failures.length === 0;
  return result;
}
