import { expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as storage from "../plugin/skills/fusion/storage";
import { advisorFailureReason, advisorOutPath } from "../plugin/skills/fusion/runner/advisor";
import { makeFakeBin, readLogs, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const fusionRoot = resolve(import.meta.dir, "../plugin/skills/fusion");
const runnerPath = join(fusionRoot, "runner.ts");
const tempDir = useTempDirs("fusion-advisor-test-");

const APPROVED = "CONCERNS\n- None\n\nUSER DECISION NEEDED\n- None.\n\nCONFIDENCE\nhigh — clean\n\nVERDICT: APPROVE";

// Seed a project + run with the given artifacts and return the shared context for a runner call.
async function seedRun(
  runId: string,
  artifacts: Partial<Record<storage.ArtifactType, string>>,
): Promise<{ root: string; project: string; dbFile: string; bin: string; log: string; db: ReturnType<typeof storage.open> }> {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const dbFile = join(root, "advisor.db");
  process.env.FUSION_DB = dbFile;
  const db = storage.open();
  const proj = await storage.resolveProject(project);
  storage.ensureProject(db, proj);
  storage.startRun(db, { runId, projectId: proj.id });
  for (const [type, content] of Object.entries(artifacts)) {
    storage.putArtifact(db, runId, type as storage.ArtifactType, content);
  }
  return { root, project, dbFile, bin, log, db };
}

function summaryOf(stdout: string): Record<string, any> {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("advisor success: dual packet on stdin, verdict saved, prior failure marker cleared, tmpfile gone", async () => {
  const ctx = await seedRun("adv-ok", {
    brief: "the brief",
    claude_report: "claude leg",
    codex_report: "codex leg",
    plan: "the plan",
  });
  // A prior failed attempt stamped the row — success must clear it (retry idempotence).
  storage.recordAdvisorFailure(ctx.db, "adv-ok", "timed out after 1ms", "transient");

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-ok", "--timeout-ms", "5000"], {
    cwd: ctx.root, // NOT the project dir — projectDir must come from the DB
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_OUTPUT: APPROVED },
  });

  expect(result.code).toBe(0);
  expect(summaryOf(result.stdout)).toEqual({
    runId: "adv-ok",
    advisorAvailable: true,
    mode: "dual",
    verdict: "APPROVE",
  });

  const detail = storage.getRunDetails(ctx.db, "adv-ok");
  expect(detail.advisorReport).toBe(APPROVED);
  expect(detail.advisorFailReason).toBeNull();
  expect(detail.advisorFailCategory).toBeNull();

  const codex = (await readLogs(ctx.log)).find((entry) => entry.tool === "codex" && entry.args[0] === "exec")!;
  expect(codex.cwd).toBe(await realpath(ctx.project)); // resolved from the DB, not the invocation cwd
  expect(codex.stdinPreview).toContain("You are a rigorous, skeptical senior reviewer");
  const outPath = codex.args[codex.args.indexOf("-o") + 1] as string;
  expect(outPath).toContain("fusion-advisor-adv-ok-");
  expect(await Bun.file(outPath).exists()).toBe(false); // finally-deleted
});

test("advisor single mode: a missing codex_report auto-selects the brief+plan-only packet", async () => {
  const ctx = await seedRun("adv-single", { brief: "the brief", claude_report: "claude leg", plan: "the plan" });

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-single", "--timeout-ms", "5000"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_OUTPUT: APPROVED },
  });

  expect(result.code).toBe(0);
  const summary = summaryOf(result.stdout);
  expect(summary.mode).toBe("single");
  expect(summary.advisorAvailable).toBe(true);
});

test("advisor malformed verdict: fail-open, raw text STILL saved for debugging, marker set", async () => {
  const ctx = await seedRun("adv-bad", { brief: "the brief", plan: "the plan" });

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-bad", "--timeout-ms", "5000"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_OUTPUT: "looks fine to me, ship it" },
  });

  expect(result.code).toBe(0); // fail-open: a leg failure is not a process failure
  const summary = summaryOf(result.stdout);
  expect(summary.advisorAvailable).toBe(false);
  expect(summary.reason).toContain("malformed verdict");
  expect(summary.category).toBe("unknown");

  const detail = storage.getRunDetails(ctx.db, "adv-bad");
  expect(detail.advisorReport).toBe("looks fine to me, ship it"); // raw text saved
  expect(detail.advisorFailReason).toContain("malformed verdict"); // but marked invalid — never folded
});

test("advisor empty output: treated as malformed — the empty raw evicts a stale report, marker set", async () => {
  const ctx = await seedRun("adv-empty", { brief: "the brief", plan: "the plan" });
  // A stale verdict from a previous attempt: the empty overwrite must evict it, so the on-demand
  // raw fetch always reflects the LATEST attempt (unlike a codex-level failure, which keeps it).
  storage.putArtifact(ctx.db, "adv-empty", "advisor_report", APPROVED);

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-empty", "--timeout-ms", "5000"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_OUTPUT: "" },
  });

  expect(result.code).toBe(0); // fail-open
  const summary = summaryOf(result.stdout);
  expect(summary.advisorAvailable).toBe(false);
  expect(summary.reason).toContain("malformed verdict");
  expect(summary.category).toBe("unknown");

  const detail = storage.getRunDetails(ctx.db, "adv-empty");
  expect(detail.advisorReport).toBe(""); // raw (empty) saved — the stale report is gone
  expect(detail.advisorFailReason).toContain("malformed verdict");
});

test("advisor timeout: classified transient, marker recorded, previous report survives", async () => {
  const ctx = await seedRun("adv-timeout", { brief: "the brief", plan: "the plan" });
  storage.putArtifact(ctx.db, "adv-timeout", "advisor_report", APPROVED);

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-timeout", "--timeout-ms", "500"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    // The fake codex sleeps far past the 500ms ceiling — runProc SIGTERMs it mid-sleep.
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_SLEEP_MS: "30000", FAKE_CODEX_OUTPUT: APPROVED },
  });

  expect(result.code).toBe(0); // fail-open
  const summary = summaryOf(result.stdout);
  expect(summary.advisorAvailable).toBe(false);
  expect(summary.reason).toBe("timed out after 500ms");
  expect(summary.category).toBe("transient");

  const detail = storage.getRunDetails(ctx.db, "adv-timeout");
  expect(detail.advisorReport).toBe(APPROVED); // a timeout never touches the report slot
  expect(detail.advisorFailReason).toBe("timed out after 500ms");
  expect(detail.advisorFailCategory).toBe("transient");
});

test("advisor failed single-degraded: degradedReason survives into the failure summary", async () => {
  const big = "x".repeat(300 * 1024); // 2 × 300 KB reports push the combined packet past 500 KB
  const ctx = await seedRun("adv-degraded-fail", {
    brief: "the brief",
    claude_report: big,
    codex_report: big,
    plan: "the plan",
  });

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-degraded-fail", "--timeout-ms", "5000"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "429 too many requests" },
  });

  expect(result.code).toBe(0);
  const summary = summaryOf(result.stdout);
  expect(summary.advisorAvailable).toBe(false);
  expect(summary.mode).toBe("single-degraded");
  expect(summary.degradedReason).toBe("size"); // the size fallback is never silent, even on a drop
  expect(summary.category).toBe("quota");
});

test("advisor failed retry: the previous report survives, only the failure marker is stamped", async () => {
  const ctx = await seedRun("adv-retry", { brief: "the brief", plan: "the plan" });
  // A previous successful attempt left a valid verdict in the slot.
  storage.putArtifact(ctx.db, "adv-retry", "advisor_report", APPROVED);

  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "adv-retry", "--timeout-ms", "5000"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile, FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "429 too many requests" },
  });

  expect(result.code).toBe(0);
  const summary = summaryOf(result.stdout);
  expect(summary.advisorAvailable).toBe(false);
  expect(summary.reason).toBe("GPT quota exhausted — re-run advise after it resets");
  expect(summary.category).toBe("quota");

  const detail = storage.getRunDetails(ctx.db, "adv-retry");
  expect(detail.advisorReport).toBe(APPROVED); // NOT cleared by the failed retry
  expect(detail.advisorFailReason).toBe("GPT quota exhausted — re-run advise after it resets");
  expect(detail.advisorFailCategory).toBe("quota");
});

test("advisor for an unknown run: JSON receipt with advisorAvailable:false and a non-zero exit", async () => {
  const ctx = await seedRun("adv-exists", { brief: "b", plan: "p" });
  const result = await runBun(runnerPath, ["--leg", "advisor", "--run-id", "ghost"], {
    cwd: ctx.project,
    bin: ctx.bin,
    log: ctx.log,
    env: { FUSION_DB: ctx.dbFile },
  });
  expect(result.code).not.toBe(0);
  const summary = summaryOf(result.stdout);
  expect(summary.advisorAvailable).toBe(false);
  expect(summary.reason).toContain("run not found");
});

test("advisorOutPath is unique per attempt and sanitizes the runId out of path traversal", () => {
  const first = advisorOutPath("run-1");
  const second = advisorOutPath("run-1");
  expect(first).not.toBe(second); // concurrent attempts can never race on one file
  expect(first).toContain("fusion-advisor-run-1-");
  expect(first.endsWith(".txt")).toBe(true);

  const hostile = advisorOutPath("../../etc/passwd");
  expect(hostile).toContain("fusion-advisor-.._.._etc_passwd-");
});

test("advisorFailureReason maps failures to single-line advise-appropriate fixes (never '/fusion again')", () => {
  const cases: Array<[string, string]> = [
    ["codex exited 1: [429] insufficient credits", "GPT quota exhausted — re-run advise after it resets"],
    ["codex exited 1: usage limit reached", "GPT quota exhausted — re-run advise after it resets"],
    ["codex could not start: spawn codex ENOENT", "Codex isn't installed (or not on PATH) — install: npm i -g @openai/codex, then: codex login"],
    ["codex exited 1: unexpected argument '--json' found", "Codex CLI is stale — update: npm i -g @openai/codex@latest, then re-run advise"],
    ["codex exited 1: not logged in", "Codex isn't logged in — run: codex login, then re-run advise"],
  ];
  for (const [raw, expected] of cases) {
    const reason = advisorFailureReason(raw);
    expect(reason).toBe(expected);
    expect(reason).not.toContain("\n"); // always single-line
    expect(reason).not.toContain("/fusion");
  }
  // Unrecognized reasons pass through, collapsed to one line.
  expect(advisorFailureReason("codex exited 1: strange\n  multi-line error")).toBe("codex exited 1: strange multi-line error");
  expect(advisorFailureReason("timed out after 900000ms")).toBe("timed out after 900000ms");
});
