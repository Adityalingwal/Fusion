#!/usr/bin/env bun
// Seeds the Fusion DB with clearly-marked dummy projects/runs so the dashboard can be
// visually reviewed with realistic content. Idempotent (INSERT OR REPLACE on fixed ids).
//
//   bun skills/fusion/scripts/seed-dummy.ts          # seed
//   bun skills/fusion/scripts/seed-dummy.ts --clean  # remove everything this script created
//
// All dummy run ids start with "fusion-dummy-" and dummy projects use fake /tmp roots, so
// --clean can target exactly what was seeded and nothing else.

import { createHash } from "node:crypto";

import { open } from "../plugin/skills/fusion/storage/db";
import { ensureProject, resolveProject, type Project } from "../plugin/skills/fusion/storage/repository";

function fakeProject(root: string): Project {
  return {
    id: createHash("sha256").update(root).digest("hex").slice(0, 12),
    name: root.split("/").pop() ?? root,
    root,
  };
}

function daysAgo(days: number, hour = 14): string {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setHours(hour, (days * 17) % 60, 0, 0);
  return d.toISOString();
}

const brief = (task: string, files: string) => `# Fusion Brief

## Task
${task}

## Context
- Repo uses Bun + TypeScript, tests via \`bun test\`.
- Relevant files: ${files}

## Constraints
- Keep the public CLI surface unchanged.
- No new runtime dependencies.

## Deliverable
A 5-part plan: Approach · Decisions · File changes · Risks · Verification.
`;

const report = (leg: string, approach: string, risk: string) => `# ${leg} Report

## Approach
${approach}

## Decisions
1. Keep the change surgical — touch only the files named in the brief.
2. Prefer a pure function that can be unit-tested without I/O.

## File changes
- \`runner.ts\` — extract the retry loop into \`withRetry()\`.
- \`tests/runner.test.ts\` — table-driven cases for timeout + backoff.

## Risks
- ${risk}

## Verification
- \`bun test\` green before/after.
- Manual smoke: one real run end-to-end, check artifacts land in SQLite.
`;

const plan = (task: string) => `# Final Plan — ${task}

## Agreements (both legs)
- Extract-and-test approach is right; no architectural change needed.

## Disagreements kept visible
- **Codex** wants exponential backoff; **Claude** argues fixed 2s is enough for a local CLI.
  → Going with fixed delay, revisit if real timeouts show up.

## Decision matrix

| Option | Cost | Risk | Verdict |
| --- | --- | --- | --- |
| Fixed 2s delay | Low | Misses very long hangs | **chosen** |
| Exponential backoff | Medium | Masks real hangs as slowness | revisit if timeouts recur |

> Lone catch (Codex): the old retry loop swallowed the final error object — it now surfaces in the run log.

## Plan
1. Extract \`withRetry()\` with an injectable clock.
2. Port the two call sites.
3. Add table-driven tests (success, one-retry, exhaustion).

## Verification
- \`bun test\` — all suites.
- One organic dogfood run, artifacts verified in the dashboard.
`;

type SeedRun = {
  id: string;
  project: Project;
  title: string;
  status: "running" | "completed";
  createdAt: string;
  brief: string | null;
  claude: string | null;
  codex: string | null;
  plan: string | null;
};

async function main() {
  const db = open();
  const clean = process.argv.includes("--clean");

  const current = await resolveProject(process.cwd());
  const acme = fakeProject("/tmp/fusion-dummy/acme-api");
  const pulse = fakeProject("/tmp/fusion-dummy/pulse-app");

  if (clean) {
    db.query(`DELETE FROM runs WHERE id LIKE 'fusion-dummy-%'`).run();
    db.query(`DELETE FROM projects WHERE id IN (?, ?)`).run(acme.id, pulse.id);
    console.log("seed-dummy: removed all dummy runs + dummy projects");
    return;
  }

  const mk = (
    n: number, project: Project, status: SeedRun["status"], ageDays: number, task: string,
    opts: { noCodex?: boolean; briefOnly?: boolean } = {},
  ): SeedRun => ({
    id: `fusion-dummy-${String(n).padStart(2, "0")}`,
    project,
    title: task,
    status,
    createdAt: daysAgo(ageDays),
    brief: brief(task, "`runner.ts`, `storage/repository.ts`"),
    claude: opts.briefOnly ? null : report("Claude", `Incremental refactor for: ${task}.`, "Behavior drift if retry timing changes are observable to callers."),
    codex: opts.briefOnly || opts.noCodex ? null : report("Codex", `Test-first plan for: ${task}.`, "Backoff strategy may mask a real hang instead of surfacing it."),
    plan: opts.briefOnly ? null : plan(task),
  });

  const runs: SeedRun[] = [
    mk(1, current, "running", 0, "Redesign dashboard sidebar as a VS Code-style project tree", { briefOnly: true }),
    mk(2, current, "completed", 1, "Add JWT refresh-token rotation to the auth flow"),
    mk(3, current, "completed", 2, "Rate-limit the public API endpoints", { noCodex: true }),
    mk(4, current, "completed", 4, "Fix the WAL two-writer race between runner and storage"),
    mk(5, current, "completed", 6, "Add doctor --smoke check for CLI credit exhaustion"),
    mk(6, current, "completed", 9, "Migrate run artifacts from file tree to SQLite blobs"),
    mk(7, acme, "completed", 1, "Add idempotency keys to the payments webhook"),
    mk(8, acme, "completed", 3, "Split the monolith router into per-domain modules"),
    mk(9, acme, "running", 0, "Introduce request tracing with correlation ids", { briefOnly: true }),
    mk(10, pulse, "completed", 2, "Debounce the search box and cache recent queries"),
    mk(11, pulse, "completed", 7, "Fix offline sync conflict resolution for notes"),
  ];

  for (const p of [current, acme, pulse]) ensureProject(db, p);
  const insert = db.query(
    `INSERT OR REPLACE INTO runs (id, project_id, title, status, created_at, brief, claude_report, codex_report, plan)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of runs) {
    insert.run(r.id, r.project.id, r.title, r.status, r.createdAt, r.brief, r.claude, r.codex, r.plan);
  }

  console.log(`seed-dummy: seeded ${runs.length} runs across 3 projects`);
  console.log(`  - ${current.name} (current project): 6 runs`);
  console.log(`  - ${acme.name}: 3 runs, ${pulse.name}: 2 runs`);
  console.log(`cleanup anytime: bun skills/fusion/scripts/seed-dummy.ts --clean`);
}

main().catch((err) => {
  console.error("seed-dummy: fatal —", err);
  process.exit(1);
});
