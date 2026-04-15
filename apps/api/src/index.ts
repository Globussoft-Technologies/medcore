// Entry point — kept for backwards compatibility.
// The Express app is configured in `./app.ts` (importable by tests without
// starting a network listener), and the listener lives in `./server.ts`.
export { app, httpServer, io } from "./app";
import "./server";
