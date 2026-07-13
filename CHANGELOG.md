# Changelog

All notable changes to Fusion are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Fusion uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-07-13

### Changed

- **Clearer update instructions in the README.** The "Staying up to date"
  section is now a single, verified path — **`/plugins` → Installed → fusion →
  Update now** — which applies immediately with no restart.

## [0.1.1] — 2026-07-13

### Added

- **Web search in the Codex leg.** Codex can now look things up on the live web
  (docs, versions, external facts the repo can't answer) when a task warrants it,
  and stays offline when the task is self-contained.

### Changed

- **The Codex leg now fails loudly with actionable errors.** When the `codex`
  binary was stale or missing, Fusion used to silently drop to a 1/2 result with
  the real cause hidden. Now every failure names the exact fix to run
  (e.g. `npm i -g @openai/codex@latest`, `codex login`), the doctor pings the
  real configured model by default so a false green is no longer possible, and a
  1/2 result surfaces the drop reason to you leading with its fix.

## [0.1.0] — 2026-07-06

### Added

- First release: Fusion as a native Claude Code plugin. Claude and GPT each plan
  your task independently, then Fusion synthesizes one clear plan with any
  disagreements kept visible. Includes the `/fusion` command and a local
  dashboard (`/fusion dashboard`) to browse past runs.
