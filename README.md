# 🔀 Fusion

**Two of the best AI models — Claude and GPT — plan your hardest tasks together, so you catch more and miss less.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-d97757?logo=anthropic&logoColor=white)](https://claude.com/claude-code)

Fusion is a plugin for [Claude Code](https://claude.com/claude-code). When a task is big or tricky, one model alone can miss things. So Fusion has **Claude and GPT think it through independently** — each one filling gaps, questioning assumptions, and catching what the other might overlook. Then it hands you **one clear plan** to build from. It runs on the AI tools you already pay for, so there's **no extra cost**.

```mermaid
flowchart TD
    A["📝 Your task"] --> B["🟠 Claude plans it<br/>on its own"]
    A --> C["🟢 GPT plans it<br/>on its own"]
    B --> D["🔀 Fusion combines both<br/>into one plan"]
    C --> D
    D --> E["✅ One clear plan"]
```

---

## How it works

1. **You give Fusion a task** — something big, tricky, or where you'd just like a second opinion.
2. **Claude and GPT each make their own plan.** Neither one sees the other's answer, so you don't get just one model's view — you get two.
3. **Fusion puts them together into one plan.** If the two models disagreed on something, it tells you instead of hiding it.
4. **You get one clear plan** you can start building from — saved on your own computer, so you can come back to it later.

## Reliable by design

Fusion only helps if **both** models actually run — one model on its own is just one model. So:

- **It checks GPT before every run.** If GPT isn't ready — not installed, not signed in, out of date, or out of credits — Fusion tells you exactly what's wrong and how to fix it, and doesn't start a run that would only end up half-done.
- **If GPT drops partway through, you decide what happens.** Try again, come back to it later (your run is saved), take a single-model plan that's clearly labeled as *not* cross-checked, or stop. Fusion never quietly hands you a one-model plan dressed up as the real thing.
- **Interrupted runs can be picked up later.** If a run gets cut off, say `/fusion resume` and carry on from where it stopped — even in a new session.

## What you need

- You need a paid Claude Code plan.
- You need a paid Codex plan.
- You should be logged in to your Codex account.
- Bun should be installed on your system.

## Get started

1. `/plugin marketplace add Adityalingwal/Fusion`
2. `/plugin install fusion@fusion`
3. `/fusion <your task>`

## Staying up to date

Fusion improves over time. To get the latest version:

1. Run `/plugins` to open the plugin manager.
2. Open the **Installed** tab and select **fusion**.
3. Click **Update now**.

That's it — the update applies right away, no restart needed. See [CHANGELOG.md](CHANGELOG.md) for what's new in the latest version.

## Usage

| Command | What it does |
|---|---|
| `/fusion <your task>` | Run Fusion on a task and get one clear plan |
| `/fusion dashboard` | Open a local page to browse your past runs |

## When to use it · When to skip it

| Use Fusion when… | Skip it when… |
|---|---|
| The task is big, or you're not sure how to approach it | It's a tiny change — a typo or a one-line fix |
| You'd like to see more than one point of view | You already know exactly what to do |

## Privacy

Everything stays on your machine — your runs are saved locally, and nothing is sent anywhere except to the Claude and Codex tools you already use.

## License

MIT © 2026 Aditya Lingwal — see [LICENSE](LICENSE).
