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
import { prisma } from "@medcore/db";
import { httpServer } from "./app";
import { registerScheduledTasks } from "./services/scheduled-tasks";
import { logFirebaseAdminDiagnostics } from "./services/firebase-admin";

/**
 * Boot-time environment diagnostics — surfaces the two things that silently
 * break patient OTP login in production (Firebase Admin config + DB
 * connectivity) right in the startup log, so a misconfigured deploy is
 * obvious without reproducing the failure through the UI. NEVER prints
 * secrets — only presence/shape, the (non-secret) project id, and the DB host.
 */
async function logStartupDiagnostics(): Promise<void> {
  console.log("──────── MedCore API startup diagnostics ────────");
  console.log(`[env] NODE_ENV: ${process.env.NODE_ENV ?? "(unset)"}`);

  // DB: log the host/db (NOT the password) and run a trivial query to prove
  // the connection + that migrations have at least created the schema.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[db] DATABASE_URL is NOT set — every DB query will fail.");
  } else {
    try {
      // Strip credentials before logging: postgresql://user:pass@host:port/db
      const safe = dbUrl.replace(/\/\/[^@]*@/, "//****:****@");
      console.log(`[db] DATABASE_URL: ${safe}`);
    } catch {
      console.log("[db] DATABASE_URL set (could not parse for safe display).");
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      const userCount = await prisma.user.count();
      console.log(`[db] ✅ connection OK — users table reachable (count: ${userCount}).`);
    } catch (err) {
      console.error(
        `[db] ❌ DB check FAILED: ${(err as Error).message}. ` +
          "If this mentions a missing table/column, prod migrations have not run " +
          "(npx prisma migrate deploy). If it's a connection error, check DATABASE_URL / network.",
      );
    }
  }

  // Firebase Admin: the thing causing the prod /firebase-verify 401.
  logFirebaseAdminDiagnostics();
  console.log("─────────────────────────────────────────────────");
}

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`MedCore API running on port ${PORT}`);
  registerScheduledTasks();
  // Fire-and-forget — never block the listener on diagnostics.
  void logStartupDiagnostics().catch((err) =>
    console.error("[startup-diag] diagnostics crashed (non-fatal):", err),
  );
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
