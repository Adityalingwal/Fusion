import { parseArgs } from "node:util";

export type StringArgs = Record<string, string | undefined>;

// Keep option declarations beside each CLI while delegating parsing and edge cases to the
// runtime's tested parser. All Fusion options are strings; strict mode catches misspellings and
// missing values instead of silently turning a bare flag into the string "true".
export function parseStringArgs(argv: string[], optionNames: readonly string[], command: string): StringArgs {
  const options = Object.fromEntries(optionNames.map((name) => [name, { type: "string" as const }]));
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values as StringArgs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${command}: ${message}`);
    process.exit(2);
  }
}
