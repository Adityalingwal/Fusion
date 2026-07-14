# Changelog

Notable changes to Fusion will be documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
