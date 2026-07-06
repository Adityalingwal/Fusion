// Fusion storage facade: re-exports the storage domain modules (db + repository) under one import.
// The skill's only public CLI surface is fusion.ts; this module is imported as `* as storage` by
// fusion.ts, runner.ts, runner/codex.ts, and dashboard/server.ts. Split into domain modules so
// storage behavior is easier to navigate.

export * from "./storage/db";
export * from "./storage/repository";
