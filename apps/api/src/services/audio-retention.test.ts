/**
 * Unit tests for the audio-retention cleanup. This is the work that the
 * `retention-scheduler` cron wraps; it deletes scribe-session audio whose
 * `audioRetainUntil` has elapsed and clears the column to mark the session
 * purged.
 *
 * Storage and Prisma are mocked. We assert:
 *   - the right Prisma filter (status set, audioRetainUntil bounds),
 *   - storage delete is best-effort (a missing/erroring file does NOT
 *     prevent the DB row from being marked purged),
 *   - per-session DB-update errors are counted, not fatal,
 *   - empty input → both counters zero.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, deleteFileMock } = vi.hoisted(() => ({
  prismaMock: {
    aIScribeSession: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
  deleteFileMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("./storage", () => ({ deleteFile: deleteFileMock }));

import { runAudioRetentionCleanup } from "./audio-retention";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  prismaMock.aIScribeSession.update.mockResolvedValue({});
  deleteFileMock.mockResolvedValue(undefined);
});

describe("runAudioRetentionCleanup — Prisma query shape", () => {
  it("filters on COMPLETED + CONSENT_WITHDRAWN with elapsed audioRetainUntil", async () => {
    prismaMock.aIScribeSession.findMany.mockResolvedValue([]);
    await runAudioRetentionCleanup();
    expect(prismaMock.aIScribeSession.findMany).toHaveBeenCalledTimes(1);
    const args = prismaMock.aIScribeSession.findMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: ["COMPLETED", "CONSENT_WITHDRAWN"] });
    expect(args.where.audioRetainUntil.not).toBeNull();
    expect(args.where.audioRetainUntil.lt).toBeInstanceOf(Date);
    expect(args.select).toEqual({ id: true });
  });
});

describe("runAudioRetentionCleanup — happy path", () => {
  it("deletes audio and clears audioRetainUntil for each session", async () => {
    prismaMock.aIScribeSession.findMany.mockResolvedValue([
      { id: "sess-a" },
      { id: "sess-b" },
    ]);
    const result = await runAudioRetentionCleanup();
    expect(result).toEqual({ purged: 2, errors: 0 });
    expect(deleteFileMock).toHaveBeenCalledWith("audio/scribe/sess-a.webm");
    expect(deleteFileMock).toHaveBeenCalledWith("audio/scribe/sess-b.webm");
    expect(prismaMock.aIScribeSession.update).toHaveBeenCalledWith({
      where: { id: "sess-a" },
      data: { audioRetainUntil: null },
    });
    expect(prismaMock.aIScribeSession.update).toHaveBeenCalledWith({
      where: { id: "sess-b" },
      data: { audioRetainUntil: null },
    });
  });
});

describe("runAudioRetentionCleanup — storage failure tolerance", () => {
  it("treats deleteFile failure as non-fatal and still clears the DB row", async () => {
    prismaMock.aIScribeSession.findMany.mockResolvedValue([{ id: "sess-a" }]);
    deleteFileMock.mockRejectedValueOnce(new Error("file not found"));
    const result = await runAudioRetentionCleanup();
    expect(result).toEqual({ purged: 1, errors: 0 });
    expect(prismaMock.aIScribeSession.update).toHaveBeenCalledWith({
      where: { id: "sess-a" },
      data: { audioRetainUntil: null },
    });
  });
});

describe("runAudioRetentionCleanup — DB failure isolation", () => {
  it("counts errors per failing update but keeps processing the rest", async () => {
    prismaMock.aIScribeSession.findMany.mockResolvedValue([
      { id: "sess-bad" },
      { id: "sess-good" },
    ]);
    prismaMock.aIScribeSession.update
      .mockRejectedValueOnce(new Error("update failed"))
      .mockResolvedValueOnce({});
    const result = await runAudioRetentionCleanup();
    expect(result).toEqual({ purged: 1, errors: 1 });
    expect(deleteFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("runAudioRetentionCleanup — empty input", () => {
  it("returns zero counts when nothing is past retention", async () => {
    prismaMock.aIScribeSession.findMany.mockResolvedValue([]);
    const result = await runAudioRetentionCleanup();
    expect(result).toEqual({ purged: 0, errors: 0 });
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(prismaMock.aIScribeSession.update).not.toHaveBeenCalled();
  });
});
