import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll } from "../../plugin/skills/fusion/storage/db";

// Shared per-suite temp-dir lifecycle. Call once at a suite's top level: it registers an afterEach
// that clears FUSION_DB and removes every temp dir created through the returned maker. Replaces the
// identical tempDirs+afterEach+mkdtemp boilerplate that was copy-pasted across the test suites.
export function useTempDirs(prefix: string): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    // Windows will not delete SQLite files while this process still owns their handles.
    closeAll();
    delete process.env.FUSION_DB;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
