import { expect, test } from "bun:test";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as storage from "../plugin/skills/fusion/storage";
import { classifyClaudeFailure } from "../plugin/skills/fusion/runner/claude";
import { makeFakeBin, readLogs, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const runnerPath = resolve(import.meta.dir, "../plugin/skills/fusion/runner.ts");
const tempDir = useTempDirs("fusion-claude-test-");

async function fixture() {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "fusion.db");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan the bridge", "utf8");
  const args = [
    "--run-id", "claude-run",
    "--host", "codex",
    "--provider", "claude",
    "--project-dir", project,
    "--brief-file", "brief.md",
    "--timeout-ms", "5000",
  ];
  return { root, bin, log, project, dbFile, args };
}

test("Claude relay sends only the brief with planning-safe one-shot flags and stores the report", async () => {
  const f = await fixture();
  const result = await runBun(runnerPath, f.args, {
    cwd: f.project,
    bin: f.bin,
    log: f.log,
    env: { FUSION_DB: f.dbFile, FAKE_CLAUDE_OUTPUT: "## Approach\nClaude plan\n## Risks\nNone" },
  });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ runId: "claude-run", claudeAvailable: true });
  process.env.FUSION_DB = f.dbFile;
  expect(storage.getRunDetails(storage.open(), "claude-run")).toMatchObject({
    hostModel: "codex",
    providerModel: "claude",
    claudeReport: "## Approach\nClaude plan\n## Risks\nNone",
  });

  const invocation = (await readLogs(f.log)).find((entry) => entry.tool === "claude")!;
  expect(invocation.cwd).toBe(await realpath(f.project));
  expect(invocation.stdinPreview).toBe("Plan the bridge");
  expect(invocation.args).toEqual(["-p", "--permission-mode", "plan", "--no-session-persistence"]);
  for (const forbidden of ["--model", "--system-prompt", "--append-system-prompt", "--safe-mode", "--tools", "--bg"]) {
    expect(invocation.args).not.toContain(forbidden);
  }
});

test("Claude relay non-zero exit records failure without a placeholder report", async () => {
  const f = await fixture();
  const partialReport = "SECRET PARTIAL CLAUDE REPORT";
  const result = await runBun(runnerPath, f.args, {
    cwd: f.project,
    bin: f.bin,
    log: f.log,
    env: {
      FUSION_DB: f.dbFile,
      FAKE_CLAUDE_EXIT: "1",
      FAKE_CLAUDE_OUTPUT: partialReport,
      FAKE_CLAUDE_STDERR: "429 usage limit reached",
    },
  });
  const receipt = JSON.parse(result.stdout.trim());
  expect(receipt).toMatchObject({ runId: "claude-run", claudeAvailable: false, category: "quota" });
  expect(receipt.reason).not.toContain(partialReport);
  expect(result.stderr).not.toContain(partialReport);
  process.env.FUSION_DB = f.dbFile;
  const details = storage.getRunDetails(storage.open(), "claude-run");
  expect(details).toMatchObject({
    claudeReport: null,
    claudeFailCategory: "quota",
    providerFailCategory: "quota",
  });
  expect(details.claudeFailReason).not.toContain(partialReport);
});

test("Claude relay timeout and empty output never create a report", async () => {
  for (const [label, env, timeout] of [
    ["timeout", { FAKE_CLAUDE_SLEEP_MS: "500" }, "40"],
    ["empty", { FAKE_CLAUDE_OUTPUT: "" }, "5000"],
  ] as const) {
    const f = await fixture();
    const args = f.args.map((value, index) => f.args[index - 1] === "--timeout-ms" ? timeout : value);
    const result = await runBun(runnerPath, args, {
      cwd: f.project,
      bin: f.bin,
      log: f.log,
      env: { FUSION_DB: f.dbFile, ...env },
    });
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt.claudeAvailable, label).toBe(false);
    process.env.FUSION_DB = f.dbFile;
    expect(storage.getArtifact(storage.open(), "claude-run", "claude_report"), label).toBeNull();
  }
});

test("Claude spawn failure is fixable and stores no placeholder", async () => {
  const f = await fixture();
  await rm(join(f.bin, process.platform === "win32" ? "claude.cmd" : "claude"), { force: true });
  await rm(join(f.bin, "claude.ts"), { force: true });
  const result = await runBun(runnerPath, f.args, {
    cwd: f.project,
    bin: f.bin,
    log: f.log,
    inheritPath: false,
    env: { FUSION_DB: f.dbFile },
  });
  const receipt = JSON.parse(result.stdout.trim());
  expect(receipt).toMatchObject({ claudeAvailable: false, category: "fixable" });
  process.env.FUSION_DB = f.dbFile;
  expect(storage.getArtifact(storage.open(), "claude-run", "claude_report")).toBeNull();
  expect(classifyClaudeFailure("spawn claude ENOENT")).toBe("fixable");
});

test("Claude retry success clears the previous safe failure metadata", async () => {
  const f = await fixture();
  await runBun(runnerPath, f.args, {
    cwd: f.project,
    bin: f.bin,
    log: f.log,
    env: { FUSION_DB: f.dbFile, FAKE_CLAUDE_EXIT: "1", FAKE_CLAUDE_STDERR: "429 quota reached" },
  });
  process.env.FUSION_DB = f.dbFile;
  expect(storage.getRunDetails(storage.open(), "claude-run").claudeFailCategory).toBe("quota");

  const retry = await runBun(runnerPath, f.args, {
    cwd: f.project,
    bin: f.bin,
    log: f.log,
    env: { FUSION_DB: f.dbFile, FAKE_CLAUDE_OUTPUT: "## Plan\nRecovered\n## Risks\nNone" },
  });
  expect(retry.code).toBe(0);
  expect(storage.getRunDetails(storage.open(), "claude-run")).toMatchObject({
    claudeReport: "## Plan\nRecovered\n## Risks\nNone",
    claudeFailReason: null,
    claudeFailCategory: null,
  });
});
