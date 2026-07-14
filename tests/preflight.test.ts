import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { makeFakeBin, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const probePath = resolve(import.meta.dir, "helpers/preflight-probe.ts");
const tempDir = useTempDirs("fusion-preflight-test-");

function probe(stdout: string): any {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("preflight passes end-to-end when Codex is installed, authed, flag-compatible, and the model replies READY", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log });
  const r = probe(res.stdout);
  expect(r.ok).toBe(true);
  expect(r.install).toBe(true);
  expect(r.login).toBe(true);
  expect(r.flags).toBe(true);
  expect(r.ping).toBe(true);
  expect(r.failures).toEqual([]);
  // Auth-passes-but-credits-not-guaranteed caveat is surfaced as a non-fatal warning.
  expect(r.warnings.join(" ")).toContain("credits/quota");
});

test("preflight fails at install when codex --version fails, and does not run later checks", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log, env: { FAKE_CODEX_VERSION_FAIL: "1" } });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.install).toBe(false);
  expect(r.login).toBeNull(); // short-circuited
  expect(r.ping).toBeNull();
  expect(r.failures[0].check).toBe("install");
  expect(r.failures[0].fix).toContain("npm i -g @openai/codex");
});

test("preflight fails at login when codex is not authenticated", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log, env: { FAKE_CODEX_STATUS: "not logged in" } });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.install).toBe(true);
  expect(r.login).toBe(false);
  expect(r.ping).toBeNull(); // ping never runs when login fails
  expect(r.failures[0].check).toBe("login");
  expect(r.failures[0].fix).toBe("codex login");
});

test("preflight fails at flags when the exec help is missing required flags (stale CLI)", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log, env: { FAKE_CODEX_HELP: "missing-flags" } });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.login).toBe(true);
  expect(r.flags).toBe(false);
  expect(r.ping).toBeNull();
  expect(r.failures[0].check).toBe("flags");
  expect(r.failures[0].fix).toContain("@openai/codex@latest");
});

test("preflight fails at the model ping when the configured model errors (quota), with an actionable reason", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], {
    cwd: root,
    bin,
    log,
    env: { FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "insufficient credits for the requested model", FAKE_CODEX_ERROR_STATUS: "429" },
  });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.install).toBe(true);
  expect(r.login).toBe(true);
  expect(r.flags).toBe(true);
  expect(r.ping).toBe(false);
  expect(r.pingDetail).toContain("insufficient credits");
  expect(r.failures[0].check).toBe("ping");
});
