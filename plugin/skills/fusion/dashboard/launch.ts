// Launching the Fusion dashboard: bind the HTTP server (with port-retry) and open the
// user's browser. Request routing and the data layer live in server.ts; this file owns
// everything about getting that server running and in front of the user.

import { handleRequest, setShutdownHandler } from "./server";

const DEFAULT_PORT = Number(process.env.PORT || 38888);
const MAX_PORT_ATTEMPTS = 10;
const PROBE_TIMEOUT_MS = 400;

type DashboardServer = ReturnType<typeof Bun.serve>;

export function browserOpenCommand(platform: NodeJS.Platform, url: string): string[] | null {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "linux":
      return ["xdg-open", url];
    case "win32":
      return ["cmd.exe", "/d", "/s", "/c", "start", "", url];
    default:
      return null;
  }
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const command = browserOpenCommand(platform, url);
  if (!command) return false;
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    void proc.exited.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function isAddressInUseError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EADDRINUSE";
}

// Identity probe: is the thing answering on this port OUR dashboard? Anything else — a foreign
// app, a hung socket, no listener — is a plain "no". This must stay the gate in front of every
// shutdown call: the 38888+ range is shared, and killing someone else's server is not our call.
async function isFusionDashboard(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/fusion-dashboard`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { fusionDashboard?: unknown } | null;
    return body?.fusionDashboard === true;
  } catch {
    return false;
  }
}

// Scan the same port range startServer binds into; return the port of a running Fusion dashboard.
export async function findRunningDashboard(basePort = DEFAULT_PORT): Promise<number | null> {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = basePort + offset;
    if (await isFusionDashboard(port)) return port;
  }
  return null;
}

// Stop a running Fusion dashboard — whichever session started it — and wait until its port has
// actually gone quiet, so the caller can immediately rebind the SAME port. Nothing running is a
// clean { stopped: false } no-op, not an error. `stopped: false` WITH a port means one was found
// but would not die — the caller decides how loud to be about that.
export async function stopRunningDashboard(
  basePort = DEFAULT_PORT,
): Promise<{ stopped: boolean; port?: number }> {
  const port = await findRunningDashboard(basePort);
  if (port === null) return { stopped: false };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { stopped: false, port };
  } catch {
    return { stopped: false, port };
  }
  // The server delays its exit past the response write — poll until the identity probe goes dark
  // instead of guessing a fixed sleep.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await isFusionDashboard(port))) return { stopped: true, port };
    await Bun.sleep(100);
  }
  return { stopped: false, port };
}

// Start Bun server. If the requested port is busy, try at most the next 9 ports.
export async function startServer(port: number): Promise<DashboardServer> {
  let lastError: unknown;
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const candidatePort = port + offset;
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: candidatePort,
        fetch: handleRequest,
      });
    } catch (err) {
      lastError = err;
      if (!isAddressInUseError(err)) throw err;
    }
  }
  throw lastError;
}

export async function launchDashboard(options: {
  port?: number;
  log?: (line: string) => void;
  open?: boolean;
  exit?: (code: number) => void; // injected in tests; production exits the process
} = {}): Promise<{ server: DashboardServer; url: string }> {
  const basePort = options.port ?? DEFAULT_PORT;
  // Restart-not-reuse: a dashboard that is already up — possibly started by another session, or
  // running OLDER code from before a plugin update — is stopped first, so this launch always
  // serves fresh code and reclaims the same port (the user's existing tab keeps its URL). A
  // foreign app on the port is left alone (identity-gated) and startServer steps past it instead.
  const stop = await stopRunningDashboard(basePort);
  // A Fusion dashboard was found but would not die (stopped:false WITH a port). Starting anyway would
  // leave TWO dashboards up — the old one (stale code) plus a new one on the next port — silently. Bail
  // instead, with the same wording the --stop path uses. Nothing running (stopped:false, no port) is
  // fine and proceeds.
  if (stop.stopped === false && stop.port !== undefined) {
    throw new Error(`found a dashboard on port ${stop.port} but could not stop it`);
  }
  const server = await startServer(basePort);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  setShutdownHandler(() => {
    server.stop(true);
    exit(0);
  });
  const url = `http://localhost:${server.port}`;
  const log = options.log ?? console.log;

  log("");
  log("  ========================================================");
  log("  ⚡ Fusion Dashboard running on-demand");
  log(`  🔗 URL: ${url}`);
  log("  ========================================================");
  log("");
  log('  To stop it: tell Claude "close the dashboard".');
  log("");

  // Best-effort only: the printed URL is the permanent fallback on headless/minimal systems.
  if ((options.open ?? true) && process.env.NODE_ENV !== "test") openBrowser(url);
  return { server, url };
}
