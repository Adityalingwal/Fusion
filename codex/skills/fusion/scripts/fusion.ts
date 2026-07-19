#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const scriptDir = realpathSync(import.meta.dir);
const repositoryRoot = resolve(scriptDir, "../../../..");
const runtime = join(repositoryRoot, "plugin", "skills", "fusion", "fusion.ts");

if (!existsSync(runtime)) {
  console.error(`fusion launcher: shared runtime not found at ${runtime}`);
  process.exit(1);
}

// DEV GUARD — remove before launch. Every Codex-hosted command defaults to a separate dev database
// so experimental work on this branch can never migrate or corrupt the real ~/.fusion/fusion.db.
// Wired here (not in SKILL.md prose) so no model or human has to remember it per command. An
// explicit FUSION_DB in the environment still wins, as a deliberate override.
const env = { ...process.env };
env.FUSION_DB ??= join(homedir(), ".fusion", "fusion-dev.db");

const child = Bun.spawn([process.execPath, runtime, ...Bun.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
