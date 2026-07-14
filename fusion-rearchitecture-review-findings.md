# Fusion Re-architecture PR Review Findings

Review target: `claude/fusion-skill-rearchitect-2cf0fd` at `a872c35` vs `main`

Source of truth reviewed first: `/Users/mac/.claude/plans/fusion-rearchitecture-combined.md`

Review mode: review only. No product code was changed, no real `codex` binary was invoked, and all test Codex calls used the fake CLI injected by the test suite.

## 1. Plan compliance and completeness

### [major] Blank `claude_report` unlocks the blind-rule guard

Evidence:

- `plugin/skills/fusion/fusion.ts:102` only checks whether `claude_report` is `null`.
- `plugin/skills/fusion/fusion.ts:163-165` accepts and stores input without rejecting empty or whitespace-only content.
- `plugin/skills/fusion/storage/repository.ts:135-138` persists that content as-is.
- `plugin/skills/fusion/storage/repository.ts:258-260` treats any non-null value as an existing artifact for resume status.

Concrete failure scenario:

A zero-byte or whitespace-only temp file is passed to `put --type claude_report`. The stored value is not `null`, so `get --type codex_report` and `export` are allowed even though the host never wrote an independent leg. Resume status also reports `claudeReport: true`, so a later session may skip the missing-host-leg branch.

Consequence:

The PR's central blind-independence invariant can be bypassed accidentally.

### [minor] A plain rate-limit error does not receive the required quota fix

Evidence:

- `plugin/skills/fusion/runner/codex.ts:27` classifies `rate limit` as `quota`.
- `plugin/skills/fusion/runner/codex.ts:93-95` omits `rate limit` from the actionable-hint regex.
- `plugin/skills/fusion/lib/preflight.ts:55-60` falls back to the generic `Fix that, then run /fusion again.` when no hint arrow exists.

Concrete failure scenario:

Codex returns `rate limit exceeded` without the strings `429`, `quota`, `usage limit`, or `too many requests`. The category is correctly persisted as `quota`, but preflight returns a generic fix instead of the D2-mandated instruction to wait for the GPT usage limit to reset.

Consequence:

The CLI's `fix` field drifts from the consolidated spec for a realistic quota error shape.

What was checked beyond these findings:

- Iteration 1 behavior and D1-D9.
- All post-iteration pre-release corrections.
- The explicitly rejected R1/R2 behavior.
- `${CLAUDE_SKILL_DIR}` preservation.
- Single `fusion.ts` command surface.
- Runtime dependency and project-write constraints.
- Version `0.1.0` and no-release stance.

Everything else in this dimension checked clean.

## 2. New bugs

### [major] Runner fatal paths exit without the mandatory machine-readable JSON summary

Evidence:

- `plugin/skills/fusion/runner.ts:89-93` calls `process.exit(2)` for an empty brief before printing a summary.
- `plugin/skills/fusion/runner.ts:115-118` handles top-level failures by writing only to stderr and exiting non-zero.
- `plugin/skills/fusion/fusion.ts:185-187` throws immediately on a non-zero runner exit and does not parse or forward the runner's stdout.

Concrete failure scenario:

An existing run encounters an unsupported/corrupt DB, a brief read failure, an empty brief, a disk/persistence failure, or another exception outside the handled Codex-leg failure path. The runner exits without a final JSON summary containing `codexAvailable`, `reason`, and `category`.

Consequence:

The host cannot drive the required recovery menu from structured data, and the run can remain stranded as `running`. This directly violates the hard constraint that the runner must always end with a machine-readable JSON summary line.

### [major] Failed dashboard replacement can silently start a second dashboard

Evidence:

- `plugin/skills/fusion/dashboard/launch.ts:81-83` returns `{stopped:false, port}` when shutdown fails.
- `plugin/skills/fusion/dashboard/launch.ts:87-91` returns the same result when the dashboard does not go dark within the polling window.
- `plugin/skills/fusion/dashboard/launch.ts:124-125` ignores the stop result and starts a server anyway.
- `plugin/skills/fusion/dashboard/launch.ts:97-108` moves to the next port after `EADDRINUSE`.

Concrete failure scenario:

The identity probe finds a Fusion dashboard, but its shutdown endpoint returns 503, times out, or the process does not release the port within two seconds. `launchDashboard()` ignores that failure. Because the original port is still occupied, `startServer()` binds the next port.

Consequence:

The old dashboard remains alive while a second dashboard starts, violating restart-not-reuse, same-port replacement, and the claim that a stale second copy is never left running.

### [major] Simultaneous dashboard opens race into two live dashboards

Evidence:

- `plugin/skills/fusion/dashboard/launch.ts:124-125` performs probe/stop and bind as separate, uncoordinated operations.
- `plugin/skills/fusion/dashboard/launch.ts:97-108` treats a lost bind race as a reason to step to the next port.
- `plugin/skills/fusion/dashboard/launch.ts:59-64` and `:74-75` find only the first matching dashboard in the range.

Concrete failure scenario:

Two Claude sessions run `/fusion dashboard` at nearly the same time. Both can finish their scan before either binds. One binds the base port; the other receives `EADDRINUSE` and binds the next port.

Consequence:

Two Fusion dashboards remain live. A later `dashboard --stop` discovers and stops only the first one, so the second copy can survive and become stale.

### [minor] `finish` can resurrect an aborted run as completed

Evidence:

- `plugin/skills/fusion/storage/repository.ts:218-223` treats `aborted` as a terminal state in `abortRun()`.
- `plugin/skills/fusion/storage/repository.ts:109-112` updates every matching run to `completed` without checking its current status.

Concrete failure scenario:

The same resumable run is open in two sessions. Session A chooses Discard and successfully aborts it. Session B has stale state, chooses Approve, and executes `finish --run-id`.

Consequence:

The rejected run changes from `aborted` to `completed`, so Discard is not durable across sessions.

What was checked beyond these findings:

- Preflight success and install/login/quota/stale failure paths.
- Mid-run failure classification, persistence, retry clearing, and relay summaries.
- Blind `get` and `export` behavior.
- Resume `list`, `status`, and `abort` flows.
- Dashboard identity, sequential replace-on-open, shutdown delay, `--stop`, foreign ports, and Host guard.
- Fresh v1, current v1, and unknown-stamp DB initialization/refusal.

## 3. Blast radius and regressions

Checked — clean.

Specifically checked:

- Dashboard JS consumes the API's camelCase payload correctly.
- Codex failure still renders the explicitly required plain `No report available`; no rejected failure badge was added.
- Existing storage callers remain compatible with the two nullable failure columns and `aborted` status.
- `scripts/seed-dummy.ts` remains schema-compatible and no longer contains the doctor-themed dummy title.
- Every command and flag named by `SKILL.md` exists on the `fusion.ts` surface.
- README usage commands match the skill triggers.
- No unrelated active caller was found depending on the deleted doctor command.

## 4. Code quality and simplification

Checked — clean.

Specifically checked:

- `doctor.ts`, its command, and its tests are removed.
- `CODEX_REQUIRED_FLAGS` and the separate flag-check machinery are removed.
- DB migration machinery is removed.
- The fake `# Codex — UNAVAILABLE` artifact is removed.
- No new runtime dependency was added; imports remain built-ins or internal modules.
- Temporary model output remains under `os.tmpdir()` and persistent data remains under the Fusion DB path.
- No distinct, evidence-backed simplification issue was found beyond the behavioral findings above.

## 5. Docs coherence

### [minor] Runtime dashboard guidance still includes the rejected Ctrl+C story

Evidence:

- `plugin/skills/fusion/dashboard/launch.ts:140` prints: `To stop it: tell Claude "close the dashboard" (or press Ctrl+C here).`

Concrete failure scenario:

The skill launches the dashboard in the background, potentially from another session. The user is told to press Ctrl+C "here" even though the consolidated spec explicitly replaced that story with the cross-session `dashboard-close` workflow.

Consequence:

The runtime guidance contradicts D8 and can point the user at the wrong session/process.

### [nit] `SKILL.md` overstates the stdout JSON contract

Evidence:

- `plugin/skills/fusion/SKILL.md:29-32` says every command prints JSON on stdout.
- `plugin/skills/fusion/fusion.ts:264-269` sends caught CLI errors only to stderr and exits.
- Existing blind-rule and invalid-argument tests explicitly expect empty stdout on failure.

Concrete failure scenario:

An automation follows the documented contract and attempts to parse stdout after a blind-rule refusal, invalid argument, missing run, or failed dashboard stop. Stdout is empty rather than JSON.

Consequence:

The documented CLI contract is broader than the actual behavior.

What was checked beyond these findings:

- No active doctor or migration guidance remains in SKILL/README/CHANGELOG.
- Plugin and package versions remain `0.1.0`.
- CHANGELOG says `_No releases yet._`.
- README contains terminal and desktop update paths.
- README contains `/fusion resume` and `/fusion dashboard-close`.
- README contains the new-session dashboard guidance.
- No manual plugin-folder dashboard instructions were added.

## Final summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| Major | 4 |
| Minor | 3 |
| Nit | 1 |
| **Total** | **8** |

Single most important finding: a blank `claude_report` unlocks the blind-rule guard, allowing Fusion to lose its core independence guarantee.

## Verification

- `bun test`: **50 pass / 0 fail** on reviewed HEAD `a872c35`.
- `git diff --check main...HEAD`: clean.
- Tests used fake Codex CLI PATH injection only.
- The real `codex` binary was never invoked.
