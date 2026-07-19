import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Default fake reports: structured (two ## sections) so they clear the runner's hollow-report
// detector, mirroring what a healthy leg actually returns. Tests that need a degenerate report
// override via FAKE_CODEX_OUTPUT / FAKE_CLAUDE_OUTPUT.
export const FAKE_CODEX_REPORT = "## Plan\ncodex ok\n\n## Risks\nnone";
export const FAKE_CLAUDE_REPORT = "## Plan\nclaude ok\n\n## Risks\nnone";

export async function makeFakeBin(root: string): Promise<{ bin: string; log: string }> {
  const bin = join(root, "bin");
  const log = join(root, "cli-log.jsonl");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "", "utf8");

  const codex = `
import { appendFile, writeFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
const log = process.env.FAKE_CLI_LOG;
async function record(extra = {}) {
  const stdin = await Bun.stdin.text();
  await appendFile(log, JSON.stringify({
    tool: "codex",
    args,
    cwd: process.cwd(),
    stdinLength: stdin.length,
    stdinPreview: stdin.slice(0, 80),
    ...extra,
  }) + "\\n");
  return stdin;
}
if (args.includes("--version")) {
  // Simulate a missing / broken CLI: \`codex --version\` fails, which preflight reads as "not installed".
  if (process.env.FAKE_CODEX_VERSION_FAIL) process.exit(1);
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log(process.env.FAKE_CODEX_STATUS || "Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "exec") {
  const stdin = await record();
  // Simulate a real codex failure: it reports the cause as a JSON error event on STDOUT (stderr stays
  // empty) — the same shape extractCodexError parses — then exits non-zero. Lets tests drive the
  // runner's classification (e.g. a quota/429 message) end-to-end.
  if (process.env.FAKE_CODEX_ERROR) {
    const status = process.env.FAKE_CODEX_ERROR_STATUS;
    const event = { type: "error", message: process.env.FAKE_CODEX_ERROR };
    if (status) event.status = Number(status);
    console.log(JSON.stringify(event));
    process.exit(Number(process.env.FAKE_CODEX_EXIT || "1"));
  }
  const outputFlag = args.includes("-o") ? "-o" : "--output-last-message";
  const outIndex = args.indexOf(outputFlag);
  // Echo READY when the prompt asks for it (the preflight model ping), else the configured/default output.
  const output = /READY/i.test(stdin) ? "READY" : (process.env.FAKE_CODEX_OUTPUT || ${JSON.stringify(FAKE_CODEX_REPORT)});
  if (outIndex >= 0) await writeFile(args[outIndex + 1], output, "utf8");
  process.exit(Number(process.env.FAKE_CODEX_EXIT || "0"));
}
await record({ unhandled: true });
process.exit(0);
`;

  const claude = `
import { appendFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
const log = process.env.FAKE_CLI_LOG;
async function record(extra = {}) {
  const stdin = await Bun.stdin.text();
  await appendFile(log, JSON.stringify({
    tool: "claude",
    args,
    cwd: process.cwd(),
    stdinLength: stdin.length,
    stdinPreview: stdin.slice(0, 80),
    ...extra,
  }) + "\\n");
  return stdin;
}
if (args.includes("--version")) {
  if (process.env.FAKE_CLAUDE_VERSION_FAIL) process.exit(1);
  console.log("claude-code test");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_CLAUDE_AUTH_EXIT) process.exit(Number(process.env.FAKE_CLAUDE_AUTH_EXIT));
  if (process.env.FAKE_CLAUDE_STATUS) console.log(process.env.FAKE_CLAUDE_STATUS);
  else console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== "false" }));
  process.exit(0);
}
if (args.includes("-p") || args.includes("--print")) {
  const stdin = await record();
  const delay = Number(process.env.FAKE_CLAUDE_SLEEP_MS || "0");
  if (delay > 0) await Bun.sleep(delay);
  if (process.env.FAKE_CLAUDE_STDERR) console.error(process.env.FAKE_CLAUDE_STDERR);
  const output = /READY/i.test(stdin) ? "READY" : (process.env.FAKE_CLAUDE_OUTPUT ?? ${JSON.stringify(FAKE_CLAUDE_REPORT)});
  if (output) console.log(output);
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || "0"));
}
await record({ unhandled: true });
process.exit(0);
`;

  await writeFile(join(bin, "codex.ts"), codex, "utf8");
  await writeFile(join(bin, "claude.ts"), claude, "utf8");
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), '@echo off\r\nbun "%~dp0codex.ts" %*\r\n', "utf8");
    await writeFile(join(bin, "claude.cmd"), '@echo off\r\nbun "%~dp0claude.ts" %*\r\n', "utf8");
  } else {
    await writeFile(join(bin, "codex"), '#!/usr/bin/env sh\nexec bun "$(dirname "$0")/codex.ts" "$@"\n', "utf8");
    await writeFile(join(bin, "claude"), '#!/usr/bin/env sh\nexec bun "$(dirname "$0")/claude.ts" "$@"\n', "utf8");
    await Promise.all([
      chmod(join(bin, "codex"), 0o755),
      chmod(join(bin, "claude"), 0o755),
    ]);
  }
  return { bin, log };
}

export async function runBun(
  script: string,
  args: string[],
  opts: { cwd: string; bin: string; log: string; env?: Record<string, string>; inheritPath?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, ...opts.env };
  const parentPathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  const parentPath = parentPathKey ? process.env[parentPathKey] : "";
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = opts.inheritPath === false ? opts.bin : `${opts.bin}${delimiter}${parentPath || ""}`;
  env.FAKE_CLI_LOG = opts.log;

  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: opts.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function readLogs(log: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(log, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
