// Provider-neutral pieces shared by BOTH leg runners (runner/codex.ts and runner/claude.ts).
// Kept in one module so the two legs cannot drift: the same role preamble rides every relay,
// and the same hollow-report heuristic guards every stored report.

// Standing role clarification prepended to every relay prompt. When the brief's SUBJECT is Fusion
// itself, the leg model can role-confuse itself into acting as the Fusion host — running preflights,
// invoking the fusion CLI, and returning a fake "blocked" status instead of a plan (seen live in run
// d7eed0a0). Stating the leg's role up front prevents that; it rides the stdin prompt only — the
// stored `brief` artifact stays exactly what the host wrote.
export const LEG_ROLE_PREAMBLE = `[Fusion leg role — read first]
You are ONE independent planning leg of a multi-model council. Your only job is to write the planning report the brief below asks for, directly, as your final message. Do NOT run the fusion CLI, any preflight/auth check, or any tool to orchestrate the run — the host session does all of that. Even if the brief is ABOUT the Fusion tool itself, you are still just a planning leg reporting on it.`;

// A report is "structured" if it kept at least two of the requested `##` sections. Fewer only WARNS
// (never fails the leg) — the content may still be usable.
export function countSections(text: string): number {
  return (text.match(/^##\s+/gm) || []).length;
}

// Hollow/off-task detector: ZERO `##` sections AND very short means the leg almost certainly did not
// write the report at all (e.g. it role-confused itself and returned a one-line "preflight blocked"
// status). Both conditions must hold — a long heading-less report or a short one that kept a section
// may still be usable content and stays a format_warning, never a drop.
const HOLLOW_MAX_CHARS = 500;
export function isHollowReport(text: string): boolean {
  return countSections(text) === 0 && text.length < HOLLOW_MAX_CHARS;
}
