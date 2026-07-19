#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const scriptDir = realpathSync(import.meta.dir);
const repositoryRoot = resolve(scriptDir, "../../../..");
const runtime = join(repositoryRoot, "plugin", "skills", "fusion", "fusion.ts");

if (!existsSync(runtime)) {
  console.error(`fusion launcher: shared runtime not found at ${runtime}`);
  process.exit(1);
}

const child = Bun.spawn([process.execPath, runtime, ...Bun.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
