# Changelog

Notable changes to Fusion will be documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-07-14

A tidier dashboard experience, and clearer setup guidance.

### Changed
- **Opening the dashboard always gives you a fresh one.** If a dashboard is
  already running — even from another session, or from before a plugin
  update — `/fusion dashboard` now closes it and starts a fresh one on the
  same port, so you never end up with piled-up or out-of-date dashboards.
  Anything else running on those ports is left untouched.
- **Closing is now a first-class command.** Say `/fusion dashboard-close`
  (or just "close the dashboard") and Fusion finds the running dashboard and
  shuts it down — no matter which session started it. The old "press Ctrl+C"
  instruction is gone; it never matched how the dashboard actually runs.
- **Clearer install + update guidance.** The README now says where the
  install commands go (Claude Code in your terminal) and adds the desktop-app
  update path (Settings → Plugins → Fusion → Update) next to the terminal one.

## [0.3.0] — 2026-07-14

Sharper failure messages and a cleaner review-and-finish flow, building on
the 0.2.0 preflight gate.

### Changed
- **Plain-English failure messages.** When GPT can't run, Fusion now shows one
  clear line — what's wrong, the exact fix, and "then run /fusion again" — with
  no jargon, exit codes, or diagnostic-command pointers. Out of credits reads
  "wait for it to reset"; an out-of-date CLI reads "run the update command".
- **Your typed answer always wins.** At every choice Fusion offers (a mid-run
  drop, the resume list, the final approve step), typing your own reply now
  takes priority over the listed buttons instead of being mapped to the
  closest one.
- **Approve or discard at the end.** After the plan is shown you choose Approve
  (finalize) or Discard (drop the run so it's cleaned up, not left dangling);
  typing corrections revises the plan and re-asks. The internal reviewer check
  runs quietly — you only hear about it if it couldn't run or needs your call.
- **Tidier resume list.** `/fusion resume` shows only the current project's
  three most recent unfinished runs, nothing else.

### Removed
- **The `doctor` command.** Its checks are exactly what `/fusion` already runs
  before every plan, so it was redundant. The separate exec-flags check is gone
  too — an incompatible CLI is now caught by the real model ping itself.

## [0.2.0] — 2026-07-14

Fusion now guarantees a real two-model council or tells you exactly why it can't —
no more silent single-model runs.

### Added
- **Preflight gate before every run.** `/fusion` verifies GPT end-to-end (installed,
  signed in, compatible CLI, and a real tiny model ping) before creating a run. If
  GPT is broken, Fusion refuses to start and shows the exact fix — no host tokens
  are spent.
- **Mid-run failure choices.** If GPT drops partway through, Fusion classifies why
  (transient / quota / fixable / unknown) and lets you choose: retry now, resume
  later, take a clearly-labeled single-model plan, or abort.
- **Resume.** Interrupted runs can be continued in any later session with
  `/fusion resume`. New `list`, `status`, and `abort` commands power it.

### Changed
- **No more silent degradation.** A dropped GPT leg no longer quietly produces a
  half-council plan. A single-model plan is only ever produced by an explicit
  choice and is presented under a loud "not cross-checked" banner.
- **Blind rule enforced in code.** Reading or exporting GPT's report now refuses
  until your own plan is saved, keeping the two plans genuinely independent.

### Removed
- The fake "Codex — UNAVAILABLE" placeholder report. A stored GPT report is now
  always a real report; the drop reason is recorded separately.
