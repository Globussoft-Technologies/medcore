import { PrismaClient, LabTestStatus, LabResultFlag } from "@prisma/client";

const prisma = new PrismaClient();

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals = 1): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
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

/**
 * Reference lab result panels — each test has expected parameters with normal ranges.
 * Values generated with ~70% normal, ~25% abnormal (high/low), ~5% critical.
 */
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
    if (criticalLow !== undefined && Math.random() < 0.5) {
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
    if (Math.random() < 0.5) {
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
  console.log("=== Seeding lab orders + results ===\n");

  // Get all available tests
  const tests = await prisma.labTest.findMany();
  if (tests.length === 0) {
    console.log("No lab tests found. Run seed-pharmacy.ts first.");
    return;
  }
  console.log(`Found ${tests.length} lab tests`);

  const patients = await prisma.patient.findMany({ take: 30 });
  const doctors = await prisma.doctor.findMany({ take: 5 });
  const staffUsers = await prisma.user.findMany({ where: { role: { in: ["NURSE", "DOCTOR", "ADMIN"] } }, take: 5 });

  if (!patients.length || !doctors.length) {
    console.log("Need patients and doctors seeded first.");
    return;
  }
  console.log(`Using ${patients.length} patients, ${doctors.length} doctors`);

  // Get existing orders to pick next order number
  const existingOrders = await prisma.labOrder.findMany({ select: { orderNumber: true } });
  let nextSeq = 1;
  for (const o of existingOrders) {
    const m = o.orderNumber.match(/LAB(\d+)/);
    if (m) nextSeq = Math.max(nextSeq, parseInt(m[1]) + 1);
  }

  // Scenarios: generate a realistic mix of orders across time + statuses
  const scenarios = [
    // Past completed orders with results (14 days ago to today)
    ...Array.from({ length: 40 }, (_, i) => ({
      daysOld: rand(0, 14),
      status: LabTestStatus.COMPLETED,
      testCount: rand(1, 4),
    })),
    // In-progress orders (last 2 days)
    ...Array.from({ length: 8 }, () => ({
      daysOld: rand(0, 1),
      status: LabTestStatus.IN_PROGRESS,
      testCount: rand(1, 3),
    })),
    // Sample collected but not processed (today)
    ...Array.from({ length: 5 }, () => ({
      daysOld: 0,
      status: LabTestStatus.SAMPLE_COLLECTED,
      testCount: rand(1, 2),
    })),
    // Just ordered (last few hours)
    ...Array.from({ length: 6 }, () => ({
      daysOld: 0,
      status: LabTestStatus.ORDERED,
      testCount: rand(1, 3),
    })),
    // Cancelled
    ...Array.from({ length: 2 }, () => ({
      daysOld: rand(2, 14),
      status: LabTestStatus.CANCELLED,
      testCount: rand(1, 2),
    })),
  ];

  let totalCreated = 0;
  let totalResults = 0;
  let totalCritical = 0;

  for (const scenario of scenarios) {
    const patient = pick(patients);
    const doctor = pick(doctors);
    const selectedTests = Array.from({ length: scenario.testCount }).map(() => pick(tests));
    const uniqueTests = Array.from(new Map(selectedTests.map(t => [t.id, t])).values());

    const orderNumber = `LAB${String(nextSeq++).padStart(6, "0")}`;
    const orderedAt = scenario.daysOld > 0 ? daysAgo(scenario.daysOld) : hoursAgo(rand(0, 23));

    const collectedAt =
      [LabTestStatus.SAMPLE_COLLECTED, LabTestStatus.IN_PROGRESS, LabTestStatus.COMPLETED].includes(scenario.status)
        ? new Date(orderedAt.getTime() + rand(15, 120) * 60 * 1000)
        : null;

    const completedAt =
      scenario.status === LabTestStatus.COMPLETED
        ? new Date((collectedAt ?? orderedAt).getTime() + rand(60, 360) * 60 * 1000)
        : null;

    const order = await prisma.labOrder.create({
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

    // Generate results for COMPLETED orders
    if (scenario.status === LabTestStatus.COMPLETED) {
      for (let idx = 0; idx < order.items.length; idx++) {
        const item = order.items[idx];
        const test = uniqueTests[idx];

        // Find panel by name match, else default to a single generic parameter
        const panel = PANELS[test.name] ?? [
          {
            parameter: test.name,
            unit: "",
            normalRange: test.normalRange ?? "Normal",
            normalMin: 0,
            normalMax: 100,
          },
        ];

        // ~70% normal, 25% abnormal, 5% critical
        const r = Math.random();
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

  console.log(`\n  Created ${totalCreated} lab orders`);
  console.log(`  Generated ${totalResults} result entries`);
  console.log(`  Critical findings flagged: ${totalCritical}`);

  // Summary by status
  const statusCounts = await prisma.labOrder.groupBy({
    by: ["status"],
    _count: true,
  });
  console.log("\n  Orders by status:");
  for (const sc of statusCounts) {
    console.log(`    ${sc.status}: ${sc._count}`);
  }

  console.log("\n=== Lab seed complete ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
