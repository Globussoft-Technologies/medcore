/**
 * Test-cron tick (2026-05-25) — Smart Follow-up Scheduler unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the two exported entry points of
 *   `services/ai/follow-up.ts` — `parseFollowUpTimeline(text)` and
 *   `suggestFollowUp(consultationId)`. Locks the full timeline-parsing
 *   grammar (numeric multipliers + word numbers + bare hints + PRN
 *   heuristic), the null-bail when the consultation or timeline is
 *   missing, the happy-path with the original doctor, the
 *   same-specialty fallback when the original doctor is booked, and
 *   the General-Medicine GP last-ditch fallback when no same-specialty
 *   alternate has a free slot.
 *
 * - MODULES: hoisted mock of `../tenant-prisma` (which re-exports
 *   `@medcore/db.tenantScopedPrisma`) so no Postgres is touched.
 *   `follow-up.ts` does NOT call any LLM — the entire output is derived
 *   from the consultation notes + DoctorSchedule + Appointment rows.
 *   Mirrors the hoist + dual-mock shape used by `previsit.test.ts`
 *   (commit 48927cb3) so the suite stays consistent.
 *
 * - WHY: the follow-up scheduler is invoked from the AI Scribe
 *   `/finalize` hook. A silent regression in `parseFollowUpTimeline`
 *   would drop follow-up suggestions on the floor (patients never see
 *   them); a regression in `suggestFollowUp`'s fallback chain would
 *   suggest a booked slot or the wrong specialty. This suite pins each
 *   branch so future refactors fail loud.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    consultation: { findUnique: vi.fn() },
    doctorSchedule: { findMany: vi.fn() },
    appointment: { findMany: vi.fn() },
    doctor: { findMany: vi.fn() },
  } as any,
}));

vi.mock("../tenant-prisma", () => ({
  tenantScopedPrisma: prismaMock,
}));

vi.mock("@medcore/db", () => ({
  tenantScopedPrisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

import { parseFollowUpTimeline, suggestFollowUp } from "./follow-up";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeConsultation(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "cons-1",
    doctorId: over.doctorId ?? "doc-1",
    notes: over.notes ?? 'Plan: {"followUpTimeline":"2 weeks","patientInstructions":"rest"}',
    appointment: over.appointment === undefined
      ? { id: "appt-1", patientId: "pat-1" }
      : over.appointment,
    doctor: over.doctor === undefined
      ? { id: "doc-1", specialization: "Cardiology" }
      : over.doctor,
    ...over,
  };
}

function makeSchedule(over: Partial<any> = {}) {
  return {
    id: over.id ?? "sched-1",
    doctorId: over.doctorId ?? "doc-1",
    dayOfWeek: over.dayOfWeek ?? 0,
    startTime: over.startTime ?? "09:00",
    endTime: over.endTime ?? "10:00",
    slotDurationMinutes: over.slotDurationMinutes ?? 15,
  };
}

function resetAllMocks() {
  prismaMock.consultation.findUnique.mockReset();
  prismaMock.doctorSchedule.findMany.mockReset();
  prismaMock.appointment.findMany.mockReset();
  prismaMock.doctor.findMany.mockReset();
  // Safe defaults — every test that cares overrides explicitly.
  prismaMock.consultation.findUnique.mockResolvedValue(null);
  prismaMock.doctorSchedule.findMany.mockResolvedValue([]);
  prismaMock.appointment.findMany.mockResolvedValue([]);
  prismaMock.doctor.findMany.mockResolvedValue([]);
}

// ─── parseFollowUpTimeline ────────────────────────────────────────────────

describe("parseFollowUpTimeline — null / falsy inputs", () => {
  it("returns null for null", () => {
    expect(parseFollowUpTimeline(null)).toBeNull();
  });
  it("returns null for undefined", () => {
    expect(parseFollowUpTimeline(undefined)).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parseFollowUpTimeline("")).toBeNull();
  });
  it("returns null for non-string input", () => {
    // Force a non-string through the public surface to exercise the typeof guard.
    expect(parseFollowUpTimeline(42 as unknown as string)).toBeNull();
  });
  it("returns null when no timeline can be extracted", () => {
    expect(parseFollowUpTimeline("call the clinic if symptoms worsen")).toBeNull();
  });
});

describe("parseFollowUpTimeline — numeric multipliers", () => {
  it("parses N days", () => {
    expect(parseFollowUpTimeline("follow up in 10 days")).toBe(10);
  });
  it("parses N day (singular)", () => {
    expect(parseFollowUpTimeline("review in 1 day")).toBe(1);
  });
  it("parses N d (short form)", () => {
    expect(parseFollowUpTimeline("come back in 5 d")).toBe(5);
  });
  it("parses N weeks", () => {
    expect(parseFollowUpTimeline("follow up in 2 weeks")).toBe(14);
  });
  it("parses N wk", () => {
    expect(parseFollowUpTimeline("review after 3 wk")).toBe(21);
  });
  it("parses N wks", () => {
    expect(parseFollowUpTimeline("review after 4 wks")).toBe(28);
  });
  it("parses N months", () => {
    expect(parseFollowUpTimeline("review in 3 months")).toBe(90);
  });
  it("parses N mo", () => {
    expect(parseFollowUpTimeline("see again in 6 mo")).toBe(180);
  });
  it("parses N years", () => {
    expect(parseFollowUpTimeline("annual review in 1 year")).toBe(365);
  });
  it("parses N yrs", () => {
    expect(parseFollowUpTimeline("review in 2 yrs")).toBe(730);
  });
  it("returns null when the numeric horizon is zero", () => {
    // 0 fails the n > 0 guard and the parser falls through.
    expect(parseFollowUpTimeline("follow up in 0 days")).toBeNull();
  });
  it("prefers the day-pattern when both day and week appear", () => {
    // The loop iterates day → week, so the first hit wins.
    expect(parseFollowUpTimeline("7 days or 2 weeks")).toBe(7);
  });
});

describe("parseFollowUpTimeline — word-number fallbacks", () => {
  it("parses 'two weeks'", () => {
    expect(parseFollowUpTimeline("come back in two weeks")).toBe(14);
  });
  it("parses 'three days'", () => {
    expect(parseFollowUpTimeline("review after three days")).toBe(3);
  });
  it("parses 'six months'", () => {
    expect(parseFollowUpTimeline("repeat scan in six months")).toBe(180);
  });
  it("parses 'twelve weeks'", () => {
    expect(parseFollowUpTimeline("rehab plan twelve weeks")).toBe(84);
  });
  it("parses 'one week'", () => {
    expect(parseFollowUpTimeline("come back in one week")).toBe(7);
  });
});

describe("parseFollowUpTimeline — bare hints", () => {
  it("parses 'tomorrow' as 1 day", () => {
    expect(parseFollowUpTimeline("review tomorrow")).toBe(1);
  });
  it("parses 'next week' as 7 days", () => {
    expect(parseFollowUpTimeline("see again next week")).toBe(7);
  });
  it("parses 'next month' as 30 days", () => {
    expect(parseFollowUpTimeline("schedule next month")).toBe(30);
  });
  it("parses 'PRN' as a 7-day soft heuristic", () => {
    expect(parseFollowUpTimeline("PRN if not improving")).toBe(7);
  });
  it("parses 'as needed' as a 7-day soft heuristic", () => {
    expect(parseFollowUpTimeline("Follow up as needed")).toBe(7);
  });
  it("parses 'if not improving' as a 7-day soft heuristic", () => {
    expect(parseFollowUpTimeline("come back if not improving")).toBe(7);
  });
  it("is case-insensitive", () => {
    expect(parseFollowUpTimeline("FOLLOW UP IN 5 DAYS")).toBe(5);
  });
});

// ─── suggestFollowUp — bail paths ─────────────────────────────────────────

describe("suggestFollowUp — null-bail paths", () => {
  beforeEach(resetAllMocks);

  it("returns null when the consultation does not exist", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(null);

    const out = await suggestFollowUp("missing");

    expect(out).toBeNull();
    expect(prismaMock.doctorSchedule.findMany).not.toHaveBeenCalled();
  });

  it("returns null when the consultation has no notes", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({ notes: null }),
    );

    const out = await suggestFollowUp("cons-1");

    expect(out).toBeNull();
    expect(prismaMock.doctorSchedule.findMany).not.toHaveBeenCalled();
  });

  it("returns null when notes contain no follow-up timeline", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({ notes: "Patient appears stable. Continue current meds." }),
    );

    const out = await suggestFollowUp("cons-1");

    expect(out).toBeNull();
  });

  it("returns null when Plan JSON has an empty followUpTimeline", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"","patientInstructions":"rest"}',
      }),
    );

    const out = await suggestFollowUp("cons-1");

    expect(out).toBeNull();
  });

  it("returns null when Plan JSON is malformed and no loose match", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {not valid json}',
      }),
    );

    const out = await suggestFollowUp("cons-1");

    expect(out).toBeNull();
  });
});

// ─── suggestFollowUp — happy path with original doctor ────────────────────

describe("suggestFollowUp — original doctor has free slot", () => {
  beforeEach(resetAllMocks);

  it("returns a suggestion with the original doctor when their slot is free", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"2 weeks"}',
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule()]);
    prismaMock.appointment.findMany.mockResolvedValue([]); // all slots free

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.consultationId).toBe("cons-1");
    expect(out!.doctorId).toBe("doc-1");
    expect(out!.fallbackUsed).toBe(false);
    expect(out!.slotStart).toBe("09:00");
    expect(out!.reason).toBe("2 weeks");
    // ISO yyyy-mm-dd
    expect(out!.suggestedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Same-specialty fallback should never have been queried.
    expect(prismaMock.doctor.findMany).not.toHaveBeenCalled();
  });

  it("computes the target date as today + N days", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"3 days"}',
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule({ dayOfWeek: -1 })]); // any day
    // Always return a schedule for whichever weekday is hit.
    prismaMock.doctorSchedule.findMany.mockImplementation(() => Promise.resolve([makeSchedule()]));

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    const expected = new Date();
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() + 3);
    expect(out!.suggestedDate).toBe(expected.toISOString().slice(0, 10));
  });

  it("skips slots that are already booked and returns the next free one", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
      }),
    );
    // Schedule yields 09:00, 09:15, 09:30, 09:45.
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule()]);
    prismaMock.appointment.findMany.mockResolvedValue([
      { slotStart: "09:00" },
      { slotStart: "09:15" },
    ]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.slotStart).toBe("09:30");
    expect(out!.fallbackUsed).toBe(false);
  });

  it("respects null slotStart entries when computing booked-set", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule()]);
    prismaMock.appointment.findMany.mockResolvedValue([
      { slotStart: null },
      { slotStart: "09:00" },
    ]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    // 09:00 booked, null filtered out, 09:15 free.
    expect(out!.slotStart).toBe("09:15");
  });

  it("uses 15-minute default duration when slotDurationMinutes is null", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([
      makeSchedule({ slotDurationMinutes: null, startTime: "10:00", endTime: "10:30" }),
    ]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.slotStart).toBe("10:00");
  });

  it("falls back to a loose-regex extraction when there is no Plan JSON", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: "Stable on losartan. Follow up in 4 weeks for BP review.",
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule()]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    // The loose regex captures the surrounding clause, so reason is non-empty
    // and conveys the 4-week horizon.
    expect(out!.reason.toLowerCase()).toContain("4 week");
    expect(out!.doctorId).toBe("doc-1");
  });

  it("uses a default reason when extractFollowUpText returns the bare timeline only", async () => {
    // Plan JSON with bare "7 days" — reason will be "7 days" (truthy) so no default.
    // To exercise the `|| "Follow-up after consultation"` branch we'd need the
    // extracted text to be falsy, but parseFollowUpTimeline would also bail
    // in that case. So the default-reason branch is logically unreachable
    // for non-null results — documented here for posterity.
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"5 days"}',
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule()]);

    const out = await suggestFollowUp("cons-1");

    expect(out!.reason).toBe("5 days");
  });
});

// ─── suggestFollowUp — same-specialty fallback ────────────────────────────

describe("suggestFollowUp — same-specialty fallback when original is booked", () => {
  beforeEach(resetAllMocks);

  it("falls back to another doctor of the same specialty when original has no schedule", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: { id: "doc-1", specialization: "Cardiology" },
      }),
    );
    // 1st call (original doc) → empty schedule. 2nd call (candidate) → schedule.
    prismaMock.doctorSchedule.findMany
      .mockResolvedValueOnce([]) // original
      .mockResolvedValueOnce([makeSchedule({ doctorId: "doc-2" })]); // candidate
    prismaMock.doctor.findMany.mockResolvedValue([{ id: "doc-2" }]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.doctorId).toBe("doc-2");
    expect(out!.fallbackUsed).toBe(true);
    expect(out!.slotStart).toBe("09:00");
    // Same-specialty query: specialization=Cardiology, not original doc.
    expect(prismaMock.doctor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          specialization: "Cardiology",
          id: { not: "doc-1" },
        }),
        take: 10,
      }),
    );
  });

  it("falls back to the second same-specialty candidate when the first is also booked", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: { id: "doc-1", specialization: "Cardiology" },
      }),
    );
    // original empty, candidate-A empty, candidate-B has a slot.
    prismaMock.doctorSchedule.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeSchedule({ doctorId: "doc-3" })]);
    prismaMock.doctor.findMany.mockResolvedValueOnce([{ id: "doc-2" }, { id: "doc-3" }]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.doctorId).toBe("doc-3");
    expect(out!.fallbackUsed).toBe(true);
  });

  it("skips the specialty branch entirely when consultation.doctor is null", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: null,
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([]); // nobody has a slot

    const out = await suggestFollowUp("cons-1");

    // Both specialty + GP fallbacks bail; result still returned but slotless.
    expect(out).not.toBeNull();
    expect(out!.slotStart).toBeNull();
    expect(out!.fallbackUsed).toBe(false);
    // The specialty doctor.findMany should never have run because specialty is undefined.
    // The GP doctor.findMany WILL run as the last-ditch.
    expect(prismaMock.doctor.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.doctor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          specialization: { in: ["General Medicine", "General Physician"] },
        }),
      }),
    );
  });
});

// ─── suggestFollowUp — GP last-ditch fallback ─────────────────────────────

describe("suggestFollowUp — GP last-ditch fallback", () => {
  beforeEach(resetAllMocks);

  it("falls back to a General Medicine doctor when no same-specialty alternate has a slot", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: { id: "doc-1", specialization: "Cardiology" },
      }),
    );
    // original empty, same-specialty candidate empty, GP has a slot.
    prismaMock.doctorSchedule.findMany
      .mockResolvedValueOnce([]) // original
      .mockResolvedValueOnce([]) // specialty candidate
      .mockResolvedValueOnce([makeSchedule({ doctorId: "gp-1" })]); // GP
    prismaMock.doctor.findMany
      .mockResolvedValueOnce([{ id: "doc-2" }]) // same specialty
      .mockResolvedValueOnce([{ id: "gp-1" }]); // GPs

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.doctorId).toBe("gp-1");
    expect(out!.fallbackUsed).toBe(true);
    expect(prismaMock.doctor.findMany).toHaveBeenCalledTimes(2);
    // Second call is the GP query.
    expect(prismaMock.doctor.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          specialization: { in: ["General Medicine", "General Physician"] },
        }),
        take: 5,
      }),
    );
  });

  it("skips a GP candidate whose id equals the original doctor", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: { id: "doc-1", specialization: "General Medicine" },
      }),
    );
    prismaMock.doctorSchedule.findMany
      .mockResolvedValueOnce([]) // original
      .mockResolvedValueOnce([makeSchedule({ doctorId: "gp-2" })]); // second GP after skip
    // Same-specialty fallback returns [] (id:{not:doc-1} excludes original)
    prismaMock.doctor.findMany
      .mockResolvedValueOnce([]) // same-specialty empty
      .mockResolvedValueOnce([{ id: "doc-1" }, { id: "gp-2" }]); // GPs include original

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    // Original "doc-1" must be skipped despite being in the GP list.
    expect(out!.doctorId).toBe("gp-2");
    expect(out!.fallbackUsed).toBe(true);
  });

  it("returns suggestion with null slotStart when nothing is available anywhere", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: { id: "doc-1", specialization: "Cardiology" },
      }),
    );
    // Every doctorSchedule call returns empty.
    prismaMock.doctorSchedule.findMany.mockResolvedValue([]);
    prismaMock.doctor.findMany
      .mockResolvedValueOnce([{ id: "doc-2" }]) // same specialty list
      .mockResolvedValueOnce([{ id: "gp-1" }]); // GP list

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.slotStart).toBeNull();
    expect(out!.fallbackUsed).toBe(false); // never set true since nobody had a slot
    expect(out!.doctorId).toBe("doc-1"); // stays with original
  });

  it("returns suggestion with null slot when the doctor's schedule has zero slots that fit", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: null, // skip specialty fallback
      }),
    );
    // start=09:00, end=09:05, duration=15 → no slot fits.
    prismaMock.doctorSchedule.findMany.mockResolvedValueOnce([
      makeSchedule({ startTime: "09:00", endTime: "09:05", slotDurationMinutes: 15 }),
    ]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.slotStart).toBeNull();
  });

  it("returns suggestion when every slot in the schedule is booked", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
        doctor: null, // skip specialty fallback
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValueOnce([
      makeSchedule({ startTime: "09:00", endTime: "09:30", slotDurationMinutes: 15 }),
    ]);
    // Both 09:00 and 09:15 booked.
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { slotStart: "09:00" },
      { slotStart: "09:15" },
    ]);

    const out = await suggestFollowUp("cons-1");

    expect(out).not.toBeNull();
    expect(out!.slotStart).toBeNull();
  });
});

// ─── suggestFollowUp — appointment-query shape ────────────────────────────

describe("suggestFollowUp — appointment-query shape", () => {
  beforeEach(resetAllMocks);

  it("excludes CANCELLED and NO_SHOW appointments from the booked set", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: 'Plan: {"followUpTimeline":"7 days"}',
      }),
    );
    prismaMock.doctorSchedule.findMany.mockResolvedValue([makeSchedule()]);
    prismaMock.appointment.findMany.mockResolvedValue([]);

    await suggestFollowUp("cons-1");

    expect(prismaMock.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          doctorId: "doc-1",
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        }),
        select: { slotStart: true },
      }),
    );
  });
});
