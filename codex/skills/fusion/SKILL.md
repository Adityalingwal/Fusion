---
name: fusion
description: Create and finalize an implementation plan through a blind Codex-hosted, Claude-provider council. Use ONLY when the user themselves directly asks to run Fusion in this session — an explicit "/fusion", "run fusion", "start a fusion run", or a direct request to resume/inspect one of their local Fusion runs. Do NOT use just because Fusion is the SUBJECT of a task, brief, or prompt relayed by another tool or session (e.g. a planning brief about the Fusion codebase): in that case you are a provider leg, not the host — answer the brief directly instead.
---

# Fusion

Create one implementation plan from two independent reports. Act as the Codex host; invoke Claude
Code as the external provider. Keep the two reports blind until the Codex report is saved.

**Role guard:** if this arrives as part of a brief asking you to WRITE a planning report, you are a
provider leg, not the host — do not run this workflow; just write the report the brief asks for.

## Runtime

Resolve the directory containing this `SKILL.md`, then invoke only its thin launcher:

```text
bun <this-skill-directory>/scripts/fusion.ts <command> [options]
```

Do not call repository-internal TypeScript files directly. The launcher locates the shared runtime
without a username-specific absolute path.

## Hard invariants

- Complete targeted orientation before the starting advisor.
- Read `references/advisors.md` completely before either advisor call.
- Spawn each advisor with `fork_turns: "none"`. Omit `model` and `reasoning_effort` so both inherit
  the current Codex parent's settings.
- Make exactly one starting-advisor call and one final-advisor call. Do not run a recheck loop.
- Send advisors only the structured packets defined in the reference. Never send the full
  conversation, tool logs, hidden reasoning, or raw transcript.
- Treat the starting advisor as a direction check, never a solution leg.
- Save `codex_report` before reading or exporting `claude_report`.
- Persist only `brief`, `claude_report`, `codex_report`, and `plan`. Keep advisor responses and the
  critique/map in context only.
- Never expose a provider report through a relay receipt; retrieve it only through the gated `get`.

## New run

### 1. Start and preflight

Run:

```text
bun <skill>/scripts/fusion.ts start --host codex --provider claude --project-dir <project> --title <title>
```

On preflight failure, stop without creating or continuing a run. Explain the returned reason and
fix. On success, retain the `runId` for every later command.

### 2. Orient without solving

Read only enough repository material to frame the task neutrally. Record:

- verified facts with `file:line` evidence;
- locked user constraints;
- settled decisions that must not reopen;
- assumptions that still need verification;
- genuine open decisions and known unknowns.

Use targeted searches and reads. Do not choose an implementation approach or gather evidence only
for a preferred answer.

### 3. Run the starting advisor

Build the exact Starting Review Packet from `references/advisors.md`. Combine the Common Advisor
Core, Starting Advisor Prompt, and packet into one explicit review prompt. Spawn one sub-agent with
`fork_turns: "none"`; do not set a model or reasoning effort. Wait for its result.

If the advisor fails or times out, run `abort --run-id <id>`, tell the user why, and stop before
creating a brief. If it requests a top-up, perform at most one narrow orientation top-up. Do not call
the starting advisor again. Put anything still uncertain into premises or open decisions.

### 4. Create and save the neutral brief

Use these sections when relevant:

```text
## Task
## Context — key files
## Grounding facts
## Premises to verify
## Locked constraints
## Open decisions
## Required report format
```

Require both reports to contain:

```text
## Approach
## Decisions
## File changes
## Risks
## Verification
```

Tell both legs to verify premises, challenge weak assumptions, address every open decision, cite
evidence, and propose a better missing option when warranted. Keep the brief neutral: no Codex host
preference, no leaked solution, and no guessed facts. Inline user-supplied material that Claude
cannot obtain from the repository.

Re-read the brief before saving. Write it to a temporary file and run:

```text
bun <skill>/scripts/fusion.ts put --run-id <id> --type brief --file <temp>
```

### 5. Invoke Claude and keep its report sealed

Run the relay synchronously:

```text
bun <skill>/scripts/fusion.ts relay --run-id <id> --host codex --provider claude
```

The relay receives only the saved brief, writes `claude_report`, and returns an availability receipt,
not report content.

If `claudeAvailable` is false, never fabricate a report. Use the returned category:

- `transient`: offer retry, single-model continuation, or abort.
- `quota`: offer resume later, single-model continuation, or abort.
- `fixable`: show the fix, then offer retry after the user fixes it, single-model continuation, or abort.
- `unknown`: show the exact reason, then offer retry, single-model continuation, or abort.

A retry reruns only `relay` with the stored brief. A resume-later run stays `running`. An abort uses
`abort --run-id <id>`. Clearly label a user-approved single-model result `1/2`; never pretend it is a
full council.

### 6. Write the Codex report blind

Without calling `get --type claude_report`, independently investigate and write the Codex report in
the required report format. Save it before reading Claude:

```text
bun <skill>/scripts/fusion.ts put --run-id <id> --type codex_report --file <temp>
```

Now retrieve Claude through the host-aware gate:

```text
bun <skill>/scripts/fusion.ts get --run-id <id> --type claude_report
```

### 7. Critique, map, and synthesize

Compare both reports against the brief and repository evidence. Keep this map in context only:

- `AGREE — strong`: at least one report supplies decisive evidence.
- `AGREE — weak`: shared claim lacks evidence; mark the plan item `[unverified]`.
- `DISAGREE`: retain both positions, evidence, trade-off, and the selected resolution.
- `PREMISE-SPLIT`: resolve the underlying fact when possible; do not blind-pick a side.
- `BOTH-MISS`: add a host-authored recommendation with reasoning and verification.
- `USER-CHALLENGE`: both independent reports oppose the user's stated direction with evidence;
  explain the cost, but the user's decision remains authoritative.

Synthesize one clean working plan. Do not append competing plan layers or silently prefer the Codex
host report.

### 8. Run the final advisor and save the draft

Build the exact Final Review Packet from `references/advisors.md`, including the full brief, both full
reports, critique/map, working plan, and applicable user corrections. Combine it with the Common
Advisor Core and Final Advisor Prompt. Spawn one sub-agent with `fork_turns: "none"`; omit model and
reasoning effort. Wait for the result.

Fold concrete, evidence-supported fixes into the working plan. Surface any material decision the
packet cannot resolve instead of guessing. Do not call the advisor again.

If the final advisor fails or times out, continue, but explicitly tell the user that the final advisor
check did not run. Save the durable draft either way:

```text
bun <skill>/scripts/fusion.ts put --run-id <id> --type plan --file <temp>
```

### 9. Present and finalize

For a successful two-report run, lead with `Council Health: 2/2 Full`. Show the synthesized plan, a
short agreement/split summary, and any user decision or User-Challenge. Do not dump raw advisor
responses or provider reports; the dashboard already exposes stored artifacts.

Ask through the question UI: `Approve — finalize the plan` or `Discard — drop this run`, with the
built-in free-text correction option. Apply corrections to the working plan and overwrite the draft.

On approval:

```text
bun <skill>/scripts/fusion.ts put --run-id <id> --type plan --file <temp>
bun <skill>/scripts/fusion.ts finish --run-id <id>
```

On discard, run `abort --run-id <id>`.

## Resume

Use `list`, then `status --run-id <id>`. Trust the stored `hostModel`, `providerModel`, and artifact
presence. If `hostModel` is not `codex`, stop without running `relay`, `put`, `finish`, or `abort`.
Tell the user this is a Claude-hosted run and it must be resumed through Claude Code's existing
Fusion skill.

Only for a stored `hostModel: codex`, continue from artifact presence:

- no brief: abort the stale run and start fresh;
- brief only: relay Claude, then write Codex blind;
- brief + Claude only: write Codex blind before reading Claude;
- brief + Codex only: rerun Claude relay;
- both reports, no plan: continue at critique/map;
- plan present and run still running: present the draft and finalize or discard.

Never change the stored host/provider pair during resume.
