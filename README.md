# Fusion

**A multi-model planning council for [Claude Code](https://claude.com/claude-code), packaged as a native plugin.**

Fusion runs a planning brief through **two independent models — Claude and Codex — at the same time**, then has the host (Claude Code) synthesize **one plan** that keeps their disagreements visible instead of papering over them. It is **plan-only**: Fusion produces a plan, it does not write your code.

Because it drives your already-installed `codex` CLI (which uses your own ChatGPT/Codex subscription and `~/.codex/config.toml`), there is **no extra API cost** — you pay nothing beyond the subscriptions you already have.

## How it works

1. You invoke Fusion with a task brief.
2. Fusion spins up a **Codex leg** (via `codex exec`, read-only sandbox) and Claude writes its **own leg blind**, so neither anchors on the other.
3. The host reads both reports, maps where they agree and disagree, and synthesizes a **single consolidated plan**.
4. Every run (brief, both legs, final plan) is stored locally in SQLite at `~/.fusion/fusion.db`. A local dashboard lets you browse past runs.

## Prerequisites

- **[bun](https://bun.sh)** — the runtime Fusion is built on. `bun:sqlite` is built in, so no `bun install` is needed to *run* the plugin.
- **[codex CLI](https://github.com/openai/codex)**, installed and **authenticated** (`codex login`). Fusion reads the model + reasoning effort from your own `~/.codex/config.toml`.
- **[Claude Code](https://claude.com/claude-code)** (`claude`), the host.

## Install

Fusion is distributed as a Claude Code plugin via its own marketplace.

```
# 1. Add this repo as a marketplace (local clone or GitHub shorthand)
/plugin marketplace add Adityalingwal/fusion
#   ...or from a local checkout:
/plugin marketplace add /path/to/fusion

# 2. Install the plugin
/plugin install fusion@fusion
```

## Usage

Invoke the skill from inside Claude Code:

```
/fusion:fusion plan <your task here>
```

Fusion will run both legs, synthesize the plan, and print it. To browse past runs in the local dashboard:

```
/fusion:fusion
# then follow the skill's dashboard step, which launches an on-demand local web UI.
```

Run a health check on your prerequisites at any time:

```
bun "${CLAUDE_SKILL_DIR}/fusion.ts" doctor
```

## Data & privacy

- All run data lives locally in `~/.fusion/fusion.db`. Nothing is sent anywhere except to the `codex` and `claude` CLIs you already use.
- The Codex leg runs in a **read-only sandbox** — it does not write into your project.

## Repository layout

```
fusion/
├── .claude-plugin/marketplace.json   # marketplace catalog
├── plugin/                           # THE PLUGIN — only this ships to users
│   ├── .claude-plugin/plugin.json
│   └── skills/fusion/                # ${CLAUDE_SKILL_DIR} at runtime
├── tests/                            # dev-only (bun test), not shipped
├── scripts/                          # dev-only seed helper, not shipped
├── build/                            # dashboard CSS build tooling, not shipped
└── package.json
```

Only the `plugin/` directory is copied to a user's plugin cache on install; `tests/`, `scripts/`, and `build/` live at the repo root and never ship.

## Development

```
bun install      # dev types only (@types/bun)
bun test         # run the full suite from the repo root
```

To rebuild the vendored dashboard stylesheet after changing Tailwind classes:

```
bash build/build-css.sh
```

## License

MIT © 2026 Aditya Lingwal
# Fusion
