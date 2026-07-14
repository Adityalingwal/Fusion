import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as storage from "../plugin/skills/fusion/storage";
import { makeFakeBin, readLogs, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const fusionRoot = resolve(import.meta.dir, "../plugin/skills/fusion");
const fusionPath = join(fusionRoot, "fusion.ts");
const makeTempDir = useTempDirs("fusion-internal-cli-");

function json(stdout: string): Record<string, any> {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("plugin-internal CLI completes the storage lifecycle with UUIDs and paths containing spaces", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project with spaces");
  const dbFile = join(root, "fusion.db");
  await mkdir(project, { recursive: true });

  const start = await runBun(fusionPath, ["start", "--project-dir", project, "--title", "  Cross-platform lifecycle  "], {
    cwd: project,
    bin,
    log,
    env: { FUSION_DB: dbFile },
  });
  expect(start.code).toBe(0);
  const started = json(start.stdout);
  expect(started.ok).toBe(true);
  expect(started.title).toBeUndefined(); // input expands without changing the existing JSON contract
  expect(started.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(await realpath(started.projectDir)).toBe(await realpath(project));

  const briefFile = join(root, "brief with spaces.md");
  await writeFile(briefFile, "cross-platform brief", "utf8");
  const put = await runBun(
    fusionPath,
    ["put", "--run-id", started.runId, "--type", "brief", "--file", briefFile],
    { cwd: project, bin, log, env: { FUSION_DB: dbFile } },
  );
  expect(put.code).toBe(0);
  expect(json(put.stdout).bytes).toBe(20);

  const get = await runBun(fusionPath, ["get", "--run-id", started.runId, "--type", "brief"], {
    cwd: project,
    bin,
    log,
    env: { FUSION_DB: dbFile },
  });
  expect(get.code).toBe(0);
  expect(json(get.stdout).content).toBe("cross-platform brief");

  const exported = await runBun(
    fusionPath,
    ["export", "--run-id", started.runId, "--type", "brief", "--out", "exported.md"],
    { cwd: project, bin, log, env: { FUSION_DB: dbFile } },
  );
  expect(exported.code).toBe(0);
  expect(await readFile(join(project, "exported.md"), "utf8")).toBe("cross-platform brief");

  const finish = await runBun(fusionPath, ["finish", "--run-id", started.runId], {
    cwd: project,
    bin,
    log,
    env: { FUSION_DB: dbFile },
  });
  expect(finish.code).toBe(0);
  expect(json(finish.stdout).status).toBe("completed");

  process.env.FUSION_DB = dbFile;
  const details = storage.getRunDetails(storage.open(), started.runId);
  expect(details.status).toBe("completed");
  expect(details.title).toBe("Cross-platform lifecycle");

  const untitled = await runBun(fusionPath, ["start", "--run-id", "untitled", "--project-dir", project], {
    cwd: project,
    bin,
    log,
    env: { FUSION_DB: dbFile },
  });
  expect(untitled.code).toBe(0);
  expect(storage.getRunDetails(storage.open(), "untitled").title).toBe(storage.DEFAULT_RUN_TITLE);
});

test("plugin-internal relay delegates to the runner and returns a minimal summary", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "relay.db");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "brief.md"), "Plan through the internal CLI", "utf8");

  const common = { cwd: project, bin, log, env: { FUSION_DB: dbFile } };
  expect((await runBun(
    fusionPath,
    ["start", "--run-id", "public-relay", "--project-dir", project, "--title", "Relay plan"],
    common,
  )).code).toBe(0);
  expect((await runBun(
    fusionPath,
    ["put", "--run-id", "public-relay", "--type", "brief", "--file", join(project, "brief.md")],
    common,
  )).code).toBe(0);

  const relay = await runBun(
    fusionPath,
    ["relay", "--run-id", "public-relay", "--timeout-ms", "5000"],
    common,
  );
  expect(relay.code).toBe(0);
  const summary = json(relay.stdout);
  expect(summary.ok).toBe(true);
  expect(summary.command).toBe("relay");
  expect(summary.codexAvailable).toBe(true);
  expect(summary.models).toBeUndefined();
  expect(summary.legs).toBeUndefined();

  const logs = await readLogs(log);
  expect(logs.some((entry) => entry.tool === "codex" && entry.args[0] === "exec")).toBe(true);
});

test("doctor keeps diagnostics on stderr and JSON on stdout", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const result = await runBun(fusionPath, ["doctor"], { cwd: root, bin, log });

  expect(result.code).toBe(0);
  expect(json(result.stdout)).toEqual({ ok: true, command: "doctor" });
  expect(result.stderr).toContain("Fusion ready");
});

test("plugin-internal CLI rejects bad commands and SKILL.md uses only the cross-platform entrypoint", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);

  for (const args of [
    ["unknown"],
    ["put", "--type", "brief"],
    ["put", "--run-id", "x", "--type", "review"],
    ["start", "--mode", "plan"],
    ["finish", "--run-id", "x", "--status", "failed"],
    ["start", "--typo", "value"],
  ]) {
    const result = await runBun(fusionPath, args, { cwd: root, bin, log });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fusion");
  }

  const skill = await readFile(join(fusionRoot, "SKILL.md"), "utf8");
  expect(skill).toContain("${CLAUDE_SKILL_DIR}/fusion.ts");
  expect(skill).not.toMatch(/\$(HOME|PWD|RANDOM)\b|\$\(|\/dev\/null/);
  expect(skill).not.toMatch(/skills\/fusion\/(storage|runner|dashboard|doctor)\.ts/);
});
