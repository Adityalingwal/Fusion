import { delimiter, extname, join } from "node:path";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const KILL_GRACE_MS = 2_000; // after SIGTERM, wait this long, then escalate to SIGKILL
const DRAIN_GRACE_MS = 3_000; // after the kill, allow pipes this long to reach EOF before giving up

const POWERSHELL_BATCH_LAUNCHER = `
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FUSION_SPAWN_SPEC)) | ConvertFrom-Json
& $spec.executable @($spec.arguments)
if ($null -eq $LASTEXITCODE) { exit 1 }
exit $LASTEXITCODE
`.trim();

// Bun.spawn executes native binaries directly. On Windows, npm-style global CLIs are commonly
// exposed as .cmd/.bat shims, which need a command interpreter. Keep all dynamic values out of the
// PowerShell source and transfer them as base64 JSON so paths/arguments cannot become shell code.
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function mergeEnvironment(
  ...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (process.platform === "win32") {
        const duplicate = Object.keys(merged).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
        if (duplicate) delete merged[duplicate];
      }
      merged[key] = value;
    }
  }
  return merged;
}

async function findWindowsExecutable(command: string, env: Record<string, string | undefined>): Promise<string> {
  const found = Bun.which(command);
  if (found) return found;

  const hasPath = /[\\/]/.test(command);
  const directories = hasPath ? [""] : (envValue(env, "PATH") || "").split(delimiter);
  const extensions = extname(command)
    ? [""]
    : (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);

  for (const rawDirectory of directories) {
    const directory = rawDirectory.replace(/^"|"$/g, "");
    for (const extension of extensions) {
      const candidate = directory ? join(directory, `${command}${extension}`) : `${command}${extension}`;
      if (await Bun.file(candidate).exists()) return candidate;
    }
  }
  return command;
}

async function resolveCommand(
  cmd: string[],
  env: Record<string, string | undefined>,
): Promise<{ cmd: string[]; env?: Record<string, string> }> {
  if (process.platform !== "win32") return { cmd };
  const executable = await findWindowsExecutable(cmd[0], env);
  if (!/\.(cmd|bat)$/i.test(executable)) return { cmd: [executable, ...cmd.slice(1)] };
  const spec = Buffer.from(JSON.stringify({ executable, arguments: cmd.slice(1) }), "utf8").toString("base64");
  return {
    cmd: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_BATCH_LAUNCHER],
    env: { FUSION_SPAWN_SPEC: spec },
  };
}

// Resolve to the awaited value, or null if `ms` elapses first — so a read that never reaches EOF
// (e.g. a lingering grandchild still holding stdout) can't hang the caller forever.
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

function forceKill(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    proc.kill(9);
  } catch {
    /* already gone */
  }
}

// A Windows .cmd/.bat relay runs as PowerShell -> cmd.exe -> actual CLI. Terminating only the
// PowerShell PID leaves its descendants alive, so use the built-in taskkill tree mode. The command
// contains only the numeric PID returned by Bun; no user-controlled text reaches a shell.
function killWindowsProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    const killer = Bun.spawn(["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    void killer.exited.then((code) => {
      if (code !== 0) forceKill(proc);
    }, () => forceKill(proc));
  } catch {
    forceKill(proc);
  }
}

// Run a child process with a hard timeout, draining stdout/stderr concurrently with any stdin write.
// A large prompt can exceed the OS pipe buffer, so we must read while we write.
export async function runProc(
  cmd: string[],
  opts: { stdin?: string; timeoutMs: number; cwd?: string; env?: Record<string, string> },
): Promise<ProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const env = mergeEnvironment(process.env, opts.env);
    const resolved = await resolveCommand(cmd, env);
    proc = Bun.spawn(resolved.cmd, {
      cwd: opts.cwd,
      env: mergeEnvironment(env, resolved.env),
      stdin: opts.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // Binary not on PATH (ENOENT) or spawn refused — degrade instead of throwing, so callers fail
    // open: runText → null, runCodexLeg → failed result when a tool like codex is absent.
    return { code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }

  let timedOut = false;
  // A "hard timeout" that only sends SIGTERM can still hang the runner: a child that ignores
  // SIGTERM (or whose grandchild keeps a pipe open) never lets proc.exited / the reads settle.
  // Escalate SIGTERM → SIGKILL after a grace window, then cap the whole wait with an absolute
  // deadline so the call ALWAYS returns rather than wedging the host.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      killWindowsProcessTree(proc);
      return;
    }
    try {
      proc.kill(); // SIGTERM — ask politely first
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      forceKill(proc); // SIGKILL — cannot be caught or ignored
    }, KILL_GRACE_MS);
  }, opts.timeoutMs);

  const writeStdin = (async () => {
    if (opts.stdin === undefined) return;
    try {
      proc.stdin.write(opts.stdin);
      await proc.stdin.end();
    } catch {
      /* child closed stdin early — exit code tells the story */
    }
  })();

  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    writeStdin,
    proc.exited,
  ]);
  const result = await raceDeadline(collected, opts.timeoutMs + KILL_GRACE_MS + DRAIN_GRACE_MS);
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  if (!result) {
    // Deadline hit even after SIGKILL — a grandchild is holding the pipe open. Give up the read
    // instead of hanging; the killed leg is reported as a timeout.
    return { code: null, stdout: "", stderr: "killed: child did not exit after SIGKILL", timedOut: true };
  }
  const [stdout, stderr, , code] = result;
  return { code, stdout, stderr, timedOut };
}

export function lastStderr(s: string): string {
  return s.trim().split("\n").slice(-2).join(" | ") || "no stderr";
}

export async function runText(cmd: string[], cwd: string, timeoutMs = 10_000): Promise<string | null> {
  const res = await runProc(cmd, { cwd, timeoutMs });
  if (res.timedOut || res.code !== 0) return null;
  return `${res.stdout}\n${res.stderr}`.trim() || null;
}
