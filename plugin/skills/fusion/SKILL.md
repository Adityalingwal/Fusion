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
- `start --title "<concise task title>"` — create the run; read `runId` from its JSON (`--title` is optional at the CLI boundary, but the workflow always supplies it).
- `put --run-id <id> --type <brief|claude_report|codex_report|plan> --file <path>` — save content.
- `get --run-id <id> --type <...>` — read content back (JSON `content` field).
- `relay --run-id <id>` — launch the external Codex leg.
- `finish --run-id <id>` — mark the run completed (after the final plan is saved).
- `export --run-id <id> --type plan --out docs/X.md` — write ONE committed doc, on demand.
- `dashboard` / `doctor` — run-history UI / diagnostics.

> Every command prints JSON on stdout (progress/errors on stderr). A shell variable does
> not survive into the next call — copy the exact `runId` string from `start` into each
> later command. To save content, Write it to a temp file first, then `put … --file <temp>` —
> pasting multi-KB markdown inline breaks shell escaping.

## ⭐ The one invariant: stay BLIND
Do NOT read the Codex report until your own leg is written. Independence is the whole
value — if the legs see each other, they converge and the comparison is pointless. Two
rules follow: **no host lean** — your opinion never enters the brief (the brief is the
fan-out point; one slanted line poisons BOTH legs); **evidence > assertion** — every claim
rests on `file:line` / a concrete consequence, never "it's simpler/cleaner", so the
synthesis can weigh the legs on evidence, not on whose leg it is.

---

## PLAN mode — steps

1. **Start the run.** Derive a concise title from the user's task, run
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" start --title "<concise task title>"`, and copy the
   `runId` from its JSON — it goes into every command below.

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
   The runner reads the brief from the DB, runs Codex (fail-open, hard timeout; the model + reasoning
   effort come from the user's own `~/.codex/config.toml`), and writes the `codex_report` back to the DB. Its
   last stdout line is a JSON summary: `codexAvailable` and, on failure, a reason.

6. **Write YOUR OWN leg, BLIND → save as the `claude_report` artifact** (same report format as the brief).
   Write it to a temp file, then
   `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type claude_report --file <temp>`.
   Do this while the runner works — but do NOT read the relay report yet.

7. **Critique (host-side) — MAP the two legs; do NOT pick a winner yet.** Once the runner finishes
   and your own leg is saved, read the Codex report:
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
   - if the runner reported the relay `failed`, note it (fail-open: synthesize from what you have).
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

10. **Show the user → let them correct → finalize + save + finish.** **Lead with Council Health** —
    `2/2 Full` or `1/2 = single-model (Codex dropped — NOT a council)`, from the runner's
    `codexAvailable`; a **1/2 result must NEVER be presented as a passed council**. Then show: the synthesized plan, a
    short "where they agreed / split", any **⚠️ User-Challenge** prominently, and the **advisor's verdict** (so
    the user reviews *informed*). **The user reviews and may correct** — apply their edits to the temp file
    (user edits are not re-reviewed; the user is the authority). On approval, **re-save the final plan to the
    DB** (synchronous, overwrites the draft):
    `bun "${CLAUDE_SKILL_DIR}/fusion.ts" put --run-id <run-id> --type plan --file <temp>`; then
    `bun "${CLAUDE_SKILL_DIR}/fusion.ts" finish --run-id <run-id>`. **Keep the temp file** (do not delete).
    Don't dump the raw reports — point to the dashboard (`fusion dashboard`); for a committed doc use
    `fusion.ts export` (on demand).

---

## DASHBOARD mode — steps (on-demand)

Use when the user wants to visually browse the history of PLAN runs, view reports side-by-side, or inspect
briefs / legs / plans. Trigger: `fusion dashboard`, `show dashboard`, `open web ui`.

1. **Launch Dashboard Server.** Run in the BACKGROUND (the server never exits on its own — it holds
   the process open until `Ctrl+C`; a foreground call would block until the tool timeout kills it,
   taking the user's dashboard down with it):
   ```bash
   bun "${CLAUDE_SKILL_DIR}/fusion.ts" dashboard
   ```
   It starts a lightweight on-demand HTTP server and opens the browser at the local dashboard URL
   (e.g. `http://localhost:38888`). The dashboard reads everything from the Fusion SQLite DB. Its
   stdout is a single JSON line with the `url` — read it and report the URL to the user.
2. **Browse, compare**: select runs and inspect briefs / legs / plan side-by-side.
3. **Exit**: `Ctrl+C` in the terminal stops the server and frees the port.

---
