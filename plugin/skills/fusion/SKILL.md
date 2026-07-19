---
name: fusion
description: >-
  Multi-model planning council, user-invoked via the /fusion command
  ("/fusion <task>"). Claude and Codex plan the same
  brief independently; the host then synthesizes ONE plan with
  disagreements kept visible. Do not auto-trigger from general planning
  talk — fire only on an explicit fusion request.
---

# Fusion — Claude + Codex (PLAN before code)

## Storage
Run content (the brief, both leg reports, and the plan — draft first, the final
version overwrites it) lives in one SQLite DB at `~/.fusion/fusion.db`; nothing is
written into the project directory. Talk to it only through the bundled CLI
`bun "${CLAUDE_SKILL_DIR}/fusion.ts" <command>` (`${CLAUDE_SKILL_DIR}` is supplied by Claude Code):
- `start --title "<concise task title>"` — run the GPT preflight gate, then create the run; read `runId` from its JSON (`--title` is optional at the CLI boundary, but the workflow always supplies it).
- `put --run-id <id> --type <brief|claude_report|codex_report|plan> --file <path>` — save content.
- `get --run-id <id> --type <...>` — read content back (JSON `content` field).
- `relay --run-id <id>` — launch the external Codex leg.
- `finish --run-id <id>` — mark the run completed (after the final plan is saved).
- `export --run-id <id> --type plan --out docs/X.md` — write ONE committed doc, on demand.
- `list` — JSON of interrupted runs (status `running`) across all projects, newest first, each with which artifacts exist + any GPT drop reason. Powers RESUME.
- `status --run-id <id>` — the same record for a single run (any status).
- `abort --run-id <id>` — mark an interrupted run aborted (when the user gives up on it).
- `dashboard` — run-history UI.

> On success every command prints one JSON line on stdout (progress on stderr); on failure the
> error goes to stderr and the command exits non-zero. A shell variable does
> not survive into the next call — copy the exact `runId` string from `start` into each
> later command. To save content, Write it to a temp file first, then `put … --file <temp>` —
> pasting multi-KB markdown inline breaks shell escaping.

## ⭐ The one invariant: stay BLIND
Do NOT read the Codex report until your own leg is written. Independence is the whole
value — if the legs see each other, they converge and the comparison is pointless. **The CLI now
enforces this order in code:** `get --type codex_report` (and `export`) REFUSE until your
`claude_report` is saved — there is no override, so save your own leg first. Two rules follow:
**no host lean** — your opinion never enters the brief (the brief is the fan-out point; one slanted
line poisons BOTH legs); **evidence > assertion** — every claim rests on `file:line` / a concrete
consequence, never "it's simpler/cleaner", so the synthesis can weigh the legs on evidence, not on
whose leg it is.

## Menus: a typed reply wins
Every user menu in this skill (the mid-run drop menu, the finalize menu, the resume picker) follows one
rule: **a typed free-text reply outranks the listed buttons — do what they said.** If it's ambiguous, ask
ONE short clarifying question. Never silently map a typed answer onto the nearest button.

---

## PLAN mode — steps

1. **Start the run — the preflight gate fires here.** Derive a concise title from the user's task, run
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" start --title "<concise task title>"`. **`start` verifies GPT
   end-to-end BEFORE creating the run** (installed · logged in · a real tiny model ping — the ping is
   what catches a stale CLI or exhausted quota). Two outcomes:
   - JSON `{ ok: false, stage: "preflight", reason, fix }` (non-zero exit) → **STOP.** Show the user ONE
     line, EXACTLY three parts and **nothing else** — **(1) what's broken → (2) the fix command/action →
     (3) "then run /fusion again"** — rendered in the conversation's language. Do NOT add reassurance or
     commentary ("nothing was spent", "the run never started"), raw JSON / exit codes, or any diagnostic
     pointer. Map the `reason`/`fix` to the matching shape:
     - not installed → "Codex isn't installed — install it: `npm i -g @openai/codex`, then `codex login`, then run /fusion again."
     - not logged in → "Codex isn't logged in — run `codex login`, then run /fusion again."
     - quota → "Your GPT usage limit is used up — wait for it to reset, then run /fusion again."
     - stale CLI → "Your Codex CLI is out of date — run `npm i -g @openai/codex@latest`, then run /fusion again."
     (Naming: **"GPT"** = the model (the quota case); **"Codex"** = the CLI tool (install / login / update).)
     There is no skip flag — Fusion does not run without a working GPT.
   - JSON `{ ok: true, …, preflight: "ok", runId }` → copy the `runId`; it goes into every command below.

2. **Orient — READ, don't solve.** Read the code needed to fill the brief's Context /
   Grounding facts / Premises / Open decisions — you are the framer; the legs do the
   deep reading.
   - **Skip** if you already know the area — don't re-read what you hold.
   - **Stop** only when new findings dry up — the last file you read added nothing new
     AND every brief section can be filled with verified content, not guesses.
   - **Cheap tools only:** targeted `grep`/`rg` — never a full Explore fan-out.
   - **Stay open:** deciding "I'd do X" now makes you gather selectively and silently
     slant the brief. Solutioning happens in your own leg (step 6).

3. **Advisor (direction check) — MANDATORY.** After orienting, before the brief, call `advisor()`.
   Ask for **direction only**: where you're under-oriented · which assumptions are shaky (→ Premises) ·
   which choices actually matter (→ Open decisions) · what's already settled (don't reopen).
   **NOT a solution/approach** — a solution here leaks into the brief and anchors both legs
   (one opinion twice). If it flags a gap, do ONE targeted orient top-up, then go straight to
   the brief — do not call it again. (The advisor is NOT a model leg; the only other advisor
   call is step 9.)

4. **Build the brief, then GATE it → save as the `brief` artifact.** The brief is the shared, blind
   task-spec both legs receive (fill a section only when it adds value). Sections:
   - **Task** — the user's request in their words + the agreed scope (scope is the user's; if
     ambiguous, ask them — don't guess). Inline anything Codex can't see (a pasted snippet, a
     design doc) as plain text — it sees only the brief + the repo.
   - **Context — key files** — `User-pointed` (these definitely matter) and `Found in orient` (your
     starting points), as `file:line`. Add: "not exhaustive — explore beyond these."
   - **Grounding facts (verified)** — only what you actually checked, cheap for a leg to re-verify.
   - **Premises to verify** — uncertain / high-risk claims the legs must check first. Unsure whether
     something is a fact or a premise → downgrade it to a premise.
   - **Locked constraints** — only the user's stated hard constraints; you add none of your own;
     omit if none.
   - **Open decisions** — the real choices, presented **neutrally** (no hint of your preference).
     Tell the legs: address each, and propose a better / third / missing option with reasoning.
     A technique the user merely leaned toward (not a hard constraint) goes here too, neutrally —
     don't pre-lock it as a constraint.
   - **Required report format** (so the two reports are comparable):
     ```
     ## Approach        Summary · Core idea · Design/structure · Sequence · Why (+ alternatives rejected)
     ## Decisions       per open decision: your pick + concrete proof (file:line / a consequence / a fact)
     ## File changes    each file: path + [new]/[modify]/[delete]/[move] + a one-line what (NOT the code)
     ## Risks           failure modes / edge cases / blast-radius / risky assumptions + a mitigation each
     ## Verification    how you'd confirm it's correct — tests, or the check that applies
     ```
   - **Tell both legs:** approach this as a rigorous, skeptical senior engineer, not an agreeable
     assistant — question the task's own assumptions and premises before planning; be direct and
     terse (no compliments, no hedging, no filler). Back every claim with evidence (`file:line` /
     a concrete consequence / a fact), not "it's simpler/cleaner"; treat every list above as a
     starting point, not a boundary. If a section doesn't apply, say so and why — never skip it
     silently; "no risks / nothing to add" is valid only after you examined it and can say what
     you checked.
   Write the brief to a temp file. **Self-check gate — re-read the brief before saving; on a fail,
   fix the temp file and re-check:** no host lean in the Open decisions? · no leaked opinion/solution
   anywhere? · every Grounding fact actually verified (else → Premises)? · risky premises surfaced,
   not buried? · report format present? · non-repo material inlined? Then:
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type brief --file <temp>`.

5. **Launch the external relay (it runs while you think).** Run in the BACKGROUND:
   ```
   bun "${CLAUDE_SKILL_DIR}/fusion.ts" relay --run-id <run-id>
   ```
   The runner reads the brief from the DB, runs Codex (hard timeout; the model + reasoning effort come
   from the user's own `~/.codex/config.toml`), and writes the `codex_report` back to the DB. Its last
   stdout line is a JSON summary: `codexAvailable`, and on a drop a `reason` **and a `category`
   (`transient | quota | fixable | unknown`)** that step 7 uses to offer the right recovery choice.
   The runner prepends a standing role-clarification to the relayed prompt (the leg is a planner, not
   the Fusion host), and a hollow/off-task report (no `##` sections AND very short) is recorded as a
   `transient` drop — step 7's Retry menu fires instead of a garbage report reaching the critique.

6. **Write YOUR OWN leg, BLIND → save as the `claude_report` artifact** (same report format as the brief).
   Write it to a temp file, then
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type claude_report --file <temp>`.
   Do this while the runner works — but do NOT read the relay report yet.

7. **Drop checkpoint FIRST, then critique.** When the runner finishes, read its relay summary.
   **If `codexAvailable: false`, GPT dropped — do NOT proceed to critique** (there is no second leg to
   compare). Present the user a choice menu based on `category`; surface the `reason`'s fix first, never
   raw exit codes / `$PATH` noise:
   - **`transient`** (timeout / network / 5xx) → **Retry now** · Single-model · Abort. Retry re-runs
     `bun "${CLAUDE_SKILL_DIR}/fusion.ts" relay --run-id <run-id>` — the brief and your own leg are
     already durable in the DB, so only GPT's leg re-runs (cheap by design).
   - **`quota`** (out of credits / rate-limited) → do NOT offer an immediate retry (it would just fail
     again): **Resume later** ("the run is saved — when your GPT quota resets, say `/fusion resume`") ·
     Single-model · Abort.
   - **`fixable`** (not logged in / stale CLI) → the `reason` already carries the fix command; show it,
     then **Fix + Retry** (user applies the fix, you re-run `relay --run-id <run-id>`) · Single-model · Abort.
   - **`unknown`** → show the raw `reason`; offer all four: Retry · Resume later · Single-model · Abort.
   - **Abort** → `bun "${CLAUDE_SKILL_DIR}/fusion.ts" abort --run-id <run-id>`, tell the user, done.
   - A Retry / Fix+Retry that drops AGAIN → re-present this menu with the fresh `reason`/`category`. The
     user decides each round — never auto-loop. **Single-model** routes to the Claude-only branch below
     (an explicit user choice, never a silent default).
   - **Free-text (the menu rule above applies):** if it names a fix or a variation (e.g. "retry with a
     longer timeout"), apply it (e.g. `relay --run-id <run-id> --timeout-ms <n>`).

   **If `codexAvailable: true`, run the critique — MAP the two legs; do NOT pick a winner yet.** Once
   your own leg is saved, read the Codex report:
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" get --run-id <run-id> --type codex_report`.
   Write a short **in-context map** (no file). Picking a winner is step 8's job — an honest map
   written *before* the verdict is what stops you rationalizing toward your own leg. Run every
   point of comparison through:
   - **Cited proof?** (`file:line` / a concrete consequence) → **verify it — but only the *disputed* and
     *plan-critical* ones** (read the surrounding/related code, not just the cited line; a shallow glance is
     fooled). A cited proof that is **false → drop that claim** (one-leg-wrong). **No pointer → do NOT
     investigate** (that's an open-ended re-audit); just flag it.
   - **Bucket it:** **AGREE** — *strong* (≥1 leg has proof → trust) vs *weak* (no proof → shared-blind-spot
     risk → flag for `[unverified]`) · **CONFLICT** — note which side's evidence is harder, and check *is it
     really a premise-split?* (the legs assumed different underlying situations → name the real question) ·
     **LONE-CATCH** — one raised it, the other is silent · **BOTH-MISS** — re-check BOTH reports against the
     brief's Open-decisions / Locked-constraints / Premises (catches what leg-vs-leg comparison cannot).
   - **Also flag:** a leg that left a required section empty / non-committal (**hollow**); where YOUR OWN leg is
     the dissenter or deciding vote (→ fires the firewall in step 8); BOTH legs (Codex must be one) against the
     user's own stated direction (→ **User-Challenge** in step 8).
   This is the cross-examination — a map, **distinct from step 8**.

8. **Synthesize → write the plan to a temp file (the working copy; NOT the DB yet).**
   Merge both legs into ONE plan — pull the *judgment* from the critique map, the *content* from the legs (the
   map is lossy). Act on each map entry:
   - **evidence > agreement** — weight by reproducible facts / `file:line`, not by "both agreed"; a **weak-AGREE**
     (agreed, no proof) is carried **`[unverified]`**, not settled. Only pure preference / an unproven assertion
     triggers `[unverified]` — a concrete consequence still counts as evidence (don't over-suppress).
   - **preserve dissent** — a genuine CONFLICT with evidence on both sides: show both + your call + why, never
     blur to consensus. A **premise-split**: don't blind-pick — resolve the underlying question if it's
     code-checkable (your own leg's premise winning that check fires the firewall below), else surface it as a
     **user decision** + `[unverified]`.
   - **BOTH-MISS** — a brief item neither leg addressed: **you author it** (a fresh recommendation + reasoning,
     or surface it as a user decision), labeled a **solo call** (no council cross-check) + `[unverified]` if it
     rests on preference; **never drop it silently**.
   - **hollow / one-leg-wrong** — a leg's empty/non-committal section gets **no weight** there (use the filled
     leg; BOTH hollow → treat it as a BOTH-MISS above); a claim the critic dropped as false stays dropped —
     don't resurrect it from the leg.
   - **self-preference firewall** — whenever YOUR OWN leg is the lone dissenter or the deciding vote, write one
     line — "why might my own leg be wrong here?" — before you call it.
   - **honest-labeling** — if your own leg was pre-baked from this conversation (not a fresh take), say so and
     weight Codex as the independent signal.
   - **lone-catch** — a single real catch (with evidence) surfaces prominently, not buried by agreement.
   - **User-Challenge** — BOTH legs (Codex must be one) against the user's own stated direction → a labeled
     **⚠️ User-Challenge** block: what the user said · why both disagree (with proof) · the cost if wrong · the
     user's direction stands unless they change it. One leg only against = normal dissent, not this. Firewall:
     never raise it on your own leg alone.
   Write ONE clean plan (not an append-pile of "supersedes X" layers) to a **temp file** — this is the working
   copy through the next steps; it is **not** saved to the DB yet (that happens in step 9, then step 10).

9. **Advisor (final-check) — MANDATORY; then save a durable draft.** Call `advisor()`.
   Guide its ask (not a bare one-liner, not a rigid checklist): give it the **task + the plan** and ask it to check
   task-fit plus the **danger-zones** — where your own leg won (justified or self-preference?) · a solo-authored
   BOTH-MISS (sound, or should it go to the user?) · was a premise-split resolved honestly? · are weak
   agreements tagged `[unverified]`? · anything wrongly dropped / kept? · any big risk all three of us missed —
   **plus an open tail** ("anything else wrong, even if not listed"). If the plan carries a **⚠️ User-Challenge**,
   the advisor weighs in (is the challenge fair?) but never overrides — the user's call stands. Fold its verdict
   into what you'll show the user — **one call, no ping-pong loop**. **Fail-open:** if the advisor call errors /
   times out, proceed without it — still save the draft below, and tell the user the advisor check didn't run.
   **Then save a durable draft to the DB**
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type plan --file <temp>`.

10. **Show the user → finalize.** **Lead with Council Health `2/2 Full`** (both legs synthesized). *(A `1/2`
    single-model result never reaches this step — it is finished via the Single-model branch below, under its
    own ⚠️ banner. Reaching step 10 means GPT's leg was present, so this is always a real council.)* Then show:
    the synthesized plan, a short "where they agreed / split", and any **⚠️ User-Challenge** prominently.
    Then apply the **Shared finalize menu** (below) — advisor display rule + Approve / Discard / corrections.

### Shared: the finalize menu (used by step 10 and the Single-model branch)
- **Advisor display rule** — the advisor's fixes were already folded into the plan before this point, so its
  routine verdict is NOT shown: show the plan clean. Only two things ever surface: if the advisor call
  **failed/timed out**, add one plain line ("the advisor check didn't run — this plan is un-reviewed by it");
  if an advisor catch **needs a user decision** (not a fix you could fold in), surface it as a short note
  beside the plan. Never dump the routine verdict.
- **The menu** — **ask via the question UI** — exactly two options + the built-in free-text box:
  **[Approve — finalize the plan]** · **[Discard — drop this run]**.
  - **Approve** → **re-save the final plan to the DB** (synchronous, overwrites the draft)
    `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type plan --file <temp>`, then
    `bun "${CLAUDE_SKILL_DIR}/fusion.ts" finish --run-id <run-id>`. **Keep the temp file** (do not delete).
    Don't dump the raw reports — point to the dashboard (`fusion dashboard`); for a committed doc use
    `fusion.ts export` (on demand).
  - **Discard** → `bun "${CLAUDE_SKILL_DIR}/fusion.ts" abort --run-id <run-id>` + a one-line confirmation
    (this is what stops a rejected plan from lingering as `running` and haunting the resume picker).
  - **Free-text = the corrections channel** (there is no separate "Correct" button — the box IS it; the
    menu rule above applies): apply the user's edits to the temp file (NOT re-reviewed — the user is the
    authority), show the updated plan, and re-ask this same menu. As many rounds as the user needs.

### Single-model (Claude-only) branch — an explicit user choice, never a default
Reached ONLY when GPT dropped mid-run and the user chose "Single-model" over retry/resume at step 7's menu.
There is one leg, so critique + synthesis (steps 7–8) are meaningless and **SKIPPED**. Instead:
1. **Self-check your own leg against the brief** — every Open decision addressed? Locked constraints respected?
   risky Premises examined? Premises actually verified? Fix any gaps in your leg first.
2. **Reformat your leg as ONE plan** (the step-8 plan shape) in a temp file — one clean plan, not an append-pile.
3. **Advisor (mandatory)** — same as step 9: give it the task + the plan, danger-zones + an open tail; fold in its
   verdict. Then save a durable draft:
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type plan --file <temp>`.
4. **Present under a loud banner:** `⚠️ Single-model plan — no council cross-check (GPT dropped: <reason>)`. Show
   the plan clean under the banner (no per-line `[unverified]` spam — the banner labels the whole plan as
   single-model).
5. **Finalize** — apply the **Shared finalize menu** (above): same advisor display rule, same two buttons,
   same corrections loop.

---

## RESUME mode — steps (continue an interrupted run)

Use when a run was left incomplete — GPT dropped and the user deferred (`quota` → "resume later"), or the host
session itself died mid-run. Which artifacts exist in the DB tells you where it stopped. Trigger: the user says
`/fusion resume` (optionally with a runId).

1. **List interrupted runs.** `bun "${CLAUDE_SKILL_DIR}/fusion.ts" list` — JSON of every `running` run across all
   projects, newest first, each with title, when, `projectDir`, its `artifacts` map, and any GPT drop
   `reason`/`category`. **Filter to the CURRENT project** (match `projectDir`) and show **ONLY the newest 3** as
   options — each one line: title · when · why it stopped. **Nothing else:** no other-project counts, no
   "N older runs exist" line, no extra lists. The question UI's built-in free-text box stays (the menu rule
   applies) — e.g. the user pastes a specific runId or says "the auth one". (If they already named a runId,
   skip to 2.)
2. **Inspect the pick, then continue from the right point.**
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" status --run-id <id>` — read its `artifacts` map + any drop reason, then:
   - **no brief** → nothing worth resuming; suggest a fresh `/fusion` run instead.
   - **brief only** → launch `relay` + write your own leg (normal steps 5–6 onward). No fresh `start`/preflight
     is needed to resume — but if `relay` drops again, step 7's mid-run menu applies.
   - **brief + claude_report, no codex_report** → re-run `relay --run-id <id>` (step 5), then critique →
     synthesis onward (same mid-run menu if it drops again).
   - **brief + codex_report, no claude_report** → **write your own leg FIRST, blind** — the CLI refuses
     `get --type codex_report` until you save `claude_report` (that's intentional) — then continue at step 7.
   - **both legs, no plan** → critique (step 7) → synthesis onward.
   - **plan draft, not finished** → present / finalize (step 10).
3. **Give up instead?** `bun "${CLAUDE_SKILL_DIR}/fusion.ts" abort --run-id <id>` marks it aborted so it stops
   showing up in `list`.

---

## DASHBOARD mode — steps (on-demand)

Use when the user wants to visually browse the history of PLAN runs, view reports side-by-side, or inspect
briefs / legs / plans. Open trigger: `/fusion dashboard`, `show dashboard`, `open web ui`.
Close trigger: `/fusion dashboard-close`, `close the dashboard`.

1. **Open.** Run in the BACKGROUND (the server never exits on its own — a foreground call would
   block until the tool timeout kills it, taking the user's dashboard down with it):
   ```bash
   bun "${CLAUDE_SKILL_DIR}/fusion.ts" dashboard
   ```
   It starts a lightweight local HTTP server and opens the browser at the dashboard URL
   (e.g. `http://localhost:38888`), reading everything from the Fusion SQLite DB. Safe to re-run:
   if a dashboard is already up — even one started by another session, or running older code from
   before a plugin update — the command stops it first and starts fresh on the same port, so there
   is never a second stale copy. Its stdout is a single JSON line with the `url` — report the URL
   to the user and, in the same line, how to leave: say `close the dashboard` when you're done.
2. **Browse, compare**: select runs and inspect briefs / legs / plan side-by-side.
3. **Close (when the user asks).** Run synchronously (NOT in the background):
   ```bash
   bun "${CLAUDE_SKILL_DIR}/fusion.ts" dashboard --stop
   ```
   It finds the running dashboard (whichever session started it), verifies it really is Fusion's —
   it never touches any other app — shuts it down, and prints `stopped` in its JSON. Confirm to the
   user in one line. `stopped: false` with no `port` just means nothing was running — report that
   plainly; it is a clean answer, not an error.

---
