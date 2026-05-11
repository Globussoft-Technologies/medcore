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
import { registerScheduledTasks } from "./services/scheduled-tasks";

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`MedCore API running on port ${PORT}`);
  registerScheduledTasks();
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
