#!/usr/bin/env bun
// Single plugin-internal Fusion command surface. SKILL.md calls only this file; runner/storage/dashboard
// remain internal implementation details that can move without changing the skill contract.

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchDashboard, stopRunningDashboard } from "./dashboard";
import { preflightProvider } from "./lib/preflight";
import * as storage from "./storage";

type CliValue = string | boolean | undefined;
type CliValues = Record<string, CliValue>;

const stringOption = { type: "string" as const };
const OPTIONS_BY_COMMAND = {
  start: {
    "run-id": stringOption,
    "project-dir": stringOption,
    title: stringOption,
    host: stringOption,
    provider: stringOption,
  },
  put: { "run-id": stringOption, type: stringOption, file: stringOption },
  get: { "run-id": stringOption, type: stringOption },
  relay: {
    "run-id": stringOption,
    "project-dir": stringOption,
    "brief-file": stringOption,
    "timeout-ms": stringOption,
    host: stringOption,
    provider: stringOption,
  },
  finish: { "run-id": stringOption },
  export: { "run-id": stringOption, type: stringOption, out: stringOption },
  list: {},
  status: { "run-id": stringOption },
  abort: { "run-id": stringOption },
  dashboard: { port: stringOption, stop: { type: "boolean" as const } },
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

// The blind rule, enforced in code (the "taala"). A host cannot read/export the external provider's
// report until its own report exists. No --force override.
function assertBlindRuleSatisfied(
  db: ReturnType<typeof storage.open>,
  runId: string,
  type: storage.ArtifactType,
): void {
  const hostModel = storage.getRunHostModel(db, runId);
  if (hostModel === null) throw new CliError(`run not found: ${runId}`);
  const providerType: storage.ArtifactType = hostModel === "claude" ? "codex_report" : "claude_report";
  const hostType: storage.ArtifactType = hostModel === "claude" ? "claude_report" : "codex_report";
  if (type !== providerType) return;
  const hostReport = storage.getArtifact(db, runId, hostType);
  if (hostReport === null || hostReport.trim() === "") {
    throw new CliError(
      `blind rule: save your ${hostType} first — Fusion refuses to reveal the ${providerType} until your own leg is written (independence is the whole point).`,
    );
  }
}

async function readInput(file: string | undefined): Promise<string> {
  return file ? await Bun.file(resolve(file)).text() : await Bun.stdin.text();
}

async function runInternal(script: "runner.ts", args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, script), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
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
      const projectDir = resolve(optionalString(args, "project-dir") ?? process.cwd());
      let selection: ReturnType<typeof storage.resolveHostProvider>;
      try {
        selection = storage.resolveHostProvider(optionalString(args, "host"), optionalString(args, "provider"));
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error), 2);
      }
      const requestedRunId = optionalString(args, "run-id");
      let db: ReturnType<typeof storage.open> | undefined;
      const assertStoredSelection = (candidate: ReturnType<typeof storage.open>, runId: string): void => {
        const storedHost = storage.getRunHostModel(candidate, runId);
        if (storedHost !== null && storedHost !== selection.hostModel) {
          throw new CliError(
            `host/provider mismatch for ${runId}: stored ${storedHost}/${storage.oppositeModel(storedHost)}, requested ${selection.hostModel}/${selection.providerModel}`,
            2,
          );
        }
      };
      // An explicit run id may refer to a resumable run. Reject a conflicting selection before
      // pinging the wrong provider. Keep the old no-run behavior side-effect free by opening SQLite
      // early only when its file already exists.
      if (requestedRunId && existsSync(storage.dbPath())) {
        db = storage.open();
        assertStoredSelection(db, requestedRunId);
      }
      // Fail-fast gate: verify the external provider end-to-end (install → login → real model ping)
      // BEFORE creating any run row. A broken provider would otherwise degrade Fusion to a pointless
      // single-model plan only AFTER most host tokens are spent — so refuse here, create nothing, and
      // hand back the reason + copy-paste fix. No skip flag, no env escape hatch.
      const pre = await preflightProvider(selection.providerModel, projectDir);
      if (!pre.ok) {
        const failure = pre.failures[0];
        writeJson({ ok: false, command, stage: "preflight", reason: failure.reason, fix: failure.fix });
        process.exitCode = 1; // natural non-zero exit; stdout above is fully flushed first
        return;
      }
      const runId = requestedRunId ?? generatedRunId();
      db ??= storage.open();
      // Recheck after preflight in case another process created the same run while the ping ran.
      assertStoredSelection(db, runId);
      const project = await storage.resolveProject(projectDir);
      storage.ensureProject(db, project);
      storage.startRun(db, {
        runId,
        projectId: project.id,
        title: optionalString(args, "title"),
        hostModel: selection.hostModel,
      });
      writeJson({
        ok: true,
        command,
        runId,
        projectId: project.id,
        projectDir: project.root,
        hostModel: selection.hostModel,
        providerModel: selection.providerModel,
        preflight: "ok",
      });
      return;
    }
    case "put": {
      const runId = requiredString(args, "run-id");
      const type = requiredArtifactType(args);
      const db = storage.open();
      ensureRunExists(db, runId);
      const content = await readInput(optionalString(args, "file"));
      // Refuse empty/whitespace-only content: an empty string is non-NULL, so storing it would wrongly
      // satisfy the blind-rule gate and make resume/status report the artifact as present. Nothing is
      // written — the host must write the real content to the file, then re-run put.
      if (content.trim() === "") {
        throw new CliError(`refusing to store empty content for ${type} — write the real content to the file first, then re-run put`);
      }
      storage.putArtifact(db, runId, type, content);
      writeJson({ ok: true, command, runId, type, bytes: new TextEncoder().encode(content).byteLength });
      return;
    }
    case "get": {
      const runId = requiredString(args, "run-id");
      const type = requiredArtifactType(args);
      const db = storage.open();
      ensureRunExists(db, runId);
      assertBlindRuleSatisfied(db, runId, type);
      const content = storage.getArtifact(db, runId, type);
      if (content === null) throw new CliError(`content not found: ${runId}/${type}`);
      writeJson({ ok: true, command, runId, type, content });
      return;
    }
    case "relay": {
      const runId = requiredString(args, "run-id");
      const db = storage.open();
      const storedRun = storage.getRunStatusRecord(db, runId);
      if (storedRun === null) throw new CliError(`run not found: ${runId}`);

      const requestedProjectDir = optionalString(args, "project-dir");
      let projectDir: string;
      if (requestedProjectDir) {
        const requestedProject = await storage.resolveProject(resolve(requestedProjectDir));
        if (requestedProject.id !== storedRun.projectId) {
          throw new CliError(
            `project mismatch for ${runId}: stored project is ${storedRun.projectDir || storedRun.projectId}, requested ${requestedProject.root}`,
            2,
          );
        }
        projectDir = requestedProject.root;
      } else {
        if (!storedRun.projectDir) {
          throw new CliError(`stored project path is missing for ${runId}; pass --project-dir for the original project`, 2);
        }
        projectDir = storedRun.projectDir;
      }

      const childArgs = ["--run-id", runId, "--project-dir", projectDir];
      for (const name of ["brief-file", "timeout-ms", "host", "provider"] as const) {
        const value = optionalString(args, name);
        if (value) childArgs.push(`--${name}`, value);
      }
      const result = await runInternal("runner.ts", childArgs);
      if (result.code !== 0) {
        // The runner always ends with a JSON receipt, even on a fatal path. If one is parseable, relay
        // it to the host as a failure summary (reason + category) instead of a bare exit-code message —
        // mirror the preflight-failure pattern: write JSON, set a non-zero exit, return. Only a truly
        // silent child (no parseable JSON) falls through to the generic throw.
        let summary: Record<string, unknown> | null = null;
        try {
          summary = lastJsonObject(result.stdout);
        } catch {
          summary = null;
        }
        if (summary) {
          writeJson({ ok: false, command, ...summary });
          process.exitCode = 1;
          return;
        }
        throw new CliError(`relay failed with exit code ${result.code}`);
      }
      writeJson({ ok: true, command, ...lastJsonObject(result.stdout) });
      return;
    }
    case "finish": {
      const runId = requiredString(args, "run-id");
      const db = storage.open();
      ensureRunExists(db, runId);
      try {
        storage.finishRun(db, runId);
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
      writeJson({ ok: true, command, runId, status: "completed" });
      return;
    }
    case "export": {
      const runId = requiredString(args, "run-id");
      const type = requiredArtifactType(args);
      const out = resolve(requiredString(args, "out"));
      const db = storage.open();
      ensureRunExists(db, runId);
      assertBlindRuleSatisfied(db, runId, type);
      const content = storage.getArtifact(db, runId, type);
      if (content === null) throw new CliError(`content not found: ${runId}/${type}`);
      await Bun.write(out, content);
      writeJson({ ok: true, command, runId, type, out });
      return;
    }
    case "list": {
      const runs = storage.getIncompleteRuns(storage.open());
      writeJson({ ok: true, command, runs });
      return;
    }
    case "status": {
      const runId = requiredString(args, "run-id");
      const run = storage.getRunStatusRecord(storage.open(), runId);
      if (run === null) throw new CliError(`run not found: ${runId}`);
      writeJson({ ok: true, command, run });
      return;
    }
    case "abort": {
      const runId = requiredString(args, "run-id");
      const db = storage.open();
      try {
        storage.abortRun(db, runId);
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error));
      }
      writeJson({ ok: true, command, runId, status: "aborted" });
      return;
    }
    case "dashboard": {
      const rawPort = optionalString(args, "port");
      const port = rawPort === undefined ? undefined : Number(rawPort);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
        throw new CliError("--port must be an integer between 1 and 65535", 2);
      }
      if (args.stop === true) {
        // Stop whichever session's dashboard is running. No dashboard at all is a clean
        // { stopped: false }; found-but-would-not-die is a real failure and must not read as ok.
        const result = await stopRunningDashboard(port);
        if (!result.stopped && result.port !== undefined) {
          throw new CliError(`found a dashboard on port ${result.port} but could not stop it`);
        }
        writeJson({ ok: true, command, ...result });
        return;
      }
      const { url } = await launchDashboard({ port, log: (line) => console.error(line) });
      writeJson({ ok: true, command, url });
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
