import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    appointment: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "a-1" })),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  autoTransitionElapsedBookedToNoShow,
  istInstantFromDateAndSlot,
} from "./auto-noshow";

/**
 * Make a Prisma-shaped Date for the `date` column. Prisma stores date-only
 * fields as midnight UTC of the calendar day, so we mirror that here.
 */
function dateOnly(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00.000Z`);
}

/** Build a stub appointment row matching the `select` in auto-noshow.ts. */
function makeApt(overrides: Partial<{
  id: string;
  date: Date;
  slotStart: string | null;
  tokenNumber: number;
  doctorId: string;
  patientId: string;
}> = {}) {
  return {
    id: overrides.id ?? "apt-1",
    date: overrides.date ?? dateOnly("2026-04-29"),
    slotStart: overrides.slotStart ?? "10:00",
    tokenNumber: overrides.tokenNumber ?? 1,
    doctorId: overrides.doctorId ?? "doc-1",
    patientId: overrides.patientId ?? "pat-1",
  };
}

describe("istInstantFromDateAndSlot", () => {
  it("anchors a 10:00 IST slot to the right UTC instant", () => {
    const inst = istInstantFromDateAndSlot(dateOnly("2026-04-29"), "10:00");
    // 10:00 IST == 04:30 UTC
    expect(inst?.toISOString()).toBe("2026-04-29T04:30:00.000Z");
  });

  it("returns null on missing inputs", () => {
    expect(istInstantFromDateAndSlot(null, "10:00")).toBeNull();
    expect(istInstantFromDateAndSlot(dateOnly("2026-04-29"), null)).toBeNull();
    expect(istInstantFromDateAndSlot(dateOnly("2026-04-29"), "bogus")).toBeNull();
  });
});

describe("autoTransitionElapsedBookedToNoShow (Issue #388)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.appointment.findMany.mockResolvedValue([]);
    prismaMock.appointment.update.mockImplementation(
      async (args: any) => ({ id: args.where.id, status: "NO_SHOW" })
    );
    prismaMock.auditLog.create.mockResolvedValue({ id: "a-1" });
    prismaMock.$transaction.mockImplementation(async (ops: any[]) =>
      Promise.all(ops)
    );
  });

  it("transitions a clearly past BOOKED row to NO_SHOW with audit log", async () => {
    // Now = 2026-04-29 16:00 IST (10:30 UTC). Slot was 10:00 IST that day,
    // so the appointment is 6 hours past — well beyond the 30 min grace.
    const now = new Date("2026-04-29T10:30:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValue([
      makeApt({ id: "apt-past", slotStart: "10:00" }),
    ]);

    const result = await autoTransitionElapsedBookedToNoShow(now);

    expect(result.transitioned).toBe(1);
    expect(result.ids).toEqual(["apt-past"]);
    expect(prismaMock.appointment.update).toHaveBeenCalledWith({
      where: { id: "apt-past" },
      data: { status: "NO_SHOW" },
    });
    const audit = prismaMock.auditLog.create.mock.calls[0][0];
    expect(audit.data.action).toBe("APPOINTMENT_AUTO_NO_SHOW_ELAPSED");
    expect(audit.data.entity).toBe("appointment");
    expect(audit.data.entityId).toBe("apt-past");
  });

  it("leaves a recent BOOKED row alone when within the 30-min grace window", async () => {
    // Now = 2026-04-29 10:10 IST (04:40 UTC). Slot 10:00 IST → appointment
    // is only 10 min past start → still within grace.
    const now = new Date("2026-04-29T04:40:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValue([
      makeApt({ id: "apt-recent", slotStart: "10:00" }),
    ]);

    const result = await autoTransitionElapsedBookedToNoShow(now);

    expect(result.transitioned).toBe(0);
    expect(result.skippedWithinGrace).toBe(1);
    expect(prismaMock.appointment.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("never sees CANCELLED or COMPLETED rows because the where-clause filters by status=BOOKED", async () => {
    const now = new Date("2026-04-29T10:30:00.000Z");
    // Simulate the DB: the findMany contract is `status: 'BOOKED'`, so a
    // correct implementation should never receive non-BOOKED rows here.
    prismaMock.appointment.findMany.mockResolvedValue([]);

    const result = await autoTransitionElapsedBookedToNoShow(now);
    expect(result.transitioned).toBe(0);

    const where = prismaMock.appointment.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("BOOKED");
  });

  it("honors the 500-row batch cap via `take`", async () => {
    const now = new Date("2026-04-29T10:30:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValue([]);
    await autoTransitionElapsedBookedToNoShow(now);
    const args = prismaMock.appointment.findMany.mock.calls[0][0];
    expect(args.take).toBe(500);
  });

  it("continues processing if a single transition throws", async () => {
    const now = new Date("2026-04-29T10:30:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValue([
      makeApt({ id: "apt-1", slotStart: "08:00" }),
      makeApt({ id: "apt-2", slotStart: "08:00" }),
    ]);
    let call = 0;
    prismaMock.$transaction.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("DB blip");
      return [];
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await autoTransitionElapsedBookedToNoShow(now);
    expect(r.transitioned).toBe(1);
    errSpy.mockRestore();
  });
});
