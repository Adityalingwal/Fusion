// Test harness: run the shared Codex preflight and print its structured result as one JSON line.
// Spawned via runBun (fake-cli on PATH) so tests can assert the module's PreflightResult for each
// failure mode without invoking the real codex binary.
import { preflightCodex } from "../../plugin/skills/fusion/lib/preflight";

const result = await preflightCodex(process.cwd());
console.log(JSON.stringify(result));
