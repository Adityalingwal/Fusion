import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runProc, runText } from "../plugin/skills/fusion/lib/subprocess";

const MISSING = "definitely-not-a-real-binary-xyz123";

// If a tool is absent, spawning must degrade — not throw — so the runner can fail open.
test("runProc degrades (no throw) when the binary is absent", async () => {
  const res = await runProc([MISSING, "--version"], { timeoutMs: 5000 });
  expect(res.code).toBeNull();
  expect(res.timedOut).toBe(false);
});

test("runText returns null for a missing binary instead of throwing", async () => {
  expect(await runText([MISSING, "--version"], process.cwd())).toBeNull();
});

test("Windows timeout terminates the complete .cmd process tree", async () => {
  if (process.platform !== "win32") return;

  const dir = await mkdtemp(join(tmpdir(), "fusion-process-tree-"));
  const started = join(dir, "started.txt");
  const survived = join(dir, "survived.txt");
  try {
    await Bun.write(join(dir, "fusion-hang.ts"), `
await Bun.write(${JSON.stringify(started)}, "started");
await Bun.sleep(2000);
await Bun.write(${JSON.stringify(survived)}, "survived");
`);
    await Bun.write(
      join(dir, "fusion-hang.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0fusion-hang.ts"\r\n`,
    );

    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH");
    const path = pathKey ? process.env[pathKey] || "" : "";
    const result = await runProc(["fusion-hang"], {
      timeoutMs: 1000,
      env: { PATH: `${dir}${delimiter}${path}` },
    });

    expect(result.timedOut).toBe(true);
    expect(await Bun.file(started).exists()).toBe(true);
    await Bun.sleep(2300);
    expect(await Bun.file(survived).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
