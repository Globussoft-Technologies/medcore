/**
 * Integration tests for Pearl §5.2 (gap matrix rows 142-145) — chronic-
 * care cohort rule DSL + auto-enrolment + sequence stepper + on-visit
 * advance hook.
 *
 * What's covered:
 *   1. autoEnrolAndRemove() matches gender=FEMALE → 3 plans created.
 *   2. Re-running is idempotent (0 new rows).
 *   3. Flipping one matched patient to MALE deactivates that plan.
 *   4. A patient re-matching after a mismatch is re-activated.
 *   5. runChronicCareSequenceSends() sends step 1 to a new enrolment.
 *   6. advanceChronicCareSequence(patientId) skip-and-advances to step 2.
 *   7. Manual ChronicCarePlan rows (cohortId=null) are never touched.
 */
import { it, expect, beforeAll, vi } from "vitest";
import { describeIfDB, resetDB, getPrisma } from "../setup";

// Mock the channel-fanning notification sender so tests don't depend on
// MSG91 / FCM / SMTP being configured. Notifications still hit the DB
// row count (we don't read it here) but the underlying send is a no-op.
vi.mock("../../services/notification", async () => {
  const actual = await vi.importActual<any>("../../services/notification");
  return {
    ...actual,
    sendNotification: vi.fn().mockResolvedValue({ id: "stub" }),
  };
});

describeIfDB("Chronic-care auto-enrolment + sequence stepper (Pearl §5.2 rows 142-145)", () => {
  let prisma: any;
  let cohortId: string;
  let stepIds: string[] = [];
  const femaleIds: string[] = [];
  const maleIds: string[] = [];

  beforeAll(async () => {
    await resetDB();
    prisma = await getPrisma();

    // Seed 3 FEMALE + 2 MALE patients (no tenant — keep the test simple
    // and exercise the no-tenant code path).
    for (let i = 0; i < 3; i++) {
      const user = await prisma.user.create({
        data: {
          email: `cc-f-${i}-${Date.now()}@test.local`,
          name: `Female Patient ${i}`,
          phone: `99001${10 + i}`,
          passwordHash: "x",
          role: "PATIENT",
        },
      });
      const patient = await prisma.patient.create({
        data: {
          userId: user.id,
          mrNumber: `MR-F-${i}-${Date.now()}`,
          dateOfBirth: new Date("1990-01-01"),
          gender: "FEMALE",
        },
      });
      femaleIds.push(patient.id);
    }
    for (let i = 0; i < 2; i++) {
      const user = await prisma.user.create({
        data: {
          email: `cc-m-${i}-${Date.now()}@test.local`,
          name: `Male Patient ${i}`,
          phone: `99002${10 + i}`,
          passwordHash: "x",
          role: "PATIENT",
        },
      });
      const patient = await prisma.patient.create({
        data: {
          userId: user.id,
          mrNumber: `MR-M-${i}-${Date.now()}`,
          dateOfBirth: new Date("1990-01-01"),
          gender: "MALE",
        },
      });
      maleIds.push(patient.id);
    }

    // Cohort: all FEMALE patients, DIABETES condition.
    const cohort = await prisma.chronicCareCohort.create({
      data: {
        name: "Diabetic women",
        condition: "DIABETES",
        cohortRule: {
          filters: [{ field: "gender", op: "eq", value: "FEMALE" }],
          matchMode: "ALL",
        },
        active: true,
        createdBy: "test-admin",
      },
    });
    cohortId = cohort.id;

    // Sequence: step 1 immediate, step 2 at +7 days.
    const s1 = await prisma.cohortSequenceStep.create({
      data: {
        chronicCareCohortId: cohortId,
        stepNumber: 1,
        delayDays: 0,
        templateKey: "diabetes_welcome",
        channels: ["SMS"],
        active: true,
      },
    });
    const s2 = await prisma.cohortSequenceStep.create({
      data: {
        chronicCareCohortId: cohortId,
        stepNumber: 2,
        delayDays: 7,
        templateKey: "diabetes_lab_reminder",
        channels: ["SMS", "EMAIL"],
        active: true,
      },
    });
    stepIds = [s1.id, s2.id];
  });

  it("autoEnrolAndRemove() creates one ChronicCarePlan per matching patient", async () => {
    const { autoEnrolAndRemove } = await import(
      "../../services/chronic-care-enrolment"
    );
    const result = await autoEnrolAndRemove();
    expect(result.cohortsEvaluated).toBe(1);
    expect(result.enrolled).toBe(3);
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);

    const plans = await prisma.chronicCarePlan.findMany({
      where: { cohortId },
      select: { patientId: true, active: true },
    });
    expect(plans).toHaveLength(3);
    expect(plans.every((p: any) => p.active)).toBe(true);
    const patientIds = plans.map((p: any) => p.patientId).sort();
    expect(patientIds).toEqual([...femaleIds].sort());
  });

  it("re-running autoEnrolAndRemove() is a no-op (idempotent)", async () => {
    const { autoEnrolAndRemove } = await import(
      "../../services/chronic-care-enrolment"
    );
    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("flipping a patient to MALE deactivates her plan on next pass", async () => {
    const victim = femaleIds[0];
    await prisma.patient.update({
      where: { id: victim },
      data: { gender: "MALE" },
    });
    const { autoEnrolAndRemove } = await import(
      "../../services/chronic-care-enrolment"
    );
    const result = await autoEnrolAndRemove();
    expect(result.removed).toBe(1);
    const row = await prisma.chronicCarePlan.findFirst({
      where: { cohortId, patientId: victim },
      select: { active: true },
    });
    expect(row?.active).toBe(false);
  });

  it("re-activates a previously-removed plan when the patient matches again", async () => {
    const victim = femaleIds[0];
    await prisma.patient.update({
      where: { id: victim },
      data: { gender: "FEMALE" },
    });
    const { autoEnrolAndRemove } = await import(
      "../../services/chronic-care-enrolment"
    );
    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(1);
    const row = await prisma.chronicCarePlan.findFirst({
      where: { cohortId, patientId: victim },
      select: { active: true },
    });
    expect(row?.active).toBe(true);
  });

  it("runChronicCareSequenceSends() sends step 1 for new enrolments", async () => {
    const { runChronicCareSequenceSends } = await import(
      "../../services/chronic-care-scheduler"
    );
    const result = await runChronicCareSequenceSends();
    // Every active female plan has lastStepSent=0 + cohort step 1 at
    // delayDays=0 — so all of them should fire on this pass.
    expect(result.sent).toBeGreaterThanOrEqual(3);
    expect(result.errors).toBe(0);

    const plans = await prisma.chronicCarePlan.findMany({
      where: { cohortId, active: true },
      select: { lastStepSent: true, lastStepSentAt: true },
    });
    expect(plans.every((p: any) => p.lastStepSent === 1)).toBe(true);
    expect(plans.every((p: any) => p.lastStepSentAt instanceof Date)).toBe(true);
  });

  it("re-running sequence sweep doesn't fire step 2 until delayDays elapse", async () => {
    const { runChronicCareSequenceSends } = await import(
      "../../services/chronic-care-scheduler"
    );
    const result = await runChronicCareSequenceSends();
    expect(result.sent).toBe(0); // step 2 has delayDays=7, not yet due
  });

  it("advanceChronicCareSequence() skip-and-advances to step 2 on check-in", async () => {
    const target = femaleIds[1];
    const { advanceChronicCareSequence } = await import(
      "../../services/chronic-care-scheduler"
    );
    const sent = await advanceChronicCareSequence(target);
    expect(sent).toBeGreaterThanOrEqual(1);
    const row = await prisma.chronicCarePlan.findFirst({
      where: { cohortId, patientId: target },
      select: { lastStepSent: true },
    });
    expect(row?.lastStepSent).toBe(2);
  });

  it("advanceChronicCareSequence() returns 0 once the sequence is exhausted", async () => {
    const target = femaleIds[1];
    const { advanceChronicCareSequence } = await import(
      "../../services/chronic-care-scheduler"
    );
    const sent = await advanceChronicCareSequence(target);
    expect(sent).toBe(0); // no step 3 exists
  });

  it("manual ChronicCarePlan rows (cohortId=null) are not touched by auto-remove", async () => {
    const manualPatient = maleIds[0];
    const manual = await prisma.chronicCarePlan.create({
      data: {
        patientId: manualPatient,
        condition: "HYPERTENSION",
        createdBy: "test-admin",
        active: true,
        // cohortId left null — this is a manual enrolment
      },
    });
    const { autoEnrolAndRemove } = await import(
      "../../services/chronic-care-enrolment"
    );
    await autoEnrolAndRemove();
    const after = await prisma.chronicCarePlan.findUnique({
      where: { id: manual.id },
      select: { active: true, cohortId: true },
    });
    expect(after?.active).toBe(true);
    expect(after?.cohortId).toBeNull();
  });

  it("a cohort with no cohortRule is skipped by the cron", async () => {
    // Create a second cohort with no rule — it should be ignored.
    const idle = await prisma.chronicCareCohort.create({
      data: {
        name: "Manual-only cohort",
        active: true,
        createdBy: "test-admin",
        // cohortRule omitted (null)
      },
    });
    const { autoEnrolAndRemove } = await import(
      "../../services/chronic-care-enrolment"
    );
    const result = await autoEnrolAndRemove();
    // The first cohort still evaluates but yields 0 deltas; the new one
    // is filtered out by the `NOT: { cohortRule: { equals: null } }` clause.
    expect(result.cohortsEvaluated).toBe(1);
    // Cleanup so this test doesn't poison sibling re-runs
    await prisma.chronicCareCohort.delete({ where: { id: idle.id } });
  });
});
