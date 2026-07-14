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

test("relay surfaces the runner's failure receipt to the host instead of a bare exit code", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "relay-fail.db");
  await mkdir(project, { recursive: true });
  const common = { cwd: project, bin, log, env: { FUSION_DB: dbFile } };

  // A run with NO stored brief and nothing piped → the runner hits its empty-brief fatal path and
  // prints a receipt. relay must parse that receipt and re-emit it as ok:false with a non-zero exit.
  expect((await runBun(
    fusionPath,
    ["start", "--run-id", "relay-fail", "--project-dir", project, "--title", "Relay fail"],
    common,
  )).code).toBe(0);

  const relay = await runBun(fusionPath, ["relay", "--run-id", "relay-fail", "--timeout-ms", "5000"], common);
  expect(relay.code).not.toBe(0);
  const summary = json(relay.stdout);
  expect(summary.ok).toBe(false);
  expect(summary.command).toBe("relay");
  expect(summary.codexAvailable).toBe(false);
  expect(summary.category).toBe("unknown");
});

test("start gate: a passing preflight creates the run and marks preflight ok", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "gate-pass.db");
  await mkdir(project, { recursive: true });

  const start = await runBun(fusionPath, ["start", "--run-id", "gated", "--project-dir", project, "--title", "Gated plan"], {
    cwd: project,
    bin,
    log,
    env: { FUSION_DB: dbFile },
  });
  expect(start.code).toBe(0);
  const started = json(start.stdout);
  expect(started.ok).toBe(true);
  expect(started.preflight).toBe("ok");

  process.env.FUSION_DB = dbFile;
  expect(storage.getRunDetails(storage.open(), "gated").title).toBe("Gated plan");
});

test("start gate: a failing preflight refuses to create a run and returns the reason + fix", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });

  for (const [label, env] of [
    ["not-installed", { FAKE_CODEX_VERSION_FAIL: "1" }],
    ["not-logged-in", { FAKE_CODEX_STATUS: "not logged in" }],
    // Stale CLI is now caught by the ping itself (its argv is rejected) — there is no separate flags check.
    ["stale-cli", { FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "unexpected argument '--ephemeral' found" }],
    ["model-ping-fails", { FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "insufficient credits" }],
  ] as const) {
    const dbFile = join(root, `gate-${label}.db`);
    const start = await runBun(fusionPath, ["start", "--run-id", "should-not-exist", "--project-dir", project], {
      cwd: project,
      bin,
      log,
      env: { ...env, FUSION_DB: dbFile },
    });
    expect(start.code).not.toBe(0); // non-zero exit
    const failed = json(start.stdout);
    expect(failed.ok).toBe(false);
    expect(failed.stage).toBe("preflight");
    expect(typeof failed.reason).toBe("string");
    expect(failed.fix.length).toBeGreaterThan(0);

    // The whole point of the gate: NO run row (and no side effects) when preflight fails.
    process.env.FUSION_DB = dbFile;
    const count = (storage.open().query("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    expect(count).toBe(0);
  }
});

test("blind rule: get/export codex_report refuse until claude_report is saved, then succeed", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "blind.db");
  await mkdir(project, { recursive: true });
  const common = { cwd: project, bin, log, env: { FUSION_DB: dbFile } };

  // Seed a run that already has a codex_report but NOT a claude_report (the exact ordering the rule guards).
  process.env.FUSION_DB = dbFile;
  const db = storage.open();
  const proj = await storage.resolveProject(project);
  storage.ensureProject(db, proj);
  storage.startRun(db, { runId: "blind", projectId: proj.id });
  storage.putArtifact(db, "blind", "codex_report", "codex leg content");

  // get refuses.
  const blockedGet = await runBun(fusionPath, ["get", "--run-id", "blind", "--type", "codex_report"], common);
  expect(blockedGet.code).not.toBe(0);
  expect(blockedGet.stdout).toBe("");
  expect(blockedGet.stderr).toContain("blind rule");

  // export refuses too (same guard, so a plan can't be smuggled out to disk either).
  const blockedExport = await runBun(
    fusionPath,
    ["export", "--run-id", "blind", "--type", "codex_report", "--out", join(project, "leak.md")],
    common,
  );
  expect(blockedExport.code).not.toBe(0);
  expect(blockedExport.stderr).toContain("blind rule");

  // Save the host's own leg → the guard clears.
  storage.putArtifact(db, "blind", "claude_report", "my own leg");
  const allowedGet = await runBun(fusionPath, ["get", "--run-id", "blind", "--type", "codex_report"], common);
  expect(allowedGet.code).toBe(0);
  expect(json(allowedGet.stdout).content).toBe("codex leg content");
});

test("put refuses empty/whitespace-only content and stores nothing", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "empty-put.db");
  await mkdir(project, { recursive: true });
  const common = { cwd: project, bin, log, env: { FUSION_DB: dbFile } };

  process.env.FUSION_DB = dbFile;
  const db = storage.open();
  const proj = await storage.resolveProject(project);
  storage.ensureProject(db, proj);
  storage.startRun(db, { runId: "empty", projectId: proj.id });
  // A real codex_report exists, so ONLY the empty claude_report put (rejected below) stands between
  // the host and reading it — proving nothing was stored keeps the blind gate shut.
  storage.putArtifact(db, "empty", "codex_report", "codex leg content");

  const whitespaceFile = join(root, "whitespace.md");
  await writeFile(whitespaceFile, "   \n\t  \n", "utf8");
  const put = await runBun(
    fusionPath,
    ["put", "--run-id", "empty", "--type", "claude_report", "--file", whitespaceFile],
    common,
  );
  expect(put.code).not.toBe(0);
  expect(put.stdout).toBe("");
  expect(put.stderr).toContain("refusing to store empty content");

  // Nothing was stored → the blind rule still refuses to reveal the codex_report.
  const blockedGet = await runBun(fusionPath, ["get", "--run-id", "empty", "--type", "codex_report"], common);
  expect(blockedGet.code).not.toBe(0);
  expect(blockedGet.stderr).toContain("blind rule");
});

test("get/export on a non-existent run report 'run not found', not the blind-rule message", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "ghost.db");
  await mkdir(project, { recursive: true });
  const common = { cwd: project, bin, log, env: { FUSION_DB: dbFile } };

  const get = await runBun(fusionPath, ["get", "--run-id", "ghost", "--type", "codex_report"], common);
  expect(get.code).not.toBe(0);
  expect(get.stderr).toContain("run not found");
  expect(get.stderr).not.toContain("blind rule");

  const exported = await runBun(
    fusionPath,
    ["export", "--run-id", "ghost", "--type", "codex_report", "--out", join(project, "x.md")],
    common,
  );
  expect(exported.code).not.toBe(0);
  expect(exported.stderr).toContain("run not found");
  expect(exported.stderr).not.toContain("blind rule");
});

test("list/status/abort power the resume flow", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  const dbFile = join(root, "resume.db");
  await mkdir(project, { recursive: true });
  const common = { cwd: project, bin, log, env: { FUSION_DB: dbFile } };

  process.env.FUSION_DB = dbFile;
  const db = storage.open();
  const proj = await storage.resolveProject(project);
  storage.ensureProject(db, proj);
  storage.startRun(db, { runId: "resumable", projectId: proj.id, title: "Interrupted run" });
  storage.putArtifact(db, "resumable", "brief", "the brief");

  // list shows the incomplete run with its artifact map.
  const list = await runBun(fusionPath, ["list"], common);
  expect(list.code).toBe(0);
  const runs = json(list.stdout).runs;
  expect(runs).toHaveLength(1);
  expect(runs[0].runId).toBe("resumable");
  expect(runs[0].artifacts).toEqual({ brief: true, claudeReport: false, codexReport: false, plan: false });

  // status returns the same shape for one run.
  const status = await runBun(fusionPath, ["status", "--run-id", "resumable"], common);
  expect(status.code).toBe(0);
  expect(json(status.stdout).run.status).toBe("running");

  // abort marks it aborted; it then drops out of the incomplete list.
  const abort = await runBun(fusionPath, ["abort", "--run-id", "resumable"], common);
  expect(abort.code).toBe(0);
  expect(json(abort.stdout).status).toBe("aborted");
  expect(json((await runBun(fusionPath, ["list"], common)).stdout).runs).toHaveLength(0);

  // aborting again errors politely (non-zero); status still reads it back as aborted.
  const reabort = await runBun(fusionPath, ["abort", "--run-id", "resumable"], common);
  expect(reabort.code).not.toBe(0);
  expect(reabort.stderr).toContain("already aborted");
  expect(json((await runBun(fusionPath, ["status", "--run-id", "resumable"], common)).stdout).run.status).toBe("aborted");

  // finish must NOT resurrect the aborted run — it errors cleanly and the status stays aborted.
  const finishAborted = await runBun(fusionPath, ["finish", "--run-id", "resumable"], common);
  expect(finishAborted.code).not.toBe(0);
  expect(finishAborted.stdout).toBe("");
  expect(finishAborted.stderr).toContain("cannot complete an aborted run");
  expect(json((await runBun(fusionPath, ["status", "--run-id", "resumable"], common)).stdout).run.status).toBe("aborted");
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
  expect(skill).not.toMatch(/skills\/fusion\/(storage|runner|dashboard)\.ts/);
});

test("dashboard --stop with nothing running is a clean no-op through the CLI", async () => {
  const root = await makeTempDir();
  const { bin, log } = await makeFakeBin(root);
  // A quiet port range (no listener) — the command must answer stopped:false, exit 0, no error.
  const result = await runBun(fusionPath, ["dashboard", "--stop", "--port", "39777"], {
    cwd: root,
    bin,
    log,
    env: { FUSION_DB: join(root, "fusion.db") },
  });
  expect(result.code).toBe(0);
  const summary = json(result.stdout);
  expect(summary.ok).toBe(true);
  expect(summary.stopped).toBe(false);
  expect(summary.port).toBeUndefined();
});
