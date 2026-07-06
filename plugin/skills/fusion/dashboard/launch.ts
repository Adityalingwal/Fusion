// Launching the Fusion dashboard: bind the HTTP server (with port-retry) and open the
// user's browser. Request routing and the data layer live in server.ts; this file owns
// everything about getting that server running and in front of the user.

import { handleRequest } from "./server";

const DEFAULT_PORT = Number(process.env.PORT || 38888);
const MAX_PORT_ATTEMPTS = 10;

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
} = {}): Promise<{ server: DashboardServer; url: string }> {
  const server = await startServer(options.port ?? DEFAULT_PORT);
  const url = `http://localhost:${server.port}`;
  const log = options.log ?? console.log;

  log("");
  log("  ========================================================");
  log("  ⚡ Fusion Dashboard running on-demand");
  log(`  🔗 URL: ${url}`);
  log("  ========================================================");
  log("");
  log("  Press Ctrl+C to terminate dashboard server cleanly.");
  log("");

  // Best-effort only: the printed URL is the permanent fallback on headless/minimal systems.
  if ((options.open ?? true) && process.env.NODE_ENV !== "test") openBrowser(url);
  return { server, url };
}
