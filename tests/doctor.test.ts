import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { makeFakeBin, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const fusionRoot = resolve(import.meta.dir, "../plugin/skills/fusion");
const doctorPath = join(fusionRoot, "doctor.ts");
const tempDir = useTempDirs("fusion-doctor-test-");

test("doctor does not treat 'not authenticated' as authenticated", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);

  const result = await runBun(doctorPath, [], {
    cwd: root,
    bin,
    log,
    env: { FAKE_CODEX_STATUS: "not logged in" },
  });

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("NOT logged in");
  expect(result.stdout).toContain("Fusion degraded");
});

test("doctor treats 'not currently logged in' as not authenticated", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);

  const result = await runBun(doctorPath, [], {
    cwd: root,
    bin,
    log,
    env: { FAKE_CODEX_STATUS: "not currently logged in" },
  });

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("NOT logged in");
});

test("doctor checks required codex flags and prints quota caveat", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);

  const ok = await runBun(doctorPath, [], { cwd: root, bin, log });
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("found + authed + flags");
  expect(ok.stdout).toContain("credits/quota");

  const missing = await runBun(doctorPath, [], {
    cwd: root,
    bin,
    log,
    env: { FAKE_CODEX_HELP: "missing-flags" },
  });
  expect(missing.code).toBe(1);
  expect(missing.stdout).toContain("incompatible exec flags");
});

test("doctor --smoke probes the relay and fails on credit/relay errors", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);

  const ok = await runBun(doctorPath, ["--smoke"], { cwd: root, bin, log });
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("Smoke test");
  expect(ok.stdout).toContain("responded");

  const failure = await runBun(doctorPath, ["--smoke"], {
    cwd: root,
    bin,
    log,
    env: { FAKE_CODEX_EXIT: "1" },
  });
  expect(failure.code).toBe(1);
  expect(failure.stdout).toContain("Codex smoke");
});
