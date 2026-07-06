import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

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
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log(process.env.FAKE_CODEX_STATUS || "Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "exec" && args.includes("--help")) {
  if (process.env.FAKE_CODEX_HELP === "missing-flags") {
    console.log("codex exec --model");
  } else {
    // Mirror real codex help: each flag listed with both short + long form.
    console.log("-m, --model -C, --cd -s, --sandbox -o, --output-last-message --json --ephemeral --skip-git-repo-check");
  }
  process.exit(0);
}
if (args[0] === "exec") {
  const stdin = await record();
  const outputFlag = args.includes("-o") ? "-o" : "--output-last-message";
  const outIndex = args.indexOf(outputFlag);
  // Echo READY when the prompt asks for it (doctor --smoke), else the configured/default output.
  const output = /READY/i.test(stdin) ? "READY" : (process.env.FAKE_CODEX_OUTPUT || "codex ok");
  if (outIndex >= 0) await writeFile(args[outIndex + 1], output, "utf8");
  process.exit(Number(process.env.FAKE_CODEX_EXIT || "0"));
}
await record({ unhandled: true });
process.exit(0);
`;

  await writeFile(join(bin, "codex.ts"), codex, "utf8");
  await writeFile(join(bin, "claude.ts"), 'console.log("claude test");\n', "utf8");
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
  opts: { cwd: string; bin: string; log: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, ...opts.env };
  const parentPathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
  const parentPath = parentPathKey ? process.env[parentPathKey] : "";
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = `${opts.bin}${delimiter}${parentPath || ""}`;
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
