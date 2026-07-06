// Fusion dashboard server — request routing and the data layer for the local Fusion run
// visualizer. The runnable entrypoint is ../dashboard.ts; server startup + browser-open live
// in launch.ts; everything dashboard-related (index.html, css/js/vendor assets) sits in this
// folder. Reads the shared SQLite store via storage.ts.

import { extname, join, sep } from "node:path";

import * as storage from "../storage";

let projectDir = process.cwd();
const htmlFilePath = join(import.meta.dir, "index.html");
const dashboardDir = import.meta.dir;
// Static assets are served straight from this folder by extension — no per-file list to keep in
// sync with the folder. This map is both the served-type allowlist and the Content-Type source.
const assetContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};
let activeProject: storage.Project | null = null;

// CSP for the dashboard document. Everything is now self-hosted — Tailwind ships pre-compiled
// (vendor/tailwind.css) and fonts are vendored locally — so there are NO allowed remote origins and
// no 'unsafe-eval' (the old Tailwind Play CDN was a JIT runtime that needed eval). 'unsafe-inline'
// stays only for the inline preload <script> and inline on* handlers in index.html. XSS via rendered
// markdown is separately killed by DOMPurify; this is defense-in-depth, not the primary gate.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // No remote origins: model-authored report markdown could embed a remote <img> as a tracking
  // pixel (the one outbound request the rest of this CSP forbids). 'self' + data: still covers
  // local assets and inline base64 images, which is all a plan-text report needs.
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function setProjectDir(dir: string) {
  projectDir = dir;
  activeProject = null;
}

function db() {
  return storage.open();
}

async function currentProject(): Promise<storage.Project> {
  if (!activeProject) {
    activeProject = await storage.resolveProject(projectDir);
    storage.ensureProject(db(), activeProject);
  }
  return activeProject;
}

// Fetch runs for a project. Defaults to the project the dashboard was launched from; the sidebar
// passes an explicit id to lazily load another project's runs when its folder is expanded.
export async function getRuns(projectId?: string): Promise<storage.RunSummary[]> {
  const id = projectId ?? (await currentProject()).id;
  return storage.getRuns(db(), id);
}

// Every project in the local Fusion DB, with the launched project flagged + sorted to the top.
// Powers the multi-project sidebar tree; the client only needs the summary rows, not each run.
export async function getProjects() {
  const current = await currentProject();
  const projects = storage.getProjects(db()).map((p) => ({ ...p, isCurrent: p.id === current.id }));
  projects.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.lastActivity.localeCompare(a.lastActivity);
  });
  return projects;
}

// Fetch details for a specific run. The dashboard now spans every local project, so any local run
// is readable; the header is labelled with the run's OWN project name (which may differ from the
// launched project). storage.getRunDetails throws "run not found: <id>" for an unknown id → the
// caller maps that to 404 and any other throw (broken DB) to 500.
export async function getRunDetails(runId: string) {
  const details = storage.getRunDetails(db(), runId);
  const project = storage.getProject(db(), details.projectId);
  return { ...details, projectName: project?.name ?? "this project" };
}

// Delete a run row and its embedded content. Any local run is deletable from the multi-project view.
export async function deleteRun(runId: string): Promise<boolean> {
  return storage.deleteRun(db(), runId);
}

// The server binds loopback only (see launch.ts startServer), but a malicious web page can still aim a
// DNS-rebinding request at 127.0.0.1 with an attacker-controlled Host header. Allow only loopback
// Host values so a rebinding origin can't reach the API. The port varies (38888+offset), so the
// hostname — not the port — is what we check.
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function hostAllowed(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  // Strip the port: "localhost:38888" → "localhost"; "[::1]:38888" → "[::1]".
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return ALLOWED_HOSTNAMES.has(hostname);
}

// Serve a file under dashboard/ for GET /dashboard/*. Guards against path traversal and only
// serves the known asset types (the extension map doubles as the allowlist).
export async function serveDashboardAsset(pathname: string): Promise<Response> {
  const filePath = join(dashboardDir, pathname.slice("/dashboard/".length));
  const contentType = assetContentTypes[extname(filePath)];
  if (!contentType || !filePath.startsWith(dashboardDir + sep)) {
    return new Response("Not Found", { status: 404 });
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(file, { headers: { "Content-Type": contentType } });
}

export async function serveDashboardHtml(): Promise<Response> {
  const html = Bun.file(htmlFilePath);
  if (!(await html.exists())) {
    return new Response("dashboard/index.html missing from skills folder", { status: 500 });
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    },
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (!hostAllowed(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(req.url);

  if (url.pathname.startsWith("/dashboard/")) {
    return req.method === "GET"
      ? serveDashboardAsset(url.pathname)
      : new Response("Not Found", { status: 404 });
  }

  if (url.pathname === "/api/projects" && req.method === "GET") {
    const list = await getProjects();
    return Response.json(list);
  }

  if (url.pathname === "/api/runs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const list = await getRuns(projectId);
    return Response.json(list);
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)$/);
  if (runMatch) {
    let runId: string;
    try {
      runId = decodeURIComponent(runMatch[1]); // symmetric with the client's encodeURIComponent
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (req.method === "GET") {
      try {
        const details = await getRunDetails(runId);
        return Response.json(details);
      } catch (err) {
        // Only a genuinely-absent id is a 404: getRunDetails throws "run not found: <id>" for that.
        // Any other throw (locked/corrupt DB) is a real failure → 500, so the client's 5xx branch
        // keeps the selection and lets the next poll recover, instead of silently forgetting the run.
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("run not found")) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }
        return Response.json({ error: "Failed to load run" }, { status: 500 });
      }
    }
    if (req.method === "DELETE") {
      const ok = await deleteRun(runId);
      return Response.json({ success: ok }, { status: ok ? 200 : 404 });
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveDashboardHtml();
  }

  return new Response("Not Found", { status: 404 });
}
