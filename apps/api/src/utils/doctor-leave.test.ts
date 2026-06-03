// Unit tests for isDoctorOnConfirmedLeave — the gate that hides a
// doctor's booking slots on days they have a CONFIRMED (APPROVED) leave.
//
// What / modules / why
// ────────────────────
// - WHAT: lock the contract that only an APPROVED LeaveRequest covering
//   the requested date returns true; resolve Doctor.userId first; PENDING
//   leave does NOT count; a doctor with no user / no leave returns false.
// - MODULES: hoisted mock of `@medcore/db` (the helper's only dependency:
//   prisma.doctor.findUnique + prisma.leaveRequest.findFirst). Pure-unit —
//   no Postgres.
// - WHY: this helper backs the slot grid + the book/reschedule server
//   guards across doctors.ts, public-booking.ts, appointments.ts. A
//   regression (e.g. counting PENDING leave, or skipping the userId
//   resolution) would either hide slots wrongly or let patients book on a
//   doctor's confirmed day off.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    doctor: { findUnique: vi.fn() },
    leaveRequest: { findFirst: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
}));

import { isDoctorOnConfirmedLeave } from "./doctor-leave";

const DATE = new Date("2026-06-10T00:00:00.000Z");

describe("isDoctorOnConfirmedLeave", () => {
  beforeEach(() => {
    prismaMock.doctor.findUnique.mockReset();
    prismaMock.leaveRequest.findFirst.mockReset();
  });

  it("returns false when the doctor row can't be resolved", async () => {
    prismaMock.doctor.findUnique.mockResolvedValue(null);
    const out = await isDoctorOnConfirmedLeave("doc-x", DATE);
    expect(out).toBe(false);
    // Never queries leave if there's no userId to key on.
    expect(prismaMock.leaveRequest.findFirst).not.toHaveBeenCalled();
  });

  it("returns true when an APPROVED leave covers the date", async () => {
    prismaMock.doctor.findUnique.mockResolvedValue({ userId: "user-1" });
    prismaMock.leaveRequest.findFirst.mockResolvedValue({ id: "leave-1" });
    const out = await isDoctorOnConfirmedLeave("doc-1", DATE);
    expect(out).toBe(true);
  });

  it("returns false when no leave row matches (e.g. only PENDING leave)", async () => {
    prismaMock.doctor.findUnique.mockResolvedValue({ userId: "user-1" });
    // The query filters status: "APPROVED", so a PENDING-only doctor yields
    // no row → findFirst resolves null.
    prismaMock.leaveRequest.findFirst.mockResolvedValue(null);
    const out = await isDoctorOnConfirmedLeave("doc-1", DATE);
    expect(out).toBe(false);
  });

  it("queries leave by the resolved userId, APPROVED status, and an inclusive date range", async () => {
    prismaMock.doctor.findUnique.mockResolvedValue({ userId: "user-42" });
    prismaMock.leaveRequest.findFirst.mockResolvedValue({ id: "leave-9" });

    await isDoctorOnConfirmedLeave("doc-42", DATE);

    expect(prismaMock.doctor.findUnique).toHaveBeenCalledWith({
      where: { id: "doc-42" },
      select: { userId: true },
    });
    const arg = prismaMock.leaveRequest.findFirst.mock.calls[0][0];
    expect(arg.where.userId).toBe("user-42");
    expect(arg.where.status).toBe("APPROVED");
    // Inclusive overlap: fromDate <= date AND toDate >= date.
    expect(arg.where.fromDate).toEqual({ lte: DATE });
    expect(arg.where.toDate).toEqual({ gte: DATE });
  });
});
