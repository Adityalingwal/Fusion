import { expect, test } from "bun:test";
import {
  MAX_PACKET_BYTES,
  buildAdvisorPrompt,
  extractVerdict,
  selectAdvisorMode,
  type AdvisorDocs,
} from "../plugin/skills/fusion/runner/advisorPrompt";

const docs = (overrides: Partial<AdvisorDocs> = {}): AdvisorDocs => ({
  brief: "the task brief",
  claudeReport: "claude leg report",
  codexReport: "codex leg report",
  plan: "the final plan",
  ...overrides,
});

// The exhaustive mode decision table — all rows (the brief/plan-missing row is a CLI ordering
// guard in fusion.ts, not a mode, so it has no row here).
test("selectAdvisorMode implements the full mode table", () => {
  // both reports present, everything small → dual
  expect(selectAdvisorMode(docs())).toEqual({ mode: "dual" });

  // either report missing → single (claude missing OR codex missing)
  expect(selectAdvisorMode(docs({ claudeReport: null }))).toEqual({ mode: "single" });
  expect(selectAdvisorMode(docs({ codexReport: null }))).toEqual({ mode: "single" });
  expect(selectAdvisorMode(docs({ claudeReport: null, codexReport: null }))).toEqual({ mode: "single" });

  // both reports present but the 4-doc packet exceeds 500 KB → single-degraded with the reason
  expect(
    selectAdvisorMode(docs({ claudeReport: "x".repeat(MAX_PACKET_BYTES), codexReport: "y" })),
  ).toEqual({ mode: "single-degraded", degradedReason: "size" });

  // even brief + plan alone exceed 500 KB → skip (fail-open), regardless of the reports
  expect(selectAdvisorMode(docs({ brief: "x".repeat(MAX_PACKET_BYTES + 1), plan: "" }))).toEqual({ mode: "skip" });
  expect(
    selectAdvisorMode(docs({ brief: "x".repeat(MAX_PACKET_BYTES + 1), plan: "", claudeReport: null })),
  ).toEqual({ mode: "skip" });
});

test("the 500 KB trigger is strictly greater-than (exactly equal stays dual) and counts UTF-8 bytes", () => {
  // Four docs summing to EXACTLY 500 KB stay dual; one more byte degrades.
  const exact = docs({
    brief: "b".repeat(1000),
    plan: "p".repeat(1000),
    codexReport: "c".repeat(255_000),
    claudeReport: "d".repeat(MAX_PACKET_BYTES - 1000 - 1000 - 255_000),
  });
  expect(selectAdvisorMode(exact)).toEqual({ mode: "dual" });
  expect(selectAdvisorMode({ ...exact, plan: exact.plan + "!" })).toEqual({
    mode: "single-degraded",
    degradedReason: "size",
  });

  // Size = UTF-8 byte length of the CONTENTS, not the character count: "€" is 1 char, 3 bytes.
  const euros = "€".repeat(Math.floor(MAX_PACKET_BYTES / 3) + 1); // > 500 KB in bytes
  expect(selectAdvisorMode(docs({ brief: euros, plan: "" }))).toEqual({ mode: "skip" });
});

test("dual prompt carries the blind intro, dual checks, output block, and the 4-doc delimited packet in order", () => {
  const prompt = buildAdvisorPrompt("dual", docs());

  expect(prompt).toStartWith("You are a rigorous, skeptical senior reviewer");
  expect(prompt).toContain("two independent planning reports");
  expect(prompt).toContain("written blind of each other");
  expect(prompt).toContain("SECURITY AND SCOPE");
  expect(prompt).toContain("REVIEW RULES");
  expect(prompt).toContain("2. Synthesis fairness");
  expect(prompt).toContain("5. Missed by everyone");
  expect(prompt).toContain("VERDICT: <exactly one of APPROVE | APPROVE-WITH-FIXES | NEEDS-REWORK>");
  expect(prompt).toContain('still ends with the line "VERDICT: APPROVE"');

  // Packet: label mapping is REPORT A = codex, REPORT B = claude; content as-is; brief-first order.
  const packet = [
    "=== TASK BRIEF ===\nthe task brief",
    "=== REPORT A ===\ncodex leg report",
    "=== REPORT B ===\nclaude leg report",
    "=== FINAL PLAN ===\nthe final plan",
  ].join("\n");
  expect(prompt).toEndWith(packet);
});

test("single prompt uses the no-cross-review intro and sends only brief + plan", () => {
  for (const mode of ["single", "single-degraded"] as const) {
    const prompt = buildAdvisorPrompt(mode, docs({ codexReport: null, claudeReport: null }));
    expect(prompt).toContain("produced WITHOUT independent cross-review");
    expect(prompt).toContain("3. Missed risks");
    expect(prompt).not.toContain("Synthesis fairness");
    expect(prompt).not.toContain("=== REPORT A ===");
    expect(prompt).not.toContain("=== REPORT B ===");
    expect(prompt).toEndWith("=== TASK BRIEF ===\nthe task brief\n=== FINAL PLAN ===\nthe final plan");
  }
});

test("extractVerdict accepts only the anchored single-line colon form, case-sensitively", () => {
  expect(extractVerdict("CONCERNS\n- None\n\nVERDICT: APPROVE")).toBe("APPROVE");
  expect(extractVerdict("VERDICT: APPROVE-WITH-FIXES")).toBe("APPROVE-WITH-FIXES");
  expect(extractVerdict("VERDICT:NEEDS-REWORK")).toBe("NEEDS-REWORK"); // \s* allows zero spaces
  expect(extractVerdict("VERDICT: APPROVE   ")).toBe("APPROVE"); // trailing whitespace ok

  expect(extractVerdict("")).toBeNull();
  expect(extractVerdict("looks good to me")).toBeNull();
  expect(extractVerdict("verdict: approve")).toBeNull(); // case-sensitive
  expect(extractVerdict("VERDICT\nAPPROVE")).toBeNull(); // the superseded two-line form
  expect(extractVerdict("VERDICT: MAYBE")).toBeNull(); // unknown value
  expect(extractVerdict("the VERDICT: APPROVE line")).toBeNull(); // not anchored at line start/end
  expect(extractVerdict("VERDICT: APPROVE because it is fine")).toBeNull(); // trailing prose
});

test("extractVerdict: with multiple VERDICT lines the LAST one wins", () => {
  const text = 'The template says to end with "VERDICT: APPROVE".\nVERDICT: APPROVE\n\nActually:\nVERDICT: NEEDS-REWORK\n';
  expect(extractVerdict(text)).toBe("NEEDS-REWORK");
});
