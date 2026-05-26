/**
 * Unit tests for the API boot entrypoint `./server.ts`. server.ts runs
 * its `httpServer.listen(...)` + signal-handler registration as
 * import-time side effects, so each test:
 *   1. Mocks `./app` (httpServer.listen/close stubs) and
 *      `./services/scheduled-tasks` (registerScheduledTasks spy).
 *   2. Calls `vi.resetModules()` + dynamic `import("./server")` so the
 *      boot side effects fire freshly per test.
 *
 * Covers:
 *   - PORT default (4000) when `process.env.PORT` is unset.
 *   - PORT override when `process.env.PORT` is set.
 *   - `registerScheduledTasks()` invoked from the listen callback.
 *   - Startup log on listen.
 *   - SIGTERM + SIGINT registered as `process.on` handlers.
 *   - Graceful shutdown: SIGTERM closes the server, logs, exits 0.
 *   - Graceful shutdown: SIGINT closes the server, logs, exits 0.
 *   - Shutdown safety-net timer is scheduled and `unref`d.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ListenCallback = () => void;
type CloseCallback = () => void;

const { listenMock, closeMock, registerScheduledTasksMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  closeMock: vi.fn(),
  registerScheduledTasksMock: vi.fn(),
}));

vi.mock("./app", () => ({
  httpServer: {
    listen: listenMock,
    close: closeMock,
  },
}));

vi.mock("./services/scheduled-tasks", () => ({
  registerScheduledTasks: registerScheduledTasksMock,
}));

const ORIGINAL_PORT = process.env.PORT;

// `ReturnType<typeof vi.spyOn>` resolves to a generic MockInstance whose
// signature widens to `(this: unknown, ...args: unknown[]) => unknown`;
// process.on / process.exit are multi-overload typed methods whose narrow
// signatures aren't assignable to that wide one. Type these as the
// generic mock returned by vi.fn so each `vi.spyOn(...)` assigns cleanly.
// The tests only consume .mock.calls / .mockClear / .mockRestore on these,
// all of which are present on the generic Mock type.
type AnyArgsMock = ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
let processOnSpy: AnyArgsMock;
let processExitSpy: AnyArgsMock;
let consoleLogSpy: AnyArgsMock;
let consoleWarnSpy: AnyArgsMock;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Drive the listen callback synchronously so the boot log + scheduled
  // task registration run during the dynamic import.
  listenMock.mockImplementation((_port: unknown, cb?: ListenCallback) => {
    cb?.();
    return { close: closeMock };
  });
  closeMock.mockImplementation((cb?: CloseCallback) => {
    cb?.();
  });
  // Each cast goes through `unknown` because the narrow MockInstance
  // returned by vi.spyOn (typed against the spied method's specific
  // overload set) isn't covariantly assignable to the generic
  // AnyArgsMock holder above. The tests only consume .mock.calls /
  // .mockClear / .mockRestore so the loose generic shape is sufficient.
  processOnSpy = vi
    .spyOn(process, "on")
    .mockImplementation((() => process) as unknown as typeof process.on) as unknown as AnyArgsMock;
  processExitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(
      ((_code?: number) => undefined as never) as typeof process.exit,
    ) as unknown as AnyArgsMock;
  consoleLogSpy = vi
    .spyOn(console, "log")
    .mockImplementation(() => {}) as unknown as AnyArgsMock;
  consoleWarnSpy = vi
    .spyOn(console, "warn")
    .mockImplementation(() => {}) as unknown as AnyArgsMock;
});

afterEach(() => {
  vi.useRealTimers();
  processOnSpy.mockRestore();
  processExitSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  if (ORIGINAL_PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = ORIGINAL_PORT;
  }
});

/**
 * Boot server.ts fresh — clears the module cache so the top-level
 * `httpServer.listen(...)` + signal-handler registration fire again.
 */
async function bootServer() {
  vi.resetModules();
  await import("./server");
}

describe("server boot — PORT resolution", () => {
  it("defaults to port 4000 when process.env.PORT is unset", async () => {
    delete process.env.PORT;
    await bootServer();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0][0]).toBe(4000);
  });

  it("respects process.env.PORT when set", async () => {
    process.env.PORT = "5555";
    await bootServer();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0][0]).toBe("5555");
  });
});

describe("server boot — listen callback", () => {
  it("registers scheduled tasks once the server is listening", async () => {
    delete process.env.PORT;
    await bootServer();
    expect(registerScheduledTasksMock).toHaveBeenCalledTimes(1);
  });

  it("logs a startup message including the bound port", async () => {
    process.env.PORT = "4242";
    await bootServer();
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes("4242") && line.includes("MedCore"))).toBe(true);
  });
});

describe("server boot — signal handler registration", () => {
  it("registers SIGTERM and SIGINT handlers via process.on", async () => {
    await bootServer();
    const signals = processOnSpy.mock.calls.map((c) => c[0]);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGINT");
  });
});

describe("graceful shutdown", () => {
  async function bootAndCaptureHandler(signal: "SIGTERM" | "SIGINT") {
    await bootServer();
    const entry = processOnSpy.mock.calls.find((c) => c[0] === signal);
    expect(entry, `handler for ${signal} not registered`).toBeDefined();
    return entry![1] as (...args: unknown[]) => void;
  }

  it("on SIGTERM: closes the server, logs shutdown lines, exits 0", async () => {
    const handler = await bootAndCaptureHandler("SIGTERM");
    consoleLogSpy.mockClear();
    processExitSpy.mockClear();
    closeMock.mockClear();

    handler();

    expect(closeMock).toHaveBeenCalledTimes(1);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes("SIGTERM"))).toBe(true);
    expect(logged.some((l) => l.includes("server closed cleanly"))).toBe(true);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("on SIGINT: closes the server, logs shutdown lines, exits 0", async () => {
    const handler = await bootAndCaptureHandler("SIGINT");
    consoleLogSpy.mockClear();
    processExitSpy.mockClear();
    closeMock.mockClear();

    handler();

    expect(closeMock).toHaveBeenCalledTimes(1);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes("SIGINT"))).toBe(true);
    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it("schedules a 10s safety-net timer that force-exits if close() never resolves", async () => {
    // Override close() so it does NOT invoke its callback — the only
    // path to exit is the safety-net setTimeout.
    closeMock.mockImplementation(() => {});
    const handler = await bootAndCaptureHandler("SIGTERM");
    processExitSpy.mockClear();
    consoleWarnSpy.mockClear();

    handler();

    // Server never closes — process.exit not yet called.
    expect(processExitSpy).not.toHaveBeenCalled();

    // Advance past the 10s timeout.
    vi.advanceTimersByTime(10_000);

    expect(processExitSpy).toHaveBeenCalledWith(0);
    const warned = consoleWarnSpy.mock.calls.map((c) => String(c[0]));
    expect(warned.some((l) => l.includes("timeout"))).toBe(true);
  });
});
