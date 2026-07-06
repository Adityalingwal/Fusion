#!/usr/bin/env bun
// Single plugin-internal Fusion command surface. SKILL.md calls only this file; runner/storage/dashboard/
// doctor remain internal implementation details that can move without changing the skill contract.

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { launchDashboard } from "./dashboard";
import * as storage from "./storage";

type CliValue = string | boolean | undefined;
type CliValues = Record<string, CliValue>;

const stringOption = { type: "string" as const };
const booleanOption = { type: "boolean" as const };
const OPTIONS_BY_COMMAND = {
  start: {
    "run-id": stringOption,
    "project-dir": stringOption,
    title: stringOption,
  },
  put: { "run-id": stringOption, type: stringOption, file: stringOption },
  get: { "run-id": stringOption, type: stringOption },
  relay: {
    "run-id": stringOption,
    "project-dir": stringOption,
    "brief-file": stringOption,
    "timeout-ms": stringOption,
  },
  finish: { "run-id": stringOption },
  export: { "run-id": stringOption, type: stringOption, out: stringOption },
  dashboard: { port: stringOption },
  doctor: { smoke: booleanOption },
} as const;

type Command = keyof typeof OPTIONS_BY_COMMAND;
const COMMANDS = Object.keys(OPTIONS_BY_COMMAND) as Command[];

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

function writeJson(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseCommandArgs(command: Command, argv: string[]): CliValues {
  try {
    return parseArgs({
      args: argv,
      options: OPTIONS_BY_COMMAND[command],
      strict: true,
      allowPositionals: false,
    }).values as CliValues;
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2);
  }
}

function requiredString(args: CliValues, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`missing or invalid required argument --${name}`, 2);
  }
  return value;
}

function optionalString(args: CliValues, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredArtifactType(args: CliValues): storage.ArtifactType {
  const value = requiredString(args, "type");
  try {
    return storage.parseArtifactType(value);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2);
  }
}

function generatedRunId(): string {
  return crypto.randomUUID();
}

function ensureRunExists(db: ReturnType<typeof storage.open>, runId: string): void {
  if (storage.getRunProjectId(db, runId) === null) throw new CliError(`run not found: ${runId}`);
}

async function readInput(file: string | undefined): Promise<string> {
  return file ? await Bun.file(resolve(file)).text() : await Bun.stdin.text();
}

async function runInternal(
  script: "runner.ts" | "doctor.ts",
  args: string[],
  options: { echoStdoutToStderr?: boolean } = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, script), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (options.echoStdoutToStderr && stdout) process.stderr.write(stdout);
  return { code, stdout };
}

function lastJsonObject(text: string): Record<string, unknown> {
  const line = text.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new CliError("internal command returned no JSON summary");
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new CliError("internal command returned an invalid JSON summary");
  }
}

async function execute(command: Command, args: CliValues): Promise<void> {
  switch (command) {
    case "start": {
      const runId = optionalString(args, "run-id") ?? generatedRunId();
      const projectDir = resolve(optionalString(args, "project-dir") ?? process.cwd());
      const db = storage.open();
      const project = await storage.resolveProject(projectDir);
      storage.ensureProject(db, project);
      storage.startRun(db, { runId, projectId: project.id, title: optionalString(args, "title") });
      writeJson({ ok: true, command, runId, projectId: project.id, projectDir: project.root });
      return;
    }
    case "put": {
      const runId = requiredString(args, "run-id");
      const type = requiredArtifactType(args);
      const db = storage.open();
      ensureRunExists(db, runId);
      const content = await readInput(optionalString(args, "file"));
      storage.putArtifact(db, runId, type, content);
      writeJson({ ok: true, command, runId, type, bytes: new TextEncoder().encode(content).byteLength });
      return;
    }
    case "get": {
      const runId = requiredString(args, "run-id");
      const type = requiredArtifactType(args);
      const content = storage.getArtifact(storage.open(), runId, type);
      if (content === null) throw new CliError(`content not found: ${runId}/${type}`);
      writeJson({ ok: true, command, runId, type, content });
      return;
    }
    case "relay": {
      const runId = requiredString(args, "run-id");
      const childArgs = ["--run-id", runId, "--project-dir", optionalString(args, "project-dir") ?? process.cwd()];
      for (const name of ["brief-file", "timeout-ms"] as const) {
        const value = optionalString(args, name);
        if (value) childArgs.push(`--${name}`, value);
      }
      const result = await runInternal("runner.ts", childArgs);
      if (result.code !== 0) throw new CliError(`relay failed with exit code ${result.code}`);
      writeJson({ ok: true, command, ...lastJsonObject(result.stdout) });
      return;
    }
    case "finish": {
      const runId = requiredString(args, "run-id");
      const db = storage.open();
      ensureRunExists(db, runId);
      storage.finishRun(db, runId);
      writeJson({ ok: true, command, runId, status: "completed" });
      return;
    }
    case "export": {
      const runId = requiredString(args, "run-id");
      const type = requiredArtifactType(args);
      const out = resolve(requiredString(args, "out"));
      const content = storage.getArtifact(storage.open(), runId, type);
      if (content === null) throw new CliError(`content not found: ${runId}/${type}`);
      await Bun.write(out, content);
      writeJson({ ok: true, command, runId, type, out });
      return;
    }
    case "dashboard": {
      const rawPort = optionalString(args, "port");
      const port = rawPort === undefined ? undefined : Number(rawPort);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
        throw new CliError("--port must be an integer between 1 and 65535", 2);
      }
      const { url } = await launchDashboard({ port, log: (line) => console.error(line) });
      writeJson({ ok: true, command, url });
      return;
    }
    case "doctor": {
      const childArgs = args.smoke === true ? ["--smoke"] : [];
      const result = await runInternal("doctor.ts", childArgs, { echoStdoutToStderr: true });
      if (result.code !== 0) throw new CliError(`doctor failed with exit code ${result.code}`);
      writeJson({ ok: true, command, smoke: args.smoke === true });
      return;
    }
  }
}

export async function cli(argv: string[]): Promise<void> {
  const command = argv[0] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new CliError(`unknown command '${command ?? ""}'; expected one of: ${COMMANDS.join(", ")}`, 2);
  }
  await execute(command, parseCommandArgs(command, argv.slice(1)));
}

if (import.meta.main) {
  const command = Bun.argv[2] ?? "";
  cli(Bun.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fusion ${command || "cli"}: ${message}`);
    process.exit(error instanceof CliError ? error.exitCode : 1);
  });
}
