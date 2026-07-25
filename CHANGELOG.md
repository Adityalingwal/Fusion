# Changelog

Notable changes to Fusion will be documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-26

### Added

- Advisor final check (`advise` command): after the plan is synthesized, a
  blind Codex reviewer re-reads the brief, both planning reports, and the
  final plan, verifies claims against the repo, and returns a verdict. The
  host verifies each finding itself and folds in only the correct ones — the
  advisor has no veto, and if the check can't run the flow simply continues
  (fail-open, one plain line to the user).
- The saved-runs database upgrades itself in place on first open (schema
  v1 → v2) — existing runs and reports stay intact, nothing to do manually.

### Changed

- PLAN step 8 in the skill is now the advisor check (the old step-3
  direction check was removed and the steps renumbered 1-9).
- The advisor's verdict is stored for on-demand fetching but is deliberately
  never shown on the dashboard.

## [0.1.3] - 2026-07-22

### Fixed

- Dashboard reports now use the available screen width and reflow when the
  sidebar opens, closes, or the window is resized.

## [0.1.2] - 2026-07-22

### Fixed

- Dashboard: when the saved-runs database can't be read (for example it was
  written by a different plugin version), the dashboard now shows a clear
  message with what to do, instead of a raw error dump in the terminal and a
  blank page.
