import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { makeFakeBin, runBun } from "./helpers/fake-cli";
import { useTempDirs } from "./helpers/temp";

const probePath = resolve(import.meta.dir, "helpers/preflight-probe.ts");
const tempDir = useTempDirs("fusion-preflight-test-");

function probe(stdout: string): any {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("preflight passes end-to-end when Codex is installed, authed, and the model replies READY", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log });
  const r = probe(res.stdout);
  expect(r.ok).toBe(true);
  expect(r.failures).toEqual([]);
});

test("preflight fails at install when codex --version fails, and does not run later checks", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log, env: { FAKE_CODEX_VERSION_FAIL: "1" } });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.failures).toHaveLength(1); // short-circuits — login/ping never run
  expect(r.failures[0].check).toBe("install");
  expect(r.failures[0].fix).toContain("npm i -g @openai/codex");
});

test("preflight fails at login when codex is not authenticated", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], { cwd: root, bin, log, env: { FAKE_CODEX_STATUS: "not logged in" } });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.failures).toHaveLength(1); // ping never runs when login fails
  expect(r.failures[0].check).toBe("login");
  expect(r.failures[0].fix).toBe("codex login");
});

test("preflight fails at the model ping on a quota error, with a human fix and no doctor pointer", async () => {
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
  expect(r.failures[0].check).toBe("ping");
  expect(r.failures[0].reason).toContain("insufficient credits");
  // D2: quota maps to a plain-English wait-and-retry fix, never a `fusion doctor` pointer.
  expect(r.failures[0].fix).toContain("usage limit is exhausted");
  expect(r.failures[0].fix).not.toMatch(/doctor/i);
});

test("preflight fails at the model ping when the CLI rejects a runner flag (stale CLI → update)", async () => {
  const root = await tempDir();
  const { bin, log } = await makeFakeBin(root);
  const res = await runBun(probePath, [], {
    cwd: root,
    bin,
    log,
    env: { FAKE_CODEX_EXIT: "1", FAKE_CODEX_ERROR: "unexpected argument '--ephemeral' found" },
  });
  const r = probe(res.stdout);
  expect(r.ok).toBe(false);
  expect(r.failures[0].check).toBe("ping");
  expect(r.failures[0].fix).toContain("@openai/codex@latest");
});
