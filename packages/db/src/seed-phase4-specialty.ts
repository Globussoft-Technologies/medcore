/**
 * Phase 4 specialty seed — Antenatal (ANC) cases + pediatric growth records.
 *
 * Idempotency contract (2026-05-11): safe to re-run on a populated demo
 * without creating duplicate ANC cases, duplicate visits, or wiping
 * user-created growth records.
 *
 *   - AntenatalCase: stable seed-namespaced `caseNumber = ANC-SEED-<NNNN>`
 *     (1..3) — distinct from the live production ANC counter (`ANC000001..`)
 *     so the seed never reuses or collides with a real-tenant case number.
 *     Skip-or-create via `findUnique({ where: { caseNumber } })`.
 *     Note: AntenatalCase.patientId is `@unique` (one active case per
 *     patient), so we also tolerate prior seed-runs where a patient
 *     already has a non-seed case — those patients are skipped from
 *     the eligible set (this part was already idempotent pre-2026-05-11).
 *   - AncVisit: no natural unique key; anchored by `(ancCaseId, type,
 *     visitDate)` triple via findFirst skip-or-create. Per-case visit
 *     definitions are deterministic (hard-coded list below), so this
 *     triple is stable across re-runs.
 *   - GrowthRecord: previously did `deleteMany({ where: { patientId } })`
 *     before re-creating, which would WIPE real growth records logged by
 *     a clinician for that patient on every deploy. Replaced with
 *     `findFirst({ where: { patientId, ageMonths } })` skip-or-create
 *     keyed on (patientId, ageMonths). The seed only re-creates the
 *     specific milestone ages (0, 2, 4, 6, 12 months); any human-entered
 *     records at other ages or with different anchor dates are preserved.
 *
 * No `Math.random()` is used in this file — all decisions are already
 * deterministic — so no PRNG is needed.
 *
 * Wired into `scripts/deploy.sh` by the orchestrator (separate commit).
 * Failures are non-fatal (matches the policy of every other deploy-time
 * fixture seed).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function main() {
  console.log("=== Seeding Phase 4 Specialty (ANC + Growth) ===\n");

  // Find female patients
  const femalePatients = await prisma.patient.findMany({
    where: { gender: "FEMALE" },
    take: 10,
    include: { user: true },
  });

  const doctors = await prisma.doctor.findMany({ take: 5, include: { user: true } });

  if (femalePatients.length < 3 || doctors.length < 1) {
    console.log(
      "Skipping — need at least 3 female patients and 1 doctor. Run seed-realistic first."
    );
    await prisma.$disconnect();
    return;
  }

  // Pick 3 female patients who don't already have an ANC case (per the
  // patientId @unique constraint). On a re-run, the patients seeded
  // previously will already have a case and re-enter this branch via the
  // findUnique-on-caseNumber path below, NOT via `eligible[]`.
  const eligible: typeof femalePatients = [];
  for (const p of femalePatients) {
    const exists = await prisma.antenatalCase.findUnique({
      where: { patientId: p.id },
    });
    if (!exists) eligible.push(p);
    if (eligible.length === 3) break;
  }

  const doctor = doctors[0];
  const now = new Date();

  // ─── Canonical 3-case seed definition ───────────────
  // Each case has a stable seed-namespaced caseNumber so re-runs hit the
  // existing row via findUnique. The patient binding is sticky: once a
  // seed case is created for a particular patient, that case keeps living
  // there even if a different female patient appears earlier in
  // `femalePatients` on the next run.
  const seedCases: Array<{
    seedIdx: number;
    lmpOffsetWeeks: number; // negative = LMP weeks ago
    gravida: number;
    parity: number;
    bloodGroup: string;
    isHighRisk: boolean;
    riskFactors?: string;
    delivered?: {
      deliveryType: string;
      babyGender: string;
      babyWeight: number;
      outcomeNotes: string;
      preEddDays: number; // delivered preEddDays before EDD
    };
  }> = [
    {
      seedIdx: 1,
      lmpOffsetWeeks: -14,
      gravida: 1,
      parity: 0,
      bloodGroup: "O+",
      isHighRisk: false,
    },
    {
      seedIdx: 2,
      lmpOffsetWeeks: -28,
      gravida: 3,
      parity: 1,
      bloodGroup: "A+",
      isHighRisk: true,
      riskFactors: "Previous C-section, Hypertension, GDM",
    },
    {
      seedIdx: 3,
      lmpOffsetWeeks: -42,
      gravida: 2,
      parity: 1,
      bloodGroup: "B+",
      isHighRisk: false,
      delivered: {
        deliveryType: "NORMAL",
        babyGender: "FEMALE",
        babyWeight: 3.1,
        outcomeNotes: "Normal vaginal delivery. Apgar 9/10. Baby healthy.",
        preEddDays: 14,
      },
    },
  ];

  for (const sc of seedCases) {
    const caseNumber = `ANC-SEED-${String(sc.seedIdx).padStart(4, "0")}`;

    // Skip-or-create on stable caseNumber.
    let c = await prisma.antenatalCase.findUnique({ where: { caseNumber } });
    if (c) {
      console.log(`  ANC case ${caseNumber} already exists — skip create, ensure visits.`);
    } else {
      // Need a patient slot. If we have no eligible patient for this seed
      // index AND no existing case, skip this seed entry.
      const patient = eligible[sc.seedIdx - 1];
      if (!patient) {
        console.log(`  No eligible patient for ${caseNumber} — skipping.`);
        continue;
      }

      const lmp = addDays(now, sc.lmpOffsetWeeks * 7);
      const edd = addDays(lmp, 280);
      const deliveredAt = sc.delivered ? addDays(edd, -sc.delivered.preEddDays) : null;

      c = await prisma.antenatalCase.create({
        data: {
          caseNumber,
          patientId: patient.id,
          doctorId: doctor.id,
          lmpDate: lmp,
          eddDate: edd,
          gravida: sc.gravida,
          parity: sc.parity,
          bloodGroup: sc.bloodGroup,
          isHighRisk: sc.isHighRisk,
          riskFactors: sc.riskFactors,
          ...(sc.delivered && deliveredAt
            ? {
                deliveredAt,
                deliveryType: sc.delivered.deliveryType,
                babyGender: sc.delivered.babyGender,
                babyWeight: sc.delivered.babyWeight,
                outcomeNotes: sc.delivered.outcomeNotes,
              }
            : {}),
        },
      });
      console.log(`  Created ANC case ${caseNumber} for ${patient.user.name}`);
    }

    // Build the deterministic visit list for this case. Re-derive lmp
    // from the row itself so re-runs always re-anchor to whatever LMP
    // was first seeded.
    const lmp = c.lmpDate;
    const edd = c.eddDate;
    type VisitInput = {
      type: string;
      visitDate: Date;
      weeksOfGestation?: number;
      weight?: number;
      bloodPressure?: string;
      fundalHeight?: string;
      fetalHeartRate?: number;
      presentation?: string;
      hemoglobin?: number;
      urineProtein?: string;
      urineSugar?: string;
      prescribedMeds?: string;
      notes?: string;
      nextVisitDate?: Date;
    };
    const visitsForCase: VisitInput[] = [];

    if (sc.seedIdx === 1) {
      visitsForCase.push(
        {
          type: "FIRST_VISIT",
          visitDate: addDays(lmp, 6 * 7),
          weeksOfGestation: 6,
          weight: 56,
          bloodPressure: "110/70",
          hemoglobin: 11.8,
          urineProtein: "nil",
          urineSugar: "nil",
          prescribedMeds: "Folic acid 5mg OD",
          notes: "Booking visit, first pregnancy.",
          nextVisitDate: addDays(lmp, 10 * 7),
        },
        {
          type: "ROUTINE",
          visitDate: addDays(lmp, 10 * 7),
          weeksOfGestation: 10,
          weight: 57.2,
          bloodPressure: "112/72",
          hemoglobin: 11.5,
          urineProtein: "nil",
          urineSugar: "nil",
          prescribedMeds: "Folic acid, Iron",
          notes: "Progressing well. USG done.",
          nextVisitDate: addDays(lmp, 14 * 7),
        },
        {
          type: "ROUTINE",
          visitDate: addDays(lmp, 14 * 7),
          weeksOfGestation: 14,
          weight: 58.5,
          bloodPressure: "118/78",
          fundalHeight: "14",
          fetalHeartRate: 148,
          hemoglobin: 11.2,
          urineProtein: "nil",
          urineSugar: "nil",
          prescribedMeds: "Iron, Calcium",
          notes: "Fetal heart tones audible. Mother feeling well.",
        },
      );
    } else if (sc.seedIdx === 2) {
      visitsForCase.push(
        {
          type: "FIRST_VISIT",
          visitDate: addDays(lmp, 8 * 7),
          weeksOfGestation: 8,
          weight: 68,
          bloodPressure: "135/88",
          hemoglobin: 10.8,
          urineProtein: "trace",
          urineSugar: "nil",
          prescribedMeds: "Folic acid, Labetalol 100mg BD",
          notes: "Booking visit. H/o prior LSCS. BP monitoring advised.",
          nextVisitDate: addDays(lmp, 12 * 7),
        },
        {
          type: "HIGH_RISK_FOLLOWUP",
          visitDate: addDays(lmp, 16 * 7),
          weeksOfGestation: 16,
          weight: 70.1,
          bloodPressure: "140/90",
          fundalHeight: "16",
          fetalHeartRate: 152,
          hemoglobin: 10.5,
          urineProtein: "+",
          urineSugar: "nil",
          prescribedMeds: "Labetalol, Aspirin 75mg",
          notes: "BP elevated. Advised salt restriction.",
          nextVisitDate: addDays(lmp, 22 * 7),
        },
        {
          type: "SCAN_REVIEW",
          visitDate: addDays(lmp, 22 * 7),
          weeksOfGestation: 22,
          weight: 72,
          bloodPressure: "138/86",
          fundalHeight: "22",
          fetalHeartRate: 144,
          presentation: "Cephalic",
          hemoglobin: 10.4,
          urineProtein: "+",
          urineSugar: "nil",
          notes: "Anomaly scan normal. BP controlled.",
          nextVisitDate: addDays(lmp, 26 * 7),
        },
        {
          type: "HIGH_RISK_FOLLOWUP",
          visitDate: addDays(lmp, 28 * 7),
          weeksOfGestation: 28,
          weight: 74.5,
          bloodPressure: "142/92",
          fundalHeight: "28",
          fetalHeartRate: 146,
          presentation: "Cephalic",
          hemoglobin: 10.2,
          urineProtein: "+",
          urineSugar: "nil",
          prescribedMeds: "Labetalol, Aspirin, Iron",
          notes: "GTT ordered. Increased monitoring.",
        },
      );
    } else if (sc.seedIdx === 3 && sc.delivered) {
      const deliveredAt = addDays(edd, -sc.delivered.preEddDays);
      visitsForCase.push(
        {
          type: "FIRST_VISIT",
          visitDate: addDays(lmp, 8 * 7),
          weeksOfGestation: 8,
          weight: 60,
          bloodPressure: "118/76",
          hemoglobin: 11.6,
          notes: "Booking visit for 2nd pregnancy.",
        },
        {
          type: "ROUTINE",
          visitDate: addDays(lmp, 20 * 7),
          weeksOfGestation: 20,
          weight: 63,
          bloodPressure: "120/78",
          fundalHeight: "20",
          fetalHeartRate: 148,
          hemoglobin: 11.2,
          notes: "Progressing well.",
        },
        {
          type: "ROUTINE",
          visitDate: addDays(lmp, 36 * 7),
          weeksOfGestation: 36,
          weight: 72,
          bloodPressure: "122/80",
          fundalHeight: "36",
          fetalHeartRate: 142,
          presentation: "Cephalic",
          hemoglobin: 11.0,
          notes: "Term approaching.",
        },
        {
          type: "DELIVERY",
          visitDate: deliveredAt,
          weeksOfGestation: 38,
          weight: 73,
          bloodPressure: "118/78",
          notes: "Normal vaginal delivery. Live female baby 3.1 kg.",
        },
        {
          type: "POSTNATAL",
          visitDate: addDays(deliveredAt, 7),
          notes: "Mother and baby doing well. Breastfeeding established.",
        },
      );
    }

    // Skip-or-create each visit anchored on (ancCaseId, type, visitDate).
    let visitsCreated = 0;
    for (const v of visitsForCase) {
      const existing = await prisma.ancVisit.findFirst({
        where: {
          ancCaseId: c.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          type: v.type as any,
          visitDate: v.visitDate,
        },
      });
      if (existing) continue;
      await prisma.ancVisit.create({
        data: {
          ancCaseId: c.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(v as any),
        },
      });
      visitsCreated++;
    }
    if (visitsCreated > 0) {
      console.log(`    + ${visitsCreated} visits for ${caseNumber}`);
    }
  }

  // ─── Growth Records for a young patient ───────────────
  console.log("\nSeeding growth records...");
  const pediatricPatient = await prisma.patient.findFirst({
    where: {
      OR: [
        { dateOfBirth: { gte: addDays(now, -2 * 365), lte: now } },
        { age: { lte: 2 } },
      ],
    },
    include: { user: true },
  });

  if (!pediatricPatient) {
    console.log("  No pediatric patient (< 2y) found — skipping growth seed.");
  } else {
    // Recorder
    const anyStaff =
      (await prisma.user.findFirst({ where: { role: "DOCTOR" } })) ||
      (await prisma.user.findFirst({ where: { role: "NURSE" } }));
    const recordedBy = anyStaff?.id || doctor.userId;

    // Pre-2026-05-11 this block did:
    //   `await prisma.growthRecord.deleteMany({ where: { patientId: ... } })`
    // — which would WIPE any clinician-entered growth records for this
    // patient on every deploy. Replaced with per-row skip-or-create
    // anchored on (patientId, ageMonths). The 5 milestone ages below are
    // hard-coded so re-runs always hit the same logical row.
    const measurements = [
      { ageMonths: 0, weightKg: 3.2, heightCm: 49, headCircumference: 34 },
      { ageMonths: 2, weightKg: 5.4, heightCm: 57, headCircumference: 38, milestoneNotes: "Smiling, cooing" },
      { ageMonths: 4, weightKg: 6.8, heightCm: 62, headCircumference: 40, milestoneNotes: "Good head control" },
      { ageMonths: 6, weightKg: 7.6, heightCm: 66, headCircumference: 42.5, milestoneNotes: "Sitting with support" },
      { ageMonths: 12, weightKg: 9.5, heightCm: 74, headCircumference: 45, milestoneNotes: "Walking, first words", developmentalNotes: "Meeting all expected milestones." },
    ];

    let growthCreated = 0;
    for (const m of measurements) {
      const exists = await prisma.growthRecord.findFirst({
        where: {
          patientId: pediatricPatient.id,
          ageMonths: m.ageMonths,
        },
      });
      if (exists) continue;

      const hMeters = m.heightCm / 100;
      const bmi = Math.round((m.weightKg / (hMeters * hMeters)) * 10) / 10;
      const medians: Record<number, { w: number; h: number }> = {
        0: { w: 3.3, h: 49.9 },
        2: { w: 5.6, h: 58.4 },
        4: { w: 7.0, h: 63.9 },
        6: { w: 7.9, h: 67.6 },
        12: { w: 9.6, h: 75.7 },
      };
      const med = medians[m.ageMonths];
      const wp = med
        ? Math.max(1, Math.min(99, Math.round((m.weightKg / med.w) * 50)))
        : null;
      const hp = med
        ? Math.max(1, Math.min(99, Math.round((m.heightCm / med.h) * 50)))
        : null;

      await prisma.growthRecord.create({
        data: {
          patientId: pediatricPatient.id,
          ageMonths: m.ageMonths,
          weightKg: m.weightKg,
          heightCm: m.heightCm,
          headCircumference: m.headCircumference,
          bmi,
          weightPercentile: wp,
          heightPercentile: hp,
          milestoneNotes: m.milestoneNotes,
          developmentalNotes: m.developmentalNotes,
          recordedBy,
        },
      });
      growthCreated++;
    }
    if (growthCreated > 0) {
      console.log(
        `  Seeded ${growthCreated} new growth record(s) for ${pediatricPatient.user.name} (skipped any already present)`,
      );
    } else {
      console.log(`  All milestone growth records already present for ${pediatricPatient.user.name}.`);
    }
  }

  console.log("\n=== Phase 4 Specialty seed complete ===");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
