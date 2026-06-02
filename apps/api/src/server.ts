// Network listener for the MedCore API. Wraps the Express app from
// `./app.ts` (which is unit-test-importable without binding a port) with
// `httpServer.listen` plus a graceful-shutdown handler.
//
// The shutdown handler matters for two reasons:
//   1. Production (`pm2 restart`) — half-served HTTP requests get a clean
//      close on SIGTERM rather than a midstream socket cut.
//   2. CI coverage runs (`.github/workflows/coverage.yml`) — V8 line
//      coverage data is only flushed to `$NODE_V8_COVERAGE/*.json` on a
//      *clean* `process.exit()`. Without this handler, `kill -TERM` would
//      drop the process before V8 wrote the coverage files. The workflow
//      sends SIGTERM after the spec run, this handler closes the server
//      and exits 0, V8 dumps coverage, c8 aggregates the report.
import { httpServer } from "./app";
import { prisma, ensureReferenceData } from "@medcore/db"; 
import { registerScheduledTasks } from "./services/scheduled-tasks";

// Idempotent boot-time reference-data bootstrap. Ensures the PlatformPlan
// catalog exists (and runs the one-time legacy Tenant.plan backfill on the
// first bootstrap only) so a fresh / partially migrated DB is usable without
// a manual seed step. Create-if-missing only — it never overwrites operator
// edits to existing tiers, and it seeds NO demo data (that stays in seed.ts).
// Runs on every API boot regardless of how the process is launched (plain
// `node`, `tsx`, turbo, pm2). Set `SKIP_STARTUP_BOOTSTRAP=1` to opt out (e.g.
// CI that manages its own DB). Failures are logged, never fatal — a transient
// DB blip must not stop the API from listening.
async function runStartupBootstrap(): Promise<void> {
  if (process.env.SKIP_STARTUP_BOOTSTRAP === "1") {
    console.log("[bootstrap] skipped (SKIP_STARTUP_BOOTSTRAP=1)");
    return;
  }
  try {
    const { plansCreated, legacyTenantsBackfilled, skipped } =
      await ensureReferenceData(prisma);
    if (skipped) {
      console.log("[bootstrap] plan catalog already present — migration skipped");
    } else {
      console.log(
        `[bootstrap] reference data ensured (plans created: ${plansCreated}, legacy tenants backfilled: ${legacyTenantsBackfilled})`,
      );
    }
  } catch (err) {
    console.error(
      "[bootstrap] reference-data ensure failed — continuing to serve:",
      err instanceof Error ? err.message : err,
    );
  }
}

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`MedCore API running on port ${PORT}`);
  registerScheduledTasks();
  void runStartupBootstrap(); //server start to migrate data
});

// Graceful-shutdown handler. SIGTERM from `pm2 restart` / `kill -TERM`
// (incl. the coverage workflow's stop-server step) closes the HTTP
// listener, then `process.exit(0)` triggers V8 to flush
// `$NODE_V8_COVERAGE/*.json`. The 10s timeout is a safety net so a wedged
// keep-alive connection cannot block shutdown indefinitely.
const gracefulShutdown = (signal: string) => {
  console.log(`[shutdown] ${signal} received — closing server`);
  httpServer.close(() => {
    console.log("[shutdown] server closed cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[shutdown] timeout — forcing exit");
    process.exit(0);
  }, 10000).unref();
};
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
