# 🔀 Fusion

**Two of the best AI models — Claude and GPT — think through your hardest tasks together, for a sharper, stronger result.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-d97757?logo=anthropic&logoColor=white)](https://claude.com/claude-code)
![Version](https://img.shields.io/badge/version-0.1.0-blue)

Fusion is a plugin for [Claude Code](https://claude.com/claude-code). When you have a big or tricky task, it asks **two of the best AI models — Claude and GPT — to think about it separately**, then gives you **one clear plan** that combines their best ideas. It runs on the AI tools you already pay for, so there's **no extra cost**.

```mermaid
flowchart TD
    A["📝 Your task"] --> B["🟠 Claude thinks it through"]
    A --> C["🟢 GPT thinks it through"]
    B --> D["🔀 Fusion compares both<br/>and checks the key points"]
    C --> D
    D --> E["✅ One clear plan for you"]
```

---

## How it works

1. You give Fusion your task.
2. Claude and GPT each work on it **on their own** — neither sees the other's answer, so you get two honest, independent takes.
3. Fusion **compares the two**, checks the important points, and keeps any disagreements visible instead of hiding them.
4. You get **one clear plan**. Every run is saved on your own computer, so you can look back at it later.

## Why Fusion

- **Two minds, not one.** Two strong models look at your task, so you catch more and miss less.
- **No extra cost.** It runs on the Claude Code and Codex tools you already pay for — nothing more.
- **Everything stays on your computer.** Nothing is sent anywhere else.

## Get started

```
# 1. Add Fusion as a plugin source
/plugin marketplace add Adityalingwal/Fusion

# 2. Install it
/plugin install fusion@fusion

# 3. Run your first plan
/fusion:fusion plan <your task here>
```

## What you need

- **[Bun](https://bun.sh)** — the tool Fusion runs on.
- **[Codex CLI](https://github.com/openai/codex)**, installed and logged in (`codex login`) — this is how Fusion runs GPT. It uses whatever model you've already set in your own Codex settings, so you don't configure anything here.
- **[Claude Code](https://claude.com/claude-code)** — where you run Fusion; it provides the Claude side.

## Usage

| Command | What it does |
|---|---|
| `/fusion:fusion plan <task>` | Run Fusion on a task and get one clear plan |
| `/fusion:fusion` → dashboard | Open a local page to browse your past runs |

## When to use it · When to skip it

| Use Fusion when… | Skip it when… |
|---|---|
| The task is big, or you're not sure how to approach it | It's a tiny change — a typo or a one-line fix |
| You'd like to see more than one point of view | You already know exactly what to do |

## Privacy

Everything stays on your machine — your runs are saved locally, and nothing is sent anywhere except to the Claude and Codex tools you already use.



## License

MIT © 2026 Aditya Lingwal — see [LICENSE](LICENSE).
