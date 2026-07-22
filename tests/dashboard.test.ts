import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  browserOpenCommand,
  deleteRun,
  findRunningDashboard,
  getProjects,
  getRunDetails,
  getRuns,
  handleRequest,
  launchDashboard,
  serveDashboardAsset,
  serveDashboardHtml,
  setProjectDir,
  setShutdownHandler,
  stopRunningDashboard,
} from "../plugin/skills/fusion/dashboard";
import * as storage from "../plugin/skills/fusion/storage";
import { useTempDirs } from "./helpers/temp";

const tempDir = useTempDirs("fusion-dashboard-test-");
afterEach(() => setProjectDir(process.cwd())); // extra per-suite reset beyond the shared temp-dir cleanup

test("dashboard functions retrieve and delete runs correctly", async () => {
  const root = await tempDir();
  const project = join(root, "project");
  const otherProject = join(root, "other-project");
  await mkdir(project, { recursive: true });
  await mkdir(otherProject, { recursive: true });
  process.env.FUSION_DB = join(root, "dashboard.db");

  const db = storage.open();
  const projectInfo = await storage.resolveProject(project);
  const otherProjectInfo = await storage.resolveProject(otherProject);
  storage.ensureProject(db, projectInfo);
  storage.ensureProject(db, otherProjectInfo);
  storage.startRun(db, { runId: "run-test-id", projectId: projectInfo.id, title: "Current project plan" });
  storage.startRun(db, { runId: "other-run-id", projectId: otherProjectInfo.id, title: "Other project plan" });
  storage.finishRun(db, "run-test-id");
  storage.finishRun(db, "other-run-id");
  storage.putArtifact(db, "run-test-id", "brief", "brief-content");
  storage.putArtifact(db, "run-test-id", "claude_report", "claude-report");
  storage.putArtifact(db, "run-test-id", "codex_report", "codex-report");
  storage.putArtifact(db, "run-test-id", "plan", "plan-synthesis");

  setProjectDir(project);

  const runsList = await getRuns();
  expect(runsList).toHaveLength(1);
  expect(runsList[0].runId).toBe("run-test-id");
  expect(runsList[0].title).toBe("Current project plan");
  expect(runsList.some((run) => run.runId === "other-run-id")).toBe(false);

  const detail = await getRunDetails("run-test-id");
  expect(detail.status).toBe("completed");
  expect(detail.createdAt).toBeTruthy();
  expect(detail.projectId).toBe(projectInfo.id);
  expect(detail.projectName).toBe("project");
  expect(detail.title).toBe("Current project plan");
  expect(detail.brief).toBe("brief-content");
  expect(detail.plan).toBe("plan-synthesis");
  expect("runJson" in detail).toBe(false);

  // Multi-project dashboard: any local run is readable, labelled with its OWN project name
  // (the default getRuns() view above stays scoped to the launched project).
  const otherDetail = await getRunDetails("other-run-id");
  expect(otherDetail.runId).toBe("other-run-id");
  expect(otherDetail.title).toBe("Other project plan");
  expect(otherDetail.projectName).toBe("other-project");

  // A genuinely-unknown id still throws → surfaced as a 404 at the API layer.
  let missingThrew = false;
  try {
    await getRunDetails("does-not-exist");
  } catch {
    missingThrew = true;
  }
  expect(missingThrew).toBe(true);

  // ...and any local run is deletable from the cross-project view.
  expect(await deleteRun("other-run-id")).toBe(true);
  expect(storage.getRunProjectId(db, "other-run-id")).toBeNull();

  const ok = await deleteRun("run-test-id");
  expect(ok).toBe(true);
  expect(await deleteRun("missing-run-id")).toBe(false);

  const listAfterDelete = await getRuns();
  expect(listAfterDelete).toHaveLength(0);
});

test("getProjects lists every project, flags + sorts the launched one on top, and getRuns scopes by id", async () => {
  const root = await tempDir();
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });
  process.env.FUSION_DB = join(root, "projects.db");

  const db = storage.open();
  const alphaInfo = await storage.resolveProject(alpha);
  const betaInfo = await storage.resolveProject(beta);
  storage.ensureProject(db, alphaInfo);
  storage.ensureProject(db, betaInfo);
  storage.startRun(db, { runId: "alpha-1", projectId: alphaInfo.id, title: "Alpha plan" });
  storage.startRun(db, { runId: "beta-1", projectId: betaInfo.id, title: "Beta first plan" });
  storage.startRun(db, { runId: "beta-2", projectId: betaInfo.id, title: "Beta second plan" });

  setProjectDir(beta); // launch from beta → beta is the "current" project

  const projects = await getProjects();
  expect(projects).toHaveLength(2);
  expect(projects[0].isCurrent).toBe(true); // current project sorts to the top
  expect(projects[0].id).toBe(betaInfo.id);
  expect(projects[0].runCount).toBe(2);
  const alphaRow = projects.find((p) => p.id === alphaInfo.id)!;
  expect(alphaRow.isCurrent).toBe(false);
  expect(alphaRow.runCount).toBe(1);

  // Lazy per-project loading: the sidebar asks for another project's runs by id.
  const alphaRuns = await getRuns(alphaInfo.id);
  expect(alphaRuns.map((r) => r.runId)).toEqual(["alpha-1"]);
  expect(alphaRuns.map((r) => r.title)).toEqual(["Alpha plan"]);
  const betaRuns = await getRuns(); // default = current (beta)
  expect(betaRuns.map((r) => r.runId).sort()).toEqual(["beta-1", "beta-2"]);
  expect(betaRuns.map((r) => r.title).sort()).toEqual(["Beta first plan", "Beta second plan"]);
});

test("opening the dashboard is view-only — it never registers the launch directory as a project", async () => {
  const root = await tempDir();
  const freshProject = join(root, "never-ran-fusion-here");
  await mkdir(freshProject, { recursive: true });
  process.env.FUSION_DB = join(root, "view-only.db");

  setProjectDir(freshProject); // open the dashboard from a directory Fusion never ran in

  // Both data entrypoints that resolve the "current" project must stay read-only.
  expect(await getRuns()).toEqual([]);
  expect(await getProjects()).toEqual([]);

  // The DB itself gained no project row — only start/relay may create one.
  expect(storage.getProjects(storage.open())).toEqual([]);
});

test("dashboard renders escaped titles while keeping run ids as internal routing keys", async () => {
  const fusionRoot = join(import.meta.dir, "../plugin/skills/fusion");
  const utilsSource = await readFile(join(fusionRoot, "dashboard/js/utils.js"), "utf8");
  // runs.js was split into tree.js (sidebar tree) + run-view.js (run detail panel); the
  // assertions below span both halves, so test against their concatenation.
  const runsSource = [
    await readFile(join(fusionRoot, "dashboard/js/tree.js"), "utf8"),
    await readFile(join(fusionRoot, "dashboard/js/run-view.js"), "utf8"),
  ].join("\n");
  const renderRunRow = new Function(
    `${utilsSource}\nlet selectedRunId = null;\n${runsSource}\nreturn renderRunRow;`,
  )() as (run: { runId: string; title: string; createdAt: string }) => string;

  const row = renderRunRow({
    runId: "raw-secret-id",
    title: '<img src=x onerror="alert(1)"> Long title',
    createdAt: "2026-07-03T00:00:00.000Z",
  });
  expect(row).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Long title");
  expect(row).not.toContain("<img src=x");
  expect(row).not.toContain('title="raw-secret-id"');
  expect(row).not.toContain(">raw-secret-id</span>");
  expect(row).toContain("selectRun('raw-secret-id')");

  expect(runsSource).toContain("getElementById('run-title').innerText = runTitle");
  expect(runsSource).toContain("`${projectLabel} · ${formatDateTime(runCreatedAt)}`");
  expect(runsSource).toContain('message: `Run "${runTitle}"');
  expect(runsSource).not.toContain("getElementById('run-id-title')");
});

test("neighborRunId picks the next-older run after a delete, falls back to next-newer, else null", async () => {
  const apiSource = await readFile(join(import.meta.dir, "../plugin/skills/fusion/dashboard/js/api.js"), "utf8");
  // neighborRunId only reads runsByProject; inject it and pull the function out for isolated testing.
  const makeNeighbor = (runsByProject: Record<string, { runId: string }[]>) =>
    new Function("runsByProject", `${apiSource}\nreturn neighborRunId;`)(runsByProject) as (
      id: string,
    ) => string | null;

  // Lists arrive created_at DESC (index 0 = newest), so "next" = the row just below (older).
  const neighbor = makeNeighbor({ proj: [{ runId: "a" }, { runId: "b" }, { runId: "c" }] });
  expect(neighbor("a")).toBe("b"); // newest deleted → next-older below it
  expect(neighbor("b")).toBe("c"); // middle deleted → next-older below it
  expect(neighbor("c")).toBe("b"); // oldest deleted → falls back to the one just above (newer)

  expect(makeNeighbor({ proj: [{ runId: "solo" }] })("solo")).toBeNull(); // only run in project → nothing left
  expect(makeNeighbor({ proj: [{ runId: "x" }] })("missing")).toBeNull(); // id not in any list → null

  // The neighbour is scoped to the deleted run's OWN project list, never bleeding across folders.
  const multi = { p1: [{ runId: "p1a" }, { runId: "p1b" }], p2: [{ runId: "p2a" }] };
  expect(makeNeighbor(multi)("p1a")).toBe("p1b");
  expect(makeNeighbor(multi)("p2a")).toBeNull();
});

test("dashboard vendors a patched DOMPurify and routes markdown through its sanitizer", async () => {
  const fusionRoot = join(import.meta.dir, "../plugin/skills/fusion");
  const purifySource = await readFile(join(fusionRoot, "dashboard/vendor/purify.min.js"), "utf8");
  const version = purifySource.match(/DOMPurify (\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  expect(version).toBeDefined();
  const [major, minor, patch] = version!;
  // CVE-2025-15599 affects DOMPurify 3.1.3 through 3.2.6; 3.2.7 is the first fixed 3.x release.
  expect(major > 3 || (major === 3 && (minor > 2 || (minor === 2 && patch >= 7)))).toBe(true);

  const utilsSource = await readFile(join(fusionRoot, "dashboard/js/utils.js"), "utf8");
  let sanitizerInput = "";
  const renderMarkdown = new Function(
    "DOMPurify",
    "marked",
    `${utilsSource}\nreturn renderMarkdown;`,
  )(
    {
      sanitize(html: string) {
        sanitizerInput = html;
        return "<p>sanitized</p>";
      },
    },
    { parse: (markdown: string) => `<img src=x onerror=alert(1)>${markdown}` },
  ) as (markdown: string) => string;

  expect(renderMarkdown("report")).toBe("<p>sanitized</p>");
  expect(sanitizerInput).toContain("onerror");
});

test("dashboard copy fallback runs while user activation is still available", async () => {
  const utilsSource = await readFile(join(import.meta.dir, "../plugin/skills/fusion/dashboard/js/utils.js"), "utf8");
  let fallbackCalled = false;
  const area = {
    value: "",
    style: { position: "", left: "" },
    setAttribute() {},
    select() {},
  };
  const copyTextToClipboard = new Function(
    "navigator",
    "document",
    "setTimeout",
    `${utilsSource}\nreturn copyTextToClipboard;`,
  )(
    { clipboard: { writeText: async () => { throw new Error("clipboard denied"); } } },
    {
      createElement: () => area,
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => {
        fallbackCalled = true;
        return true;
      },
    },
    () => {},
  ) as (text: string, button: { innerText: string }) => Promise<void>;

  const button = { innerText: "Copy" };
  await copyTextToClipboard("plan payload", button);
  expect(fallbackCalled).toBe(true);
  expect(area.value).toBe("plan payload");
  expect(button.innerText).toBe("✓ Copied");
});

test("dashboard serves Bun.file responses with expected headers and missing-asset status", async () => {
  const html = await serveDashboardHtml();
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
  const htmlText = await html.text();
  expect(htmlText).toContain('id="run-title"');
  expect(htmlText).not.toContain('id="run-id-title"');
  expect(htmlText).not.toContain("council-health-badge");
  expect(htmlText).not.toContain("codex-status-detail");
  expect(htmlText).not.toContain("GPT-5.5");
  expect(htmlText).not.toContain("review.md");

  const asset = await serveDashboardAsset("/dashboard/js/utils.js");
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  expect(await asset.text()).toContain("function renderMarkdown");

  // runs.js was split into tree.js + run-view.js — both must be served, and the
  // content assertions below span the two halves.
  const treeAsset = await serveDashboardAsset("/dashboard/js/tree.js");
  const runViewAsset = await serveDashboardAsset("/dashboard/js/run-view.js");
  expect(treeAsset.status).toBe(200);
  expect(runViewAsset.status).toBe(200);
  const runsSource = `${await treeAsset.text()}\n${await runViewAsset.text()}`;
  expect(runsSource).toContain("run.createdAt");
  expect(runsSource).toContain("displayRunTitle(run)");
  expect(runsSource).toContain("No report available");
  expect(runsSource).toContain("No final plan available");
  expect(runsSource).toContain("copyTextToClipboard(content, button)");
  expect(runsSource).not.toContain("buildFinalCopyPayload");
  expect(runsSource).not.toContain("Leg failed open");
  expect(runsSource).not.toContain("No blind report recorded");
  expect(runsSource).not.toContain("runJson");
  expect(runsSource).not.toContain("selectedFinalKind");

  const missing = await serveDashboardAsset("/dashboard/js/missing.js");
  expect(missing.status).toBe(404);
});

test("request handling enforces the dashboard security guards", async () => {
  // These are the dashboard's whole security surface — pin them so a refactor can't silently drop
  // the DNS-rebinding 403, the path-traversal 404, or the malformed-encoding 400. All paths below
  // return before any DB access, so no fixture DB is needed.

  // 1. DNS-rebinding: a non-loopback Host header is rejected before any routing.
  const evil = await handleRequest(
    new Request("http://evil.example/api/projects", { headers: { host: "evil.example" } }),
  );
  expect(evil.status).toBe(403);

  // A loopback Host clears the gate and proceeds to normal routing (404 for a missing asset, not 403).
  const loopback = await handleRequest(
    new Request("http://localhost:38888/dashboard/js/does-not-exist.js", { headers: { host: "localhost:38888" } }),
  );
  expect(loopback.status).toBe(404);

  // 2. Path traversal: a "../" escape out of dashboard/ is refused even for an allowed extension.
  //    Tested on serveDashboardAsset directly because new URL() normalizes "../" out of req.url
  //    before handleRequest sees it, so the guard is only reachable at this layer.
  const traversal = await serveDashboardAsset("/dashboard/../../../etc/passwd.css");
  expect(traversal.status).toBe(404);

  // 3. Malformed percent-encoding in a run id decodes to a 400, not a crash.
  const badEncoding = await handleRequest(
    new Request("http://localhost:38888/api/runs/%zz", { headers: { host: "localhost:38888" } }),
  );
  expect(badEncoding.status).toBe(400);
});

test("dashboard gives each report its own tab and keeps scrolling on the outer content area", async () => {
  const fusionRoot = join(import.meta.dir, "../plugin/skills/fusion");
  const html = await Bun.file(join(fusionRoot, "dashboard/index.html")).text();
  // layout.css was split into layout.css (structure/responsive) + components.css (scrollbar,
  // loader, skeleton, modal animations); the style assertions below span both.
  const layout = [
    await Bun.file(join(fusionRoot, "dashboard/css/layout.css")).text(),
    await Bun.file(join(fusionRoot, "dashboard/css/components.css")).text(),
  ].join("\n");

  expect(html).toContain('class="flex-1 min-h-0 overflow-y-auto p-6 custom-scrollbar bg-dm-bg"');
  for (const contentId of [
    "brief-content",
    "report-claude-content",
    "report-codex-content",
    "final-content-body",
  ]) {
    const classes = html.match(new RegExp(`id="${contentId}" class="([^"]+)"`))?.[1];
    expect(classes).toBeDefined();
    expect(classes).not.toContain("overflow-y-auto");
    expect(classes).not.toContain("custom-scrollbar");
  }

  expect(html).toContain("switchTab('claude')");
  expect(html).toContain("switchTab('codex')");
  expect(html).toContain('id="content-claude"');
  expect(html).toContain('id="content-codex"');
  expect(html).not.toContain("Blind Reports");
  expect(html).not.toContain("Claude Report (Host)");
  expect(html).not.toContain("BLIND LEG");
  expect(html).not.toContain("Prompt Brief");
  expect(html).not.toContain("Final Synthesis");
  expect(html).not.toContain("final-artifact-run");
  expect(html).not.toContain(">INPUT<");
  expect(html.match(/onclick="copyArtifact\(this, '[^']+'\)"/g)).toHaveLength(4);
  expect(html).not.toContain("grid-cols-2");
  expect(layout).not.toContain("height: min(720px, calc(100vh - 220px))");
  expect(layout).not.toContain("max-height: 62vh");
  expect(layout).toContain(".sk-title");
  expect(layout).not.toContain(".sk-id");
});

test("identity + shutdown endpoints: identity is public, shutdown needs an injected handler", async () => {
  const identity = await handleRequest(
    new Request("http://localhost:38888/api/fusion-dashboard", { headers: { host: "localhost:38888" } }),
  );
  expect(identity.status).toBe(200);
  expect(await identity.json()).toEqual({ fusionDashboard: true });

  // Both lifecycle endpoints sit behind the DNS-rebinding Host guard like the rest of the API.
  const rebound = await handleRequest(
    new Request("http://evil.example/api/shutdown", { method: "POST", headers: { host: "evil.example" } }),
  );
  expect(rebound.status).toBe(403);

  // No handler injected (launch.ts not in play) → shutdown is unavailable, never a crash/exit.
  setShutdownHandler(null);
  const unavailable = await handleRequest(
    new Request("http://localhost:38888/api/shutdown", { method: "POST", headers: { host: "localhost:38888" } }),
  );
  expect(unavailable.status).toBe(503);

  // With a handler, shutdown confirms first and fires the handler after the response is written.
  let fired = false;
  setShutdownHandler(() => {
    fired = true;
  });
  const accepted = await handleRequest(
    new Request("http://localhost:38888/api/shutdown", { method: "POST", headers: { host: "localhost:38888" } }),
  );
  expect(accepted.status).toBe(200);
  expect(fired).toBe(false); // not yet — the exit is delayed past the response write
  await Bun.sleep(250);
  expect(fired).toBe(true);
  setShutdownHandler(null);
});

test("dashboard lifecycle: relaunch replaces the old server on the SAME port; --stop shuts it down", async () => {
  const port = 39877; // far outside the 38888+ default range — never touches a real dashboard
  let exits = 0;
  const opts = { open: false, log: () => {}, exit: () => { exits++; } };

  const first = await launchDashboard({ port, ...opts });
  expect(first.url).toBe(`http://localhost:${port}`);
  expect(await findRunningDashboard(port)).toBe(port);

  // Restart-not-reuse: a second launch stops the first server and reclaims the same port.
  const second = await launchDashboard({ port, ...opts });
  expect(exits).toBe(1);
  expect(second.url).toBe(`http://localhost:${port}`);
  expect(await findRunningDashboard(port)).toBe(port);

  // The `dashboard --stop` path: finds it, stops it, and the port goes dark.
  expect(await stopRunningDashboard(port)).toEqual({ stopped: true, port });
  expect(exits).toBe(2);
  expect(await findRunningDashboard(port)).toBeNull();

  // Nothing running → clean no-op, not an error.
  expect(await stopRunningDashboard(port)).toEqual({ stopped: false });
  setShutdownHandler(null);
});

test("launch refuses to start a second dashboard when the running one will not stop", async () => {
  const port = 39901; // outside the 38888+ default range — never touches a real dashboard
  // A Fusion dashboard by identity, but /api/shutdown fails — so stopRunningDashboard reports
  // {stopped:false, port}. launchDashboard must reject rather than binding the next port.
  const stubborn = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/fusion-dashboard") return Response.json({ fusionDashboard: true });
      if (url.pathname === "/api/shutdown") return new Response("no", { status: 500 });
      return new Response("stubborn");
    },
  });
  try {
    let exits = 0;
    await expect(
      launchDashboard({ port, open: false, log: () => {}, exit: () => { exits++; } }),
    ).rejects.toThrow("could not stop it");
    // No second server was started: the stubborn one still owns `port`, and nothing bound the next.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("stubborn");
    expect(await findRunningDashboard(port + 1)).toBeNull();
    expect(exits).toBe(0);
  } finally {
    stubborn.stop(true);
    setShutdownHandler(null);
  }
});

test("a foreign app on the port is never touched: probe says no, stop skips it, launch steps past it", async () => {
  const port = 39899;
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("not fusion"),
  });
  try {
    expect(await findRunningDashboard(port)).toBeNull();
    expect(await stopRunningDashboard(port)).toEqual({ stopped: false });

    // Launching against the occupied port leaves the foreign app alive and binds the NEXT port.
    let exits = 0;
    const launched = await launchDashboard({ port, open: false, log: () => {}, exit: () => { exits++; } });
    expect(launched.url).toBe(`http://localhost:${port + 1}`);
    expect((await (await fetch(`http://127.0.0.1:${port}/`)).text())).toBe("not fusion");

    expect(await stopRunningDashboard(port)).toEqual({ stopped: true, port: port + 1 });
    expect(exits).toBe(1);
  } finally {
    foreign.stop(true);
    setShutdownHandler(null);
  }
});

test("a schema-version-mismatch DB makes the list APIs answer 500 + actionable JSON, never throw", async () => {
  const root = await tempDir();
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  // Stamp a DB with a schema version this plugin build does not understand (as if written by a
  // different plugin version). Built with bun:sqlite directly so storage.open()'s own version
  // check is what trips at request time.
  const dbFile = join(root, "future-schema.db");
  const { Database } = await import("bun:sqlite");
  const stamped = new Database(dbFile, { create: true });
  stamped.exec("PRAGMA user_version = 3;");
  stamped.close();
  process.env.FUSION_DB = dbFile;
  setProjectDir(project);

  // The failure must reach the terminal as ONE clean console.error line, not an escaped exception.
  const errorLines: string[] = [];
  const realConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errorLines.push(args.join(" "));
  };
  try {
    const expected =
      "Your Fusion database (version 3) was created by a different plugin version — " +
      "update the plugin (/plugins → fusion → Update now), or delete ~/.fusion/fusion.db if you don't need the saved runs.";

    const projects = await handleRequest(
      new Request("http://localhost:38888/api/projects", { headers: { host: "localhost:38888" } }),
    );
    expect(projects.status).toBe(500);
    expect(await projects.json()).toEqual({ error: expected });

    const runs = await handleRequest(
      new Request("http://localhost:38888/api/runs", { headers: { host: "localhost:38888" } }),
    );
    expect(runs.status).toBe(500);
    expect(await runs.json()).toEqual({ error: expected });

    expect(errorLines).toHaveLength(2); // one line per failed request, nothing else
    expect(errorLines[0]).toContain("GET /api/projects failed");

    // Any OTHER data-layer throw still gets a clean 500, with the underlying error text preserved.
    process.env.FUSION_DB = root; // a directory is not openable as a SQLite file
    const broken = await handleRequest(
      new Request("http://localhost:38888/api/projects", { headers: { host: "localhost:38888" } }),
    );
    expect(broken.status).toBe(500);
    const body = (await broken.json()) as { error: string };
    expect(body.error).toStartWith("Failed to load projects: ");
  } finally {
    console.error = realConsoleError;
  }
});

test("dashboard chooses the native browser launcher for each supported operating system", () => {
  const url = "http://localhost:38888";
  expect(browserOpenCommand("darwin", url)).toEqual(["open", url]);
  expect(browserOpenCommand("linux", url)).toEqual(["xdg-open", url]);
  expect(browserOpenCommand("win32", url)).toEqual(["cmd.exe", "/d", "/s", "/c", "start", "", url]);
  expect(browserOpenCommand("freebsd", url)).toBeNull();
});
