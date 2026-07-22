# Changelog

Notable changes to Fusion will be documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
