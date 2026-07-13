#!/usr/bin/env bun
// Fusion doctor — verify the subscription CLI is present + authenticated.
// Claude Code is the host (always present when this runs); Codex is the
// external relay the runner drives.
// Report, not silent: it prints the leg's state and exits non-zero if the external
// relay is unusable, so install/setup surfaces the problem instead of failing quietly.

import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_REQUIRED_FLAGS, buildCodexArgs, extractCodexError, actionableHint } from "./runner/codex";
import { runProc } from "./lib/subprocess";

// Reuse the shared runProc (timeout + drain + spawn-catch) instead of a third hand-rolled
// copy — just adapt its result to the {code, out} shape the checks below expect.
async function run(cmd: string[], timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  const res = await runProc(cmd, { timeoutMs });
  return { code: res.code, out: `${res.stdout}\n${res.stderr}`.trim() };
}

function line(label: string, status: string): void {
  console.log(`  ${label.padEnd(16)}: ${status}`);
}

function shortErr(text: string): string {
  const last = text.trim().split("\n").filter(Boolean).at(-1) || "no output";
  return last.length > 80 ? `${last.slice(0, 80)}…` : last;
}

function hasAll(text: string, needles: string[]): boolean {
  return needles.every((needle) => text.includes(needle));
}

function codexLoggedIn(output: string): boolean {
  // Anchor on the POSITIVE success phrase ("Logged in as …" / "Logged in using …"). The old negative
  // match (`not logged in`) false-greened on "not currently logged in" — any word wedged between
  // "not" and "logged in" slipped past it.
  return /logged in (as|using)\b/i.test(output);
}

console.log("Fusion doctor — checking subscription CLIs\n");

const ok: Record<string, boolean> = {};
const warnings: string[] = [];

// Claude Code (the host leg)
{
  const v = await run(["claude", "--version"]);
  ok.claude = v.code === 0;
  line("Claude Code", ok.claude ? "✓ found (host)" : "✗ not found");
}

// Codex
{
  const v = await run(["codex", "--version"]);
  if (v.code !== 0) {
    ok.codex = false;
    line("Codex", "✗ not found   → npm i -g @openai/codex");
  } else {
    const s = await run(["codex", "login", "status"]);
    const h = await run(["codex", "exec", "--help"]);
    const flagsOk = h.code === 0 && hasAll(h.out, [...CODEX_REQUIRED_FLAGS]);
    ok.codex = codexLoggedIn(s.out) && flagsOk;
    if (!codexLoggedIn(s.out)) {
      line("Codex", "⚠ found, NOT logged in   → codex login");
    } else if (!flagsOk) {
      line("Codex", "⚠ found + authed, incompatible exec flags");
    } else {
      line("Codex", "✓ found + authed + flags");
      warnings.push("Codex auth passed, but provider credits/quota are not guaranteed by status.");
    }
  }
}

// Real-model ping — default, not opt-in. The version/login/flag checks above all pass even when the
// PATH `codex` is too old for the user's configured model (stale binary → 400 "requires a newer
// version") or the provider is out of credits (authed but `400 insufficient credits`). Both are
// false-greens. Firing the ACTUAL configured model is the only reliable way to confirm a run will
// work, so doctor does it every time rather than hiding it behind a flag.
if (ok.codex) {
  console.log("\nModel ping (fires a tiny real prompt to the configured model — uses a little quota):");
  // Reuse the runner's EXACT argv (buildCodexArgs) so the ping exercises the real invocation path —
  // not a hand-rolled approximation — and assert the model actually replied READY (exit 0 alone can
  // mask an empty answer). Model/effort come from ~/.codex/config.toml, same as a real run.
  const outPath = join(tmpdir(), `fusion-doctor-smoke-${process.pid}.txt`);
  let pass = false;
  let detail = "";
  try {
    const result = await runProc(["codex", ...buildCodexArgs(process.cwd(), outPath)], {
      stdin: "Reply with the single word READY.",
      timeoutMs: 90_000,
      cwd: process.cwd(),
    });
    const out = await readFile(outPath, "utf8").catch(() => "");
    pass = !result.timedOut && result.code === 0 && /READY/i.test(out);
    if (!pass) {
      // Explain WHY, honestly. A codex failure reports its real cause as a JSON error event on
      // stdout (stderr stays empty) — the same trap the runner hit — so read it the same way and
      // attach the actionable fix. Only parse stdout errors on a non-zero exit (mirrors the runner):
      // on a 0-exit the "errors" are benign warnings, so show the actual reply instead.
      if (result.timedOut) {
        detail = "timed out";
      } else if (result.code !== 0) {
        const stdoutErr = extractCodexError(result.stdout);
        const stderrTail = result.stderr.trim() ? shortErr(result.stderr) : null;
        detail = actionableHint([stdoutErr, stderrTail].filter(Boolean).join(" | ") || "no error output");
      } else {
        detail = shortErr(out || "empty reply");
      }
    }
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
  line("Codex model", pass ? "✓ configured model responded" : `✗ failed → ${detail}`);
  if (!pass) ok.codex = false;
}

const relaysOk = Boolean(ok.codex);
console.log(
  relaysOk
    ? "\nFusion ready: Codex is installed, authenticated, and exposes the runner flags."
    : "\nFusion degraded: Codex relay is unavailable. Fusion fails open (runs Claude-only), but Codex must be available to run alongside Claude.",
);
for (const warning of warnings) {
  console.log(`Note: ${warning}`);
}
process.exit(relaysOk ? 0 : 1);
