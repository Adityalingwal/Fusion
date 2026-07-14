import { expect, test } from "bun:test";
import { actionableHint, classifyCodexFailure } from "../plugin/skills/fusion/runner/codex";

// classifyCodexFailure is pure string → category, so it is tested directly against the reason
// strings runner/codex.ts actually produces (extractCodexError / actionableHint / timeout / spawn).
test("classifyCodexFailure buckets each recognizable Codex drop reason", () => {
  const cases: Array<[string, ReturnType<typeof classifyCodexFailure>]> = [
    // quota — retrying now would just fail again
    ["codex exited 1: [429] insufficient credits for the requested model", "quota"],
    ["codex exited 1: usage limit reached", "quota"],
    ["codex exited 1: 429 too many requests", "quota"],
    ["codex exited 1: rate limit exceeded", "quota"],
    ["codex exited 1: quota exhausted", "quota"],
    // fixable — a concrete setup problem the user can correct
    ["codex exited 1: not logged in → Run: codex login", "fixable"],
    ["codex exited 1: [401] unauthorized", "fixable"],
    ["codex exited 1: requires a newer version of codex", "fixable"],
    ["codex could not start: executable not found in $PATH", "fixable"],
    ["codex could not start: spawn codex ENOENT", "fixable"],
    // transient — likely to pass on a plain retry
    ["timed out after 5000ms", "transient"],
    ["codex exited 1: network connection reset", "transient"],
    ["codex exited 1: [503] server error", "transient"],
    ["codex exited 1: stream error while reading response", "transient"],
    // unknown — anything unrecognized
    ["codex exited 1: no error output", "unknown"],
    ["empty final message", "unknown"],
  ];
  for (const [reason, expected] of cases) {
    expect(classifyCodexFailure(reason)).toBe(expected);
  }
});

test("classifyCodexFailure checks quota before the generic transient bucket (a 429 is quota, not transient)", () => {
  expect(classifyCodexFailure("codex exited 1: 429 too many requests on a flaky connection")).toBe("quota");
});

// actionableHint appends the copy-paste fix the user actually sees (and lib/preflight splits its `→`
// tail into the gate's `fix` field), so its pattern mapping is the load-bearing bit — test it directly.
test("actionableHint maps quota/limit reasons to the human GPT-limit fix, never a doctor pointer", () => {
  for (const msg of [
    "[429] insufficient credits for the requested model",
    "usage limit reached",
    "quota exhausted",
    "429 too many requests",
  ]) {
    const hint = actionableHint(msg);
    expect(hint).toContain("Your GPT usage limit is exhausted");
    expect(hint).not.toMatch(/doctor/i);
  }
});

test("actionableHint maps an unexpected-argument / unrecognized-option error to a CLI update", () => {
  for (const msg of ["error: unexpected argument '--ephemeral' found", "unrecognized option '--json'"]) {
    expect(actionableHint(msg)).toContain("npm i -g @openai/codex@latest");
  }
});
