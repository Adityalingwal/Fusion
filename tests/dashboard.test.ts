import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  browserOpenCommand,
  deleteRun,
  getProjects,
  getRunDetails,
  getRuns,
  handleRequest,
  serveDashboardAsset,
  serveDashboardHtml,
  setProjectDir,
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

test("dashboard chooses the native browser launcher for each supported operating system", () => {
  const url = "http://localhost:38888";
  expect(browserOpenCommand("darwin", url)).toEqual(["open", url]);
  expect(browserOpenCommand("linux", url)).toEqual(["xdg-open", url]);
  expect(browserOpenCommand("win32", url)).toEqual(["cmd.exe", "/d", "/s", "/c", "start", "", url]);
  expect(browserOpenCommand("freebsd", url)).toBeNull();
});
