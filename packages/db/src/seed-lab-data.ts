/**
 * Realistic lab orders + results seed.
 *
 * Idempotency contract (2026-05-10): this script is safe to re-run on a
 * populated demo without creating duplicate LabOrder / LabResult rows.
 *
 *   - All randomness is driven by a deterministic mulberry32 PRNG seeded
 *     from a fixed constant. Re-runs produce byte-identical decisions.
 *   - LabOrder.orderNumber is `@unique`. We mint stable
 *     `LAB-SEED-NNNNNN` numbers from a per-scenario index so re-runs
 *     hit the existing rows. The pre-idempotency code computed the
 *     next sequence from `existingOrders.length`, which made every re-run
 *     mint a fresh batch on top of the prior one.
 *   - LabResult has no @unique we can upsert on. Per-orderItem we count
 *     existing results — if any exist for that orderItemId we skip the
 *     whole result-generation block (the parameter set is fixed by the
 *     test panel, so 0 vs N is the only meaningful state).
 *   - LabQCEntry block was already idempotent pre-2026-05-10 (findFirst
 *     skip on per-day window). Left alone.
 *
 * Wired into `scripts/deploy.sh` step 8m. Failures are non-fatal.
 */
import { PrismaClient, LabTestStatus, LabResultFlag } from "@prisma/client";

const prisma = new PrismaClient();

// ─── DETERMINISTIC RNG ──────────────────────────────────
const SEED = 0x1ab5eed0 >>> 0;
let _rngState = SEED;
function rng(): number {
  _rngState |= 0;
  _rngState = (_rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function resetRng(): void { _rngState = SEED; }

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function rand(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals = 1): number {
  return parseFloat((rng() * (max - min) + min).toFixed(decimals));
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function hoursAgo(n: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d;
}

type Panel = Array<{
  parameter: string;
  unit: string;
  normalRange: string;
  normalMin: number;
  normalMax: number;
  criticalLow?: number;
  criticalHigh?: number;
  decimals?: number;
}>;

const PANELS: Record<string, Panel> = {
  CBC: [
    { parameter: "Hemoglobin", unit: "g/dL", normalRange: "12.0-16.0", normalMin: 12, normalMax: 16, criticalLow: 7, criticalHigh: 20, decimals: 1 },
    { parameter: "RBC Count", unit: "million/uL", normalRange: "4.5-5.5", normalMin: 4.5, normalMax: 5.5, decimals: 2 },
    { parameter: "WBC Count", unit: "cells/uL", normalRange: "4000-11000", normalMin: 4000, normalMax: 11000, criticalLow: 2000, criticalHigh: 30000 },
    { parameter: "Platelet Count", unit: "lakhs/cumm", normalRange: "1.5-4.5", normalMin: 1.5, normalMax: 4.5, criticalLow: 0.5, criticalHigh: 10, decimals: 2 },
    { parameter: "Hematocrit", unit: "%", normalRange: "36-46", normalMin: 36, normalMax: 46, decimals: 1 },
  ],
  "Lipid Profile": [
    { parameter: "Total Cholesterol", unit: "mg/dL", normalRange: "<200", normalMin: 120, normalMax: 200, criticalHigh: 400 },
    { parameter: "HDL Cholesterol", unit: "mg/dL", normalRange: ">40", normalMin: 40, normalMax: 80 },
    { parameter: "LDL Cholesterol", unit: "mg/dL", normalRange: "<100", normalMin: 60, normalMax: 100, criticalHigh: 250 },
    { parameter: "Triglycerides", unit: "mg/dL", normalRange: "<150", normalMin: 50, normalMax: 150, criticalHigh: 500 },
    { parameter: "VLDL", unit: "mg/dL", normalRange: "<30", normalMin: 10, normalMax: 30 },
  ],
  "Thyroid Profile": [
    { parameter: "T3", unit: "ng/dL", normalRange: "80-200", normalMin: 80, normalMax: 200, decimals: 1 },
    { parameter: "T4", unit: "ug/dL", normalRange: "5.0-12.0", normalMin: 5, normalMax: 12, decimals: 1 },
    { parameter: "TSH", unit: "uIU/mL", normalRange: "0.4-4.0", normalMin: 0.4, normalMax: 4, criticalHigh: 50, decimals: 2 },
  ],
  LFT: [
    { parameter: "Total Bilirubin", unit: "mg/dL", normalRange: "0.2-1.2", normalMin: 0.2, normalMax: 1.2, criticalHigh: 10, decimals: 2 },
    { parameter: "Direct Bilirubin", unit: "mg/dL", normalRange: "0-0.3", normalMin: 0, normalMax: 0.3, decimals: 2 },
    { parameter: "SGOT (AST)", unit: "U/L", normalRange: "<40", normalMin: 10, normalMax: 40, criticalHigh: 500 },
    { parameter: "SGPT (ALT)", unit: "U/L", normalRange: "<40", normalMin: 10, normalMax: 40, criticalHigh: 500 },
    { parameter: "Alkaline Phosphatase", unit: "U/L", normalRange: "40-125", normalMin: 40, normalMax: 125 },
    { parameter: "Total Protein", unit: "g/dL", normalRange: "6.0-8.0", normalMin: 6, normalMax: 8, decimals: 1 },
    { parameter: "Albumin", unit: "g/dL", normalRange: "3.5-5.0", normalMin: 3.5, normalMax: 5, decimals: 1 },
  ],
  KFT: [
    { parameter: "Urea", unit: "mg/dL", normalRange: "15-40", normalMin: 15, normalMax: 40, criticalHigh: 200 },
    { parameter: "Creatinine", unit: "mg/dL", normalRange: "0.6-1.2", normalMin: 0.6, normalMax: 1.2, criticalHigh: 10, decimals: 2 },
    { parameter: "Uric Acid", unit: "mg/dL", normalRange: "3.5-7.2", normalMin: 3.5, normalMax: 7.2, decimals: 1 },
    { parameter: "Sodium", unit: "mEq/L", normalRange: "135-145", normalMin: 135, normalMax: 145, criticalLow: 120, criticalHigh: 160 },
    { parameter: "Potassium", unit: "mEq/L", normalRange: "3.5-5.0", normalMin: 3.5, normalMax: 5, criticalLow: 2.5, criticalHigh: 6.5, decimals: 1 },
    { parameter: "Chloride", unit: "mEq/L", normalRange: "98-107", normalMin: 98, normalMax: 107 },
  ],
  "Blood Sugar Fasting": [
    { parameter: "FBS", unit: "mg/dL", normalRange: "70-110", normalMin: 70, normalMax: 110, criticalLow: 40, criticalHigh: 500 },
  ],
  HbA1c: [
    { parameter: "HbA1c", unit: "%", normalRange: "<5.7 (Normal); 5.7-6.4 (Pre-DM); >=6.5 (DM)", normalMin: 4.5, normalMax: 5.7, criticalHigh: 14, decimals: 1 },
  ],
  "Urine Routine": [
    { parameter: "Color", unit: "", normalRange: "Pale yellow", normalMin: 0, normalMax: 0 },
    { parameter: "Specific Gravity", unit: "", normalRange: "1.005-1.030", normalMin: 1.005, normalMax: 1.030, decimals: 3 },
    { parameter: "pH", unit: "", normalRange: "4.5-8.0", normalMin: 4.5, normalMax: 8, decimals: 1 },
    { parameter: "Protein", unit: "", normalRange: "Negative", normalMin: 0, normalMax: 0 },
    { parameter: "Sugar", unit: "", normalRange: "Negative", normalMin: 0, normalMax: 0 },
    { parameter: "Pus Cells", unit: "/HPF", normalRange: "0-5", normalMin: 0, normalMax: 5 },
  ],
  ECG: [
    { parameter: "Rhythm", unit: "", normalRange: "Sinus rhythm", normalMin: 0, normalMax: 0 },
    { parameter: "Heart Rate", unit: "bpm", normalRange: "60-100", normalMin: 60, normalMax: 100, criticalLow: 40, criticalHigh: 150 },
    { parameter: "QT Interval", unit: "ms", normalRange: "350-440", normalMin: 350, normalMax: 440 },
  ],
  "X-Ray Chest PA": [
    { parameter: "Finding", unit: "", normalRange: "Normal lung fields", normalMin: 0, normalMax: 0 },
  ],
};

const TEXT_RESULTS: Record<string, { normal: string[]; abnormal: string[] }> = {
  Color: {
    normal: ["Pale yellow", "Yellow", "Straw"],
    abnormal: ["Dark yellow", "Amber", "Cloudy"],
  },
  Protein: {
    normal: ["Negative"],
    abnormal: ["Trace", "+", "++", "+++"],
  },
  Sugar: {
    normal: ["Negative"],
    abnormal: ["Trace", "+", "++"],
  },
  Rhythm: {
    normal: ["Sinus rhythm", "Normal sinus rhythm"],
    abnormal: ["Sinus tachycardia", "Sinus bradycardia", "Atrial fibrillation"],
  },
  Finding: {
    normal: [
      "Normal lung fields. Cardiac silhouette normal.",
      "Clear lung fields. No active pulmonary pathology.",
      "Heart size normal. No pleural effusion.",
    ],
    abnormal: [
      "Right lower lobe consolidation suggestive of pneumonia.",
      "Cardiomegaly noted. Pulmonary congestion present.",
      "Mild left-sided pleural effusion.",
      "Bilateral reticular opacities.",
    ],
  },
};

function generateValue(param: { parameter: string; normalMin: number; normalMax: number; criticalLow?: number; criticalHigh?: number; decimals?: number }, outcome: "normal" | "abnormal" | "critical") {
  if (TEXT_RESULTS[param.parameter]) {
    if (outcome === "normal") return { value: pick(TEXT_RESULTS[param.parameter].normal), flag: LabResultFlag.NORMAL };
    return { value: pick(TEXT_RESULTS[param.parameter].abnormal), flag: LabResultFlag.HIGH };
  }

  const { normalMin, normalMax, criticalLow, criticalHigh, decimals = 0 } = param;
  let value: number;
  let flag: LabResultFlag;

  if (outcome === "critical") {
    if (criticalLow !== undefined && rng() < 0.5) {
      value = randFloat(criticalLow * 0.5, criticalLow, decimals);
      flag = LabResultFlag.CRITICAL;
    } else if (criticalHigh !== undefined) {
      value = randFloat(criticalHigh, criticalHigh * 1.5, decimals);
      flag = LabResultFlag.CRITICAL;
    } else {
      value = randFloat(normalMax * 2, normalMax * 3, decimals);
      flag = LabResultFlag.HIGH;
    }
  } else if (outcome === "abnormal") {
    if (rng() < 0.5) {
      const low = criticalLow ?? normalMin * 0.5;
      value = randFloat(low, normalMin * 0.95, decimals);
      flag = LabResultFlag.LOW;
    } else {
      const high = criticalHigh ?? normalMax * 1.8;
      value = randFloat(normalMax * 1.05, high * 0.9, decimals);
      flag = LabResultFlag.HIGH;
    }
  } else {
    value = randFloat(normalMin, normalMax, decimals);
    flag = LabResultFlag.NORMAL;
  }

  return {
    value: decimals > 0 ? value.toFixed(decimals) : String(Math.round(value)),
    flag,
  };
}

async function main() {
  console.log("=== Seeding lab orders + results (idempotent) ===\n");
  resetRng();

  const tests = await prisma.labTest.findMany({ orderBy: { id: "asc" } });
  if (tests.length === 0) {
    console.log("No lab tests found. Run seed-pharmacy.ts first.");
    return;
  }
  console.log(`Found ${tests.length} lab tests`);

  const patients = await prisma.patient.findMany({ take: 30, orderBy: { id: "asc" } });
  const doctors = await prisma.doctor.findMany({ take: 5, orderBy: { id: "asc" } });
  const staffUsers = await prisma.user.findMany({
    where: { role: { in: ["NURSE", "DOCTOR", "ADMIN"] } },
    take: 5,
    orderBy: { id: "asc" },
  });

  if (!patients.length || !doctors.length) {
    console.log("Need patients and doctors seeded first.");
    return;
  }
  console.log(`Using ${patients.length} patients, ${doctors.length} doctors`);

  const scenarios = [
    ...Array.from({ length: 40 }, () => ({
      daysOld: rand(0, 14),
      status: LabTestStatus.COMPLETED,
      testCount: rand(1, 4),
    })),
    ...Array.from({ length: 8 }, () => ({
      daysOld: rand(0, 1),
      status: LabTestStatus.IN_PROGRESS,
      testCount: rand(1, 3),
    })),
    ...Array.from({ length: 5 }, () => ({
      daysOld: 0,
      status: LabTestStatus.SAMPLE_COLLECTED,
      testCount: rand(1, 2),
    })),
    ...Array.from({ length: 6 }, () => ({
      daysOld: 0,
      status: LabTestStatus.ORDERED,
      testCount: rand(1, 3),
    })),
    ...Array.from({ length: 2 }, () => ({
      daysOld: rand(2, 14),
      status: LabTestStatus.CANCELLED,
      testCount: rand(1, 2),
    })),
  ];

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalResults = 0;
  let totalCritical = 0;

  for (let scenarioIdx = 0; scenarioIdx < scenarios.length; scenarioIdx++) {
    const scenario = scenarios[scenarioIdx];
    const patient = pick(patients);
    const doctor = pick(doctors);
    const selectedTests = Array.from({ length: scenario.testCount }).map(() => pick(tests));
    const uniqueTests = Array.from(new Map(selectedTests.map(t => [t.id, t])).values());

    // Stable seed-namespaced order number — replaces non-idempotent
    // existingOrders+1 counter which compounded each re-run.
    const orderNumber = `LAB-SEED-${String(scenarioIdx + 1).padStart(6, "0")}`;
    const orderedAt = scenario.daysOld > 0 ? daysAgo(scenario.daysOld) : hoursAgo(rand(0, 23));

    const COLLECTED_STATUSES = [
      LabTestStatus.SAMPLE_COLLECTED,
      LabTestStatus.IN_PROGRESS,
      LabTestStatus.COMPLETED,
    ] as const;
    type CollectedStatus = (typeof COLLECTED_STATUSES)[number];
    const isCollectedStatus = (s: LabTestStatus): s is CollectedStatus =>
      (COLLECTED_STATUSES as readonly LabTestStatus[]).includes(s);

    const collectedAt = isCollectedStatus(scenario.status)
      ? new Date(orderedAt.getTime() + rand(15, 120) * 60 * 1000)
      : null;

    const completedAt =
      scenario.status === LabTestStatus.COMPLETED
        ? new Date((collectedAt ?? orderedAt).getTime() + rand(60, 360) * 60 * 1000)
        : null;

    const existingOrder = await prisma.labOrder.findUnique({
      where: { orderNumber },
      include: { items: true },
    });

    let order;
    if (existingOrder) {
      order = existingOrder;
      totalSkipped++;
    } else {
      order = await prisma.labOrder.create({
        data: {
          orderNumber,
          patientId: patient.id,
          doctorId: doctor.id,
          status: scenario.status,
          notes: pick([
            null,
            "Routine checkup",
            "Follow-up on previous abnormal result",
            "Pre-operative assessment",
            "Suspected infection",
            "Annual health screening",
            "Diabetic follow-up",
          ]),
          orderedAt,
          collectedAt,
          completedAt,
          items: {
            create: uniqueTests.map((t) => ({
              testId: t.id,
              status: scenario.status,
            })),
          },
        },
        include: { items: true },
      });
      totalCreated++;
    }

    if (scenario.status === LabTestStatus.COMPLETED) {
      for (let idx = 0; idx < order.items.length; idx++) {
        const item = order.items[idx];
        const test = uniqueTests[idx] ?? tests.find(t => t.id === item.testId);
        if (!test) continue;

        const existingResultCount = await prisma.labResult.count({
          where: { orderItemId: item.id },
        });
        if (existingResultCount > 0) continue;

        const panel = PANELS[test.name] ?? [
          {
            parameter: test.name,
            unit: "",
            normalRange: test.normalRange ?? "Normal",
            normalMin: 0,
            normalMax: 100,
          },
        ];

        const r = rng();
        const outcome: "normal" | "abnormal" | "critical" =
          r < 0.7 ? "normal" : r < 0.95 ? "abnormal" : "critical";

        for (const param of panel) {
          const { value, flag } = generateValue(param, outcome);

          await prisma.labResult.create({
            data: {
              orderItemId: item.id,
              parameter: param.parameter,
              value: String(value),
              unit: param.unit,
              normalRange: param.normalRange,
              flag,
              enteredBy: pick(staffUsers).id,
              reportedAt: completedAt ?? new Date(),
              notes: flag === LabResultFlag.CRITICAL ? "Critical value — Doctor informed" : null,
            },
          });
          totalResults++;
          if (flag === LabResultFlag.CRITICAL) totalCritical++;
        }
      }
    }
  }

  console.log(`\n  Created ${totalCreated} new lab orders`);
  console.log(`  Skipped ${totalSkipped} pre-existing seeded orders`);
  console.log(`  Generated ${totalResults} new result entries`);
  console.log(`  Critical findings flagged: ${totalCritical}`);

  const statusCounts = await prisma.labOrder.groupBy({
    by: ["status"],
    _count: true,
  });
  console.log("\n  Orders by status:");
  for (const sc of statusCounts) {
    console.log(`    ${sc.status}: ${sc._count}`);
  }

  await seedLabQCEntries(staffUsers);

  console.log("\n=== Lab seed complete ===");
}

async function seedLabQCEntries(
  staffUsers: Array<{ id: string }>
): Promise<void> {
  console.log("\n  Seeding Lab QC entries (Levey-Jennings)...");

  const qcTargets: Array<{
    testName: string;
    instrument: string;
    qcLevel: "LOW" | "NORMAL" | "HIGH";
    mean: number;
    sd: number;
  }> = [
    { testName: "CBC", instrument: "Sysmex XN-1000", qcLevel: "NORMAL", mean: 13.5, sd: 0.4 },
    { testName: "CBC", instrument: "Sysmex XN-1000", qcLevel: "LOW", mean: 8.0, sd: 0.3 },
    { testName: "Lipid Profile", instrument: "Roche Cobas c311", qcLevel: "NORMAL", mean: 180, sd: 8 },
    { testName: "LFT", instrument: "Roche Cobas c311", qcLevel: "NORMAL", mean: 32, sd: 2.5 },
    { testName: "KFT", instrument: "Roche Cobas c311", qcLevel: "NORMAL", mean: 1.0, sd: 0.08 },
    { testName: "Thyroid Profile", instrument: "Beckman DXI-800", qcLevel: "NORMAL", mean: 2.5, sd: 0.2 },
    { testName: "Blood Sugar Fasting", instrument: "Roche Cobas c311", qcLevel: "NORMAL", mean: 95, sd: 4 },
    { testName: "HbA1c", instrument: "Bio-Rad D-10", qcLevel: "NORMAL", mean: 5.5, sd: 0.15 },
  ];

  function gaussian(mean: number, sd: number): number {
    const u1 = rng() || 1e-9;
    const u2 = rng() || 1e-9;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * sd;
  }

  const tests = await prisma.labTest.findMany();
  const testByName = new Map(tests.map((t) => [t.name, t]));

  if (staffUsers.length === 0) {
    console.log("  No staff users to record QC; skipping.");
    return;
  }

  let createdQC = 0;
  for (const target of qcTargets) {
    const test = testByName.get(target.testName);
    if (!test) continue;

    for (let dayBack = 9; dayBack >= 0; dayBack--) {
      const runDate = daysAgo(dayBack);

      const dayStart = new Date(runDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(runDate);
      dayEnd.setHours(23, 59, 59, 999);
      const exists = await prisma.labQCEntry.findFirst({
        where: {
          testId: test.id,
          instrument: target.instrument,
          qcLevel: target.qcLevel,
          runDate: { gte: dayStart, lte: dayEnd },
        },
        select: { id: true },
      });
      if (exists) continue;

      const recorded = gaussian(target.mean, target.sd);
      const z = (recorded - target.mean) / target.sd;
      const withinRange = Math.abs(z) <= 2;
      const cv = (target.sd / target.mean) * 100;

      await prisma.labQCEntry.create({
        data: {
          testId: test.id,
          qcLevel: target.qcLevel,
          instrument: target.instrument,
          runDate,
          meanValue: target.mean,
          recordedValue: parseFloat(recorded.toFixed(3)),
          cv: parseFloat(cv.toFixed(2)),
          withinRange,
          performedBy: pick(staffUsers).id,
          notes: withinRange ? null : `Out of ±2SD (z=${z.toFixed(2)})`,
        },
      });
      createdQC++;
    }
  }

  console.log(`  Created ${createdQC} QC entries`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
