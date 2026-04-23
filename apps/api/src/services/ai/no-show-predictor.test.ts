import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    appointment: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  predictNoShow,
  batchPredictNoShow,
  trainModel,
  resetNoShowModelCache,
  loadModel,
} from "./no-show-predictor";

// --- Helpers -----------------------------------------------------------------

function makeAppointment(overrides: Partial<any> = {}) {
  return {
    id: overrides.id ?? "appt-1",
    patientId: overrides.patientId ?? "pat-1",
    doctorId: "doc-1",
    date: overrides.date ?? new Date("2026-04-20"),
    slotStart: overrides.slotStart ?? "10:00",
    slotEnd: "10:30",
    tokenNumber: 1,
    type: overrides.type ?? "SCHEDULED",
    status: overrides.status ?? "BOOKED",
    createdAt: overrides.createdAt ?? new Date("2026-04-10"),
    updatedAt: new Date("2026-04-10"),
    patient: overrides.patient ?? {
      id: overrides.patientId ?? "pat-1",
      age: 40,
      address: null,
    },
    ...overrides,
  };
}

function makePast(status: string, date: string) {
  return { status, date: new Date(date) };
}

let tmpDir: string;
const originalEnv = process.env.NOSHOW_WEIGHTS_PATH;

beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.appointment.findUnique.mockReset();
  prismaMock.appointment.findMany.mockReset();
  resetNoShowModelCache();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-show-test-"));
  // By default, point the predictor at a non-existent path in the temp dir so
  // the rule-based fallback kicks in.  Individual tests may overwrite the env
  // variable to activate the ML path.
  process.env.NOSHOW_WEIGHTS_PATH = path.join(tmpDir, "default-missing.json");
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (originalEnv === undefined) delete process.env.NOSHOW_WEIGHTS_PATH;
  else process.env.NOSHOW_WEIGHTS_PATH = originalEnv;
  resetNoShowModelCache();
});

// --- Tests -------------------------------------------------------------------

describe("predictNoShow — rule-based fallback", () => {
  it("returns source=rules when no weights file is present", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce(makeAppointment());
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);

    const res = await predictNoShow("appt-1");
    expect(res.source).toBe("rules");
    expect(res.riskScore).toBeGreaterThanOrEqual(0);
    expect(res.riskScore).toBeLessThanOrEqual(1);
    expect(["low", "medium", "high"]).toContain(res.riskLevel);
  });

  it("raises the risk when the patient has a recent no-show", async () => {
    prismaMock.appointment.findUnique.mockResolvedValue(makeAppointment());
    // One call for the high-risk case, one for the baseline case.
    prismaMock.appointment.findMany
      .mockResolvedValueOnce([
        makePast("NO_SHOW", "2026-04-01"),
        makePast("NO_SHOW", "2026-03-20"),
        makePast("COMPLETED", "2026-02-10"),
        makePast("COMPLETED", "2026-01-05"),
        makePast("COMPLETED", "2025-12-01"),
      ])
      .mockResolvedValueOnce([
        makePast("COMPLETED", "2025-12-01"),
        makePast("COMPLETED", "2025-11-01"),
        makePast("COMPLETED", "2025-10-01"),
        makePast("COMPLETED", "2025-09-01"),
        makePast("COMPLETED", "2025-08-01"),
      ]);

    const risky = await predictNoShow("appt-1");
    resetNoShowModelCache();
    const safe = await predictNoShow("appt-1");
    expect(risky.riskScore).toBeGreaterThan(safe.riskScore);
    expect(risky.factors.length).toBeGreaterThan(0);
  });

  it("throws a helpful error when the appointment does not exist", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce(null);
    await expect(predictNoShow("missing")).rejects.toThrow(/not found/);
  });
});

describe("predictNoShow — ML path", () => {
  it("uses the trained model when the weights file is on disk", async () => {
    // Build a tiny synthetic training set: no-show iff recent no-show flag = 1
    // We go through the public trainModel() entry point so the weights file
    // is created in the standard format.
    const rows: any[] = [];
    const mkRow = (id: string, pid: string, status: string, daysAgo: number) => ({
      id,
      patientId: pid,
      doctorId: "doc-1",
      date: new Date(Date.now() - daysAgo * 86400_000),
      slotStart: "10:00",
      slotEnd: "10:30",
      tokenNumber: 1,
      type: "SCHEDULED",
      status,
      createdAt: new Date(Date.now() - (daysAgo + 3) * 86400_000),
      updatedAt: new Date(),
      patient: { id: pid, age: 35, address: null },
    });

    // 40 samples, half no-show with recent no-show history, half not
    for (let i = 0; i < 20; i++) rows.push(mkRow(`a${i}`, `p${i}`, "NO_SHOW", i + 1));
    for (let i = 20; i < 40; i++) rows.push(mkRow(`a${i}`, `p${i}`, "COMPLETED", i + 1));

    prismaMock.appointment.findMany.mockResolvedValueOnce(rows);

    const weightsPath = path.join(tmpDir, "weights.json");
    // Point the predictor at this path for both train and predict.
    process.env.NOSHOW_WEIGHTS_PATH = weightsPath;

    const summary = await trainModel(6, { weightsPath, epochs: 200 });
    expect(summary.nSamples).toBe(40);
    expect(summary.finalLoss).toBeLessThanOrEqual(summary.initialLoss);

    // Verify the weights file exists and round-trips
    const loaded = await loadModel(weightsPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.model.weights.length).toBeGreaterThan(0);
    resetNoShowModelCache();

    prismaMock.appointment.findUnique.mockResolvedValueOnce(
      makeAppointment({ id: "new-1", patientId: "pat-new" })
    );
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);
    const pred = await predictNoShow("new-1");
    expect(pred.source).toBe("ml");
  });

  it("falls back to rules when the weights file is corrupt", async () => {
    const weightsPath = path.join(tmpDir, "corrupt.json");
    await fs.writeFile(weightsPath, "{ not: valid json", "utf8");
    process.env.NOSHOW_WEIGHTS_PATH = weightsPath;
    resetNoShowModelCache();
    const loaded = await loadModel(weightsPath);
    expect(loaded).toBeNull();

    prismaMock.appointment.findUnique.mockResolvedValueOnce(makeAppointment());
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);
    const res = await predictNoShow("appt-1");
    expect(res.source).toBe("rules");
  });
});

describe("batchPredictNoShow", () => {
  it("sorts results by risk score descending", async () => {
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { id: "low" },
      { id: "high" },
    ]);
    // The sort order will be driven purely by the generated scores; wire up
    // two different patients so one has a recent no-show and the other doesn't.
    prismaMock.appointment.findUnique
      .mockResolvedValueOnce(
        makeAppointment({
          id: "low",
          patientId: "p-safe",
          createdAt: new Date("2026-04-19"),
        })
      )
      .mockResolvedValueOnce(
        makeAppointment({
          id: "high",
          patientId: "p-risky",
          createdAt: new Date("2026-03-01"),
        })
      );
    prismaMock.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makePast("NO_SHOW", "2026-04-15"),
        makePast("NO_SHOW", "2026-03-30"),
        makePast("NO_SHOW", "2026-03-15"),
        makePast("NO_SHOW", "2026-02-25"),
        makePast("COMPLETED", "2026-01-10"),
      ]);

    const out = await batchPredictNoShow("2026-04-20");
    expect(out.length).toBe(2);
    expect(out[0].riskScore).toBeGreaterThanOrEqual(out[1].riskScore);
  });
});

describe("trainModel", () => {
  it("refuses to train when there are fewer than 20 labelled appointments", async () => {
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);
    await expect(trainModel(6, { weightsPath: path.join(tmpDir, "w.json") })).rejects.toThrow(
      /not enough training data/
    );
  });
});
