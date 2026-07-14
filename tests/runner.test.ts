import { expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as storage from "../plugin/skills/fusion/storage";
import { makeFakeBin, readLogs, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const fusionRoot = resolve(import.meta.dir, "../plugin/skills/fusion");
const runnerPath = join(fusionRoot, "runner.ts");
const tempDir = useTempDirs("fusion-runner-test-");

test("runner sets project cwd and stores reports without metadata", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  const projectReal = await realpath(project);
  const hugeBrief = `Review this diff\n${"x".repeat(240_000)}`;
  await writeFile(join(project, "brief-input.md"), hugeBrief, "utf8");

  const result = await runBun(
    runnerPath,
    [
      "--run-id",
      "run-a",
      "--title",
      "  Direct runner title  ",
      "--brief-file",
      "brief-input.md",
      "--project-dir",
      project,
      "--timeout-ms",
      "5000",
    ],
    { cwd: outside, bin, log, env: { FUSION_DB: join(root, "test.db") } },
  );

  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(summary).toEqual({ runId: "run-a", codexAvailable: true });

  process.env.FUSION_DB = join(root, "test.db");
  const detail = storage.getRunDetails(storage.open(), "run-a");
  expect(detail.title).toBe("Direct runner title");
  expect(detail.codexReport).toBe("codex ok");
  expect(detail.brief?.startsWith("Review this diff")).toBe(true);

  const logs = await readLogs(log);
  const codex = logs.find((entry) => entry.tool === "codex" && entry.args[0] === "exec")!;
  expect(codex.cwd).toBe(projectReal);
  expect(codex.stdinLength).toBe(hugeBrief.length);
  expect(codex.args).toContain("-C");
  expect(codex.args).toContain(project);
  // No -m: model comes from the user's ~/.codex/config.toml, not a fusion override.
  expect(codex.args).not.toContain("-m");
});

test("runner warns on an unstructured report without persisting relay metadata", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan something", "utf8");

  const result = await runBun(
    runnerPath,
    ["--run-id", "meta-run", "--brief-file", "brief.md", "--project-dir", project, "--timeout-ms", "5000"],
    { cwd: root, bin, log, env: { FAKE_CODEX_OUTPUT: "only-one-heading", FUSION_DB: join(root, "meta.db") } },
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toContain("format_warning");
  process.env.FUSION_DB = join(root, "meta.db");
  expect(storage.getRunDetails(storage.open(), "meta-run").codexReport).toBe("only-one-heading");
});

test("runner drop: codex exits non-zero -> leg failed, NO placeholder report, failure recorded on the row", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan something", "utf8");

  const result = await runBun(
    runnerPath,
    ["--run-id", "fail-run", "--brief-file", "brief.md", "--project-dir", project, "--timeout-ms", "5000"],
    { cwd: root, bin, log, env: { FAKE_CODEX_EXIT: "1", FUSION_DB: join(root, "fail.db") } },
  );

  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(summary.runId).toBe("fail-run");
  expect(summary.codexAvailable).toBe(false);
  expect(summary.reason).toContain("codex exited 1");
  expect(summary.category).toBe("unknown"); // a bare non-zero exit with no error event → unknown

  process.env.FUSION_DB = join(root, "fail.db");
  const detail = storage.getRunDetails(storage.open(), "fail-run");
  // The fake "UNAVAILABLE" placeholder is gone: a codex_report is now always a real report or null.
  expect(detail.codexReport).toBeNull();
  // The drop reason + category live on the run row instead.
  expect(detail.codexFailReason).toContain("codex exited 1");
  expect(detail.codexFailCategory).toBe("unknown");
});

test("runner drop: a quota-style error event is classified and recorded as quota", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan something", "utf8");

  const result = await runBun(
    runnerPath,
    ["--run-id", "quota-run", "--brief-file", "brief.md", "--project-dir", project, "--timeout-ms", "5000"],
    {
      cwd: root,
      bin,
      log,
      env: {
        FAKE_CODEX_EXIT: "1",
        FAKE_CODEX_ERROR: "insufficient credits to run the requested model",
        FAKE_CODEX_ERROR_STATUS: "429",
        FUSION_DB: join(root, "quota.db"),
      },
    },
  );

  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(summary.codexAvailable).toBe(false);
  expect(summary.category).toBe("quota");

  process.env.FUSION_DB = join(root, "quota.db");
  const detail = storage.getRunDetails(storage.open(), "quota-run");
  expect(detail.codexReport).toBeNull();
  expect(detail.codexFailCategory).toBe("quota");
});

test("runner prints a JSON receipt before exiting on an empty brief (fatal path)", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });

  // No stored brief, no --brief-file, stdin is /dev/null → empty brief → the runner must still emit a
  // receipt before its non-zero exit (the whole B1 fix).
  const result = await runBun(
    runnerPath,
    ["--run-id", "empty-run", "--project-dir", project],
    { cwd: root, bin, log, env: { FUSION_DB: join(root, "empty.db") } },
  );
  expect(result.code).not.toBe(0);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(summary.runId).toBe("empty-run");
  expect(summary.codexAvailable).toBe(false);
  expect(summary.category).toBe("unknown");
});

test("runner prints a JSON receipt even on a fatal crash (unusable DB path)", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan something", "utf8");
  // FUSION_DB points at a directory → opening it as a SQLite file throws before the codex leg runs.
  const dbDir = join(root, "db-is-a-directory");
  await mkdir(dbDir, { recursive: true });

  const result = await runBun(
    runnerPath,
    ["--run-id", "crash-run", "--brief-file", "brief.md", "--project-dir", project, "--timeout-ms", "5000"],
    { cwd: root, bin, log, env: { FUSION_DB: dbDir } },
  );
  expect(result.code).not.toBe(0);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  expect(summary.runId).toBe("crash-run");
  expect(summary.codexAvailable).toBe(false);
  expect(summary.category).toBe("unknown");
});

test("runner success after a prior failure clears the recorded drop reason", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan something", "utf8");
  const dbFile = join(root, "retry.db");

  // First attempt fails (quota-style) and stamps the row.
  await runBun(
    runnerPath,
    ["--run-id", "retry-run", "--brief-file", "brief.md", "--project-dir", project, "--timeout-ms", "5000"],
    { cwd: root, bin, log, env: { FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "429 too many requests", FUSION_DB: dbFile } },
  );
  process.env.FUSION_DB = dbFile;
  expect(storage.getRunDetails(storage.open(), "retry-run").codexFailCategory).toBe("quota");

  // Retry succeeds → the stale drop reason is cleared and a real report lands.
  const ok = await runBun(
    runnerPath,
    ["--run-id", "retry-run", "--brief-file", "brief.md", "--project-dir", project, "--timeout-ms", "5000"],
    { cwd: root, bin, log, env: { FUSION_DB: dbFile } },
  );
  expect(ok.code).toBe(0);
  const detail = storage.getRunDetails(storage.open(), "retry-run");
  expect(detail.codexReport).toBe("codex ok");
  expect(detail.codexFailReason).toBeNull();
  expect(detail.codexFailCategory).toBeNull();
});
