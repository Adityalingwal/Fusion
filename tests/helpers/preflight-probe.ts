// Test harness: run the shared Codex preflight and print its structured result as one JSON line.
// Spawned via runBun (fake-cli on PATH) so tests can assert the module's PreflightResult for each
// failure mode without invoking the real codex binary.
import { preflightProvider } from "../../plugin/skills/fusion/lib/preflight";
import { parseModelName } from "../../plugin/skills/fusion/storage";

const provider = parseModelName(process.argv[2] ?? "codex", "provider");
const result = await preflightProvider(provider, process.cwd());
console.log(JSON.stringify(result));
