#!/usr/bin/env bun
// Fusion doctor — verify the subscription CLI is present + authenticated.
// Claude Code is the host (always present when this runs); Codex is the
// external relay the runner drives.
// Report, not silent: it prints the leg's state and exits non-zero if the external
// relay is unusable, so install/setup surfaces the problem instead of failing quietly.
//
// doctor is now a thin PRESENTER over lib/preflight.ts: the actual Codex checks (install → login →
// exec flags → real model ping) live there and are shared verbatim with `fusion.ts start`, so the
// gate and the diagnostic can never disagree. doctor only adds the host Claude line and renders the
// shared result as the same human-readable report it always printed.

import { runProc } from "./lib/subprocess";
import { preflightCodex } from "./lib/preflight";

async function run(cmd: string[], timeoutMs = 15_000): Promise<{ code: number | null }> {
  const res = await runProc(cmd, { timeoutMs });
  return { code: res.code };
}

function line(label: string, status: string): void {
  console.log(`  ${label.padEnd(16)}: ${status}`);
}

console.log("Fusion doctor — checking subscription CLIs\n");

// Claude Code (the host leg) — informational; it's always present when this runs and does not gate
// the Codex relay, so it stays here in the presenter rather than in the shared codex preflight.
const claude = await run(["claude", "--version"]);
line("Claude Code", claude.code === 0 ? "✓ found (host)" : "✗ not found");

const pre = await preflightCodex(process.cwd());

// Codex install/auth/flags line — one status string per outcome, matching the shared check order.
if (!pre.install) {
  line("Codex", "✗ not found   → npm i -g @openai/codex");
} else if (pre.login === false) {
  line("Codex", "⚠ found, NOT logged in   → codex login");
} else if (pre.flags === false) {
  line("Codex", "⚠ found + authed, incompatible exec flags");
} else {
  line("Codex", "✓ found + authed + flags");
}

// Model ping — only runs when install/auth/flags all passed (ping is null otherwise).
if (pre.ping !== null) {
  console.log("\nModel ping (fires a tiny real prompt to the configured model — uses a little quota):");
  line("Codex model", pre.ping ? "✓ configured model responded" : `✗ failed → ${pre.pingDetail ?? "unknown"}`);
}

console.log(
  pre.ok
    ? "\nFusion ready: Codex is installed, authenticated, and exposes the runner flags."
    : "\nFusion degraded: Codex is unavailable. Fusion refuses to start until this is fixed — run `fusion doctor` after applying the fix above.",
);
for (const warning of pre.warnings) {
  console.log(`Note: ${warning}`);
}
process.exit(pre.ok ? 0 : 1);
