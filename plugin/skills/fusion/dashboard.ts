#!/usr/bin/env bun
// Fusion dashboard entrypoint. The implementation lives in dashboard/ (server.ts for routing +
// data, launch.ts for startup/browser-open, plus index.html + static assets) so everything
// dashboard-related sits in one folder; this file stays the stable root surface for direct runs
// (`bun dashboard.ts`) and imports (`from "./dashboard"`).

export * from "./dashboard/server";
export * from "./dashboard/launch";

import { launchDashboard } from "./dashboard/launch";

if (import.meta.main) {
  launchDashboard().catch((err) => {
    console.error("Failed to start dashboard server:", err);
    process.exit(1);
  });
}
