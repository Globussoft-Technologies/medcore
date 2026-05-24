/**
 * Unit tests for `startRetentionScheduler`. The scheduler is a thin
 * `setInterval`-every-24h wrapper around `runAudioRetentionCleanup` whose only
 * real responsibility is to:
 *   - call the cleanup once per tick (i.e. once per 24h),
 *   - log a one-line summary on success,
 *   - swallow + log errors so a single bad tick never tears down the process.
 *
 * `./audio-retention.runAudioRetentionCleanup` is mocked so no DB/storage is
 * touched. Tests use vitest fake timers to fast-forward the 24h interval
 * deterministically.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { runAudioRetentionCleanupMock } = vi.hoisted(() => ({
  runAudioRetentionCleanupMock: vi.fn(),
}));

vi.mock("./audio-retention", () => ({
  runAudioRetentionCleanup: runAudioRetentionCleanupMock,
}));

import { startRetentionScheduler } from "./retention-scheduler";

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const activeIntervals: NodeJS.Timeout[] = [];
let originalSetInterval: typeof setInterval;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  runAudioRetentionCleanupMock.mockResolvedValue({ purged: 0, errors: 0 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  // Wrap setInterval so we can capture the handle and clear it in afterEach.
  // Without this, the registered interval keeps living on the fake-timer
  // queue across test cases and pollutes call counts.
  originalSetInterval = global.setInterval;
  global.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = originalSetInterval(handler as (...a: unknown[]) => void, timeout, ...args);
    activeIntervals.push(id);
    return id;
  }) as typeof setInterval;
});

afterEach(() => {
  for (const id of activeIntervals.splice(0)) {
    clearInterval(id);
  }
  global.setInterval = originalSetInterval;
  vi.useRealTimers();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("startRetentionScheduler — registration", () => {
  it("returns undefined (fire-and-forget; nothing to await)", () => {
    const out = startRetentionScheduler();
    expect(out).toBeUndefined();
  });

  it("does NOT invoke the cleanup synchronously at registration time", () => {
    startRetentionScheduler();
    expect(runAudioRetentionCleanupMock).not.toHaveBeenCalled();
  });

  it("does NOT fire the cleanup before the 24h interval elapses", async () => {
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS - 1);
    expect(runAudioRetentionCleanupMock).not.toHaveBeenCalled();
  });
});

describe("startRetentionScheduler — successful tick", () => {
  it("invokes runAudioRetentionCleanup once per 24h interval", async () => {
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS);
    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("logs a one-line summary with purged + error counts", async () => {
    runAudioRetentionCleanupMock.mockResolvedValueOnce({
      purged: 7,
      errors: 2,
    });
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("[Retention]");
    expect(logSpy.mock.calls[0][0]).toContain("Purged 7 audio files");
    expect(logSpy.mock.calls[0][0]).toContain("2 errors");
  });

  it("handles a zero-purge result without errors", async () => {
    runAudioRetentionCleanupMock.mockResolvedValueOnce({
      purged: 0,
      errors: 0,
    });
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS);
    expect(logSpy).toHaveBeenCalledWith(
      "[Retention] Purged 0 audio files, 0 errors",
    );
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("fires repeatedly: 3 ticks → 3 invocations", async () => {
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS * 3);
    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(3);
  });
});

describe("startRetentionScheduler — error tolerance", () => {
  it("swallows a rejection so the scheduler stays alive", async () => {
    runAudioRetentionCleanupMock.mockRejectedValueOnce(new Error("storage down"));
    startRetentionScheduler();
    // The interval callback is async; advancing time triggers it but the
    // catch block needs the microtask queue to flush before we can assert.
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS);

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toBe(
      "[Retention] Audio retention cleanup failed:",
    );
    expect(errSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    expect((errSpy.mock.calls[0][1] as Error).message).toBe("storage down");
  });

  it("does NOT log the success line when the cleanup throws", async () => {
    runAudioRetentionCleanupMock.mockRejectedValueOnce(new Error("boom"));
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("continues firing on subsequent ticks after a failure", async () => {
    runAudioRetentionCleanupMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ purged: 5, errors: 0 })
      .mockResolvedValueOnce({ purged: 1, errors: 0 });

    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS * 3);

    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(3);
    expect(errSpy).toHaveBeenCalledTimes(1);
    // 2 successful ticks → 2 success-log lines.
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("swallows a non-Error throwable (string rejection)", async () => {
    runAudioRetentionCleanupMock.mockRejectedValueOnce("cleanup bombed");
    startRetentionScheduler();
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][1]).toBe("cleanup bombed");
  });
});

describe("startRetentionScheduler — interval cadence", () => {
  it("uses exactly a 24h period (not 12h, not 48h)", async () => {
    startRetentionScheduler();

    // At 23h59m59.999s — no tick yet.
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS - 1);
    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(0);

    // Cross the 24h boundary — first tick.
    await vi.advanceTimersByTimeAsync(1);
    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(1);

    // Another ~24h, but stop 1ms short of the second boundary.
    await vi.advanceTimersByTimeAsync(TWENTY_FOUR_HOURS - 1);
    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(1);

    // Cross again — second tick.
    await vi.advanceTimersByTimeAsync(1);
    expect(runAudioRetentionCleanupMock).toHaveBeenCalledTimes(2);
  });
});
