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

test("runner fail-open: codex exits non-zero -> leg failed, UNAVAILABLE report stored", async () => {
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

  process.env.FUSION_DB = join(root, "fail.db");
  const detail = storage.getRunDetails(storage.open(), "fail-run");
  expect(detail.codexReport).toContain("UNAVAILABLE");
});
