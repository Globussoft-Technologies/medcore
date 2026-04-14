import { PrismaClient, LabTestStatus, LabResultFlag, Role } from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 1) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

type SpecialtyTestSpec = {
  code: string;
  name: string;
  category: string;
  price: number;
  sampleType: string;
  unit: string;
  normalRange: string;
  panicLow?: number;
  panicHigh?: number;
  tatHours: number;
  description: string;
  ranges: Array<{
    parameter?: string;
    gender?: "MALE" | "FEMALE";
    ageMin?: number;
    ageMax?: number;
    low?: number;
    high?: number;
    unit?: string;
    notes?: string;
  }>;
};

const SPECIALTY_TESTS: SpecialtyTestSpec[] = [
  {
    code: "VITD",
    name: "Vitamin D (25-OH)",
    category: "Biochemistry",
    price: 1200,
    sampleType: "Blood",
    unit: "ng/mL",
    normalRange: "30-100",
    panicLow: 10,
    panicHigh: 150,
    tatHours: 48,
    description: "25-Hydroxy Vitamin D — assesses vitamin D status.",
    ranges: [{ low: 30, high: 100, unit: "ng/mL", notes: "Deficiency < 20, Insufficiency 20-30" }],
  },
  {
    code: "VITB12",
    name: "Vitamin B12",
    category: "Biochemistry",
    price: 900,
    sampleType: "Blood",
    unit: "pg/mL",
    normalRange: "200-900",
    panicLow: 100,
    panicHigh: 2000,
    tatHours: 24,
    description: "Serum cobalamin level — screens for deficiency.",
    ranges: [{ low: 200, high: 900, unit: "pg/mL" }],
  },
  {
    code: "IRONST",
    name: "Iron Studies",
    category: "Biochemistry",
    price: 1800,
    sampleType: "Blood",
    unit: "multi",
    normalRange: "See parameters",
    tatHours: 24,
    description: "Comprehensive iron panel: Serum Iron, TIBC, Ferritin, Transferrin Saturation.",
    ranges: [
      { parameter: "Serum Iron", gender: "MALE", low: 65, high: 175, unit: "μg/dL" },
      { parameter: "Serum Iron", gender: "FEMALE", low: 50, high: 170, unit: "μg/dL" },
      { parameter: "TIBC", low: 240, high: 450, unit: "μg/dL" },
      { parameter: "Ferritin", gender: "MALE", low: 30, high: 400, unit: "ng/mL" },
      { parameter: "Ferritin", gender: "FEMALE", low: 13, high: 150, unit: "ng/mL" },
      { parameter: "Transferrin Saturation", low: 20, high: 50, unit: "%" },
    ],
  },
  {
    code: "CARDENZ",
    name: "Cardiac Enzymes",
    category: "Biochemistry",
    price: 2500,
    sampleType: "Blood",
    unit: "multi",
    normalRange: "See parameters",
    tatHours: 4,
    description: "Troponin I, CK-MB, Myoglobin — acute MI evaluation.",
    ranges: [
      { parameter: "Troponin I", low: 0, high: 0.04, unit: "ng/mL", notes: ">0.4 suggestive of MI" },
      { parameter: "CK-MB", low: 0, high: 6.3, unit: "ng/mL" },
      { parameter: "Myoglobin", low: 10, high: 92, unit: "ng/mL" },
    ],
  },
  {
    code: "DDIMER",
    name: "D-Dimer",
    category: "Coagulation",
    price: 1400,
    sampleType: "Blood",
    unit: "ng/mL",
    normalRange: "<500",
    panicHigh: 5000,
    tatHours: 6,
    description: "Fibrin degradation marker — VTE/DIC screening.",
    ranges: [{ low: 0, high: 500, unit: "ng/mL", notes: "Age-adjusted cutoff may apply >50y" }],
  },
  {
    code: "PROCAL",
    name: "Procalcitonin",
    category: "Immunology",
    price: 2200,
    sampleType: "Blood",
    unit: "ng/mL",
    normalRange: "<0.5",
    panicHigh: 10,
    tatHours: 8,
    description: "Bacterial sepsis marker.",
    ranges: [{ low: 0, high: 0.5, unit: "ng/mL", notes: ">2.0 suggests sepsis" }],
  },
  {
    code: "ANA",
    name: "ANA (Anti-Nuclear Antibody)",
    category: "Immunology",
    price: 1600,
    sampleType: "Blood",
    unit: "titer",
    normalRange: "Negative",
    tatHours: 48,
    description: "Screening for autoimmune connective tissue disease.",
    ranges: [{ notes: "Positive titer >1:80 is significant" }],
  },
  {
    code: "RF",
    name: "Rheumatoid Factor",
    category: "Immunology",
    price: 600,
    sampleType: "Blood",
    unit: "IU/mL",
    normalRange: "<14",
    tatHours: 24,
    description: "Assists in RA diagnosis; not specific alone.",
    ranges: [{ low: 0, high: 14, unit: "IU/mL" }],
  },
  {
    code: "PSA",
    name: "Prostate Specific Antigen (PSA)",
    category: "Biochemistry",
    price: 950,
    sampleType: "Blood",
    unit: "ng/mL",
    normalRange: "<4.0 (age-dependent)",
    panicHigh: 20,
    tatHours: 24,
    description: "Prostate health screening (male patients).",
    ranges: [
      { gender: "MALE", ageMin: 40, ageMax: 49, low: 0, high: 2.5, unit: "ng/mL" },
      { gender: "MALE", ageMin: 50, ageMax: 59, low: 0, high: 3.5, unit: "ng/mL" },
      { gender: "MALE", ageMin: 60, ageMax: 69, low: 0, high: 4.5, unit: "ng/mL" },
      { gender: "MALE", ageMin: 70, ageMax: 120, low: 0, high: 6.5, unit: "ng/mL" },
    ],
  },
  {
    code: "BHCG",
    name: "Beta-HCG (Quantitative)",
    category: "Endocrinology",
    price: 1100,
    sampleType: "Blood",
    unit: "mIU/mL",
    normalRange: "<5 (non-pregnant)",
    tatHours: 6,
    description: "Pregnancy test (quantitative) & trophoblastic disease monitoring.",
    ranges: [
      { gender: "FEMALE", low: 0, high: 5, unit: "mIU/mL", notes: "Non-pregnant reference" },
    ],
  },
];

async function main() {
  console.log("\n=== Seeding Specialty Lab Panels ===\n");

  // ─── Create/Upsert LabTest records ────────────────────
  let testsCreated = 0;
  let rangesCreated = 0;
  const testIdByCode: Record<string, string> = {};

  for (const t of SPECIALTY_TESTS) {
    const existing = await prisma.labTest.findUnique({ where: { code: t.code } });
    if (existing) {
      testIdByCode[t.code] = existing.id;
      continue;
    }

    const test = await prisma.labTest.create({
      data: {
        code: t.code,
        name: t.name,
        category: t.category,
        price: t.price,
        sampleType: t.sampleType,
        unit: t.unit === "multi" ? null : t.unit,
        normalRange: t.normalRange,
        panicLow: t.panicLow,
        panicHigh: t.panicHigh,
        tatHours: t.tatHours,
        description: t.description,
      },
    });
    testIdByCode[t.code] = test.id;
    testsCreated++;

    for (const r of t.ranges) {
      await prisma.labTestReferenceRange.create({
        data: {
          testId: test.id,
          parameter: r.parameter,
          gender: r.gender,
          ageMin: r.ageMin,
          ageMax: r.ageMax,
          low: r.low,
          high: r.high,
          unit: r.unit,
          notes: r.notes,
        },
      });
      rangesCreated++;
    }
  }

  // ─── Create 20 lab orders referencing these tests ─────
  const doctors = await prisma.doctor.findMany({ take: 10 });
  const patients = await prisma.patient.findMany({ take: 30, include: { user: true } });
  const labStaff = await prisma.user.findFirst({
    where: { role: { in: [Role.NURSE, Role.DOCTOR, Role.ADMIN] } },
  });

  let ordersCreated = 0;
  let resultsCreated = 0;

  if (doctors.length === 0 || patients.length === 0 || !labStaff) {
    console.warn("  Missing doctors/patients/staff — skipping order creation");
  } else {
    const existingOrders = await prisma.labOrder.count();
    const orderSeqStart = existingOrders + 5000;

    for (let i = 0; i < 20; i++) {
      const test = randomItem(SPECIALTY_TESTS);
      const testId = testIdByCode[test.code];
      if (!testId) continue;

      const patient = randomItem(patients);
      const doctor = randomItem(doctors);
      const daysOld = randomInt(1, 30);
      const orderedAt = daysAgo(daysOld);

      // Most orders completed; some in-progress; one rejected
      let status: LabTestStatus;
      const r = Math.random();
      if (r < 0.7) status = LabTestStatus.COMPLETED;
      else if (r < 0.85) status = LabTestStatus.IN_PROGRESS;
      else if (r < 0.95) status = LabTestStatus.SAMPLE_COLLECTED;
      else status = LabTestStatus.SAMPLE_REJECTED;

      // All statuses used here imply sample collection occurred
      const collectedAt = new Date(orderedAt.getTime() + randomInt(1, 8) * 3600_000);
      const completedAt =
        status === LabTestStatus.COMPLETED
          ? new Date(collectedAt.getTime() + test.tatHours * 3600_000)
          : null;

      const orderNumber = `LAB-${new Date().getFullYear()}-${String(orderSeqStart + i).padStart(6, "0")}`;
      const order = await prisma.labOrder.create({
        data: {
          orderNumber,
          patientId: patient.id,
          doctorId: doctor.id,
          status,
          orderedAt,
          collectedAt,
          completedAt: completedAt ?? undefined,
          rejectedAt: status === LabTestStatus.SAMPLE_REJECTED ? collectedAt : undefined,
          rejectionReason:
            status === LabTestStatus.SAMPLE_REJECTED ? randomItem(["HEMOLYZED", "CLOTTED", "INSUFFICIENT_SAMPLE"]) : undefined,
          notes: `Ordered as ${test.name} outpatient workup`,
          items: {
            create: [{ testId, status }],
          },
        },
        include: { items: true },
      });
      ordersCreated++;

      // Generate results for COMPLETED
      if (status === LabTestStatus.COMPLETED) {
        const item = order.items[0];
        for (const range of test.ranges) {
          const low = range.low ?? 0;
          const high = range.high ?? 100;
          // 70% normal, 20% high/low, 10% critical
          const rv = Math.random();
          let value: number;
          let flag: LabResultFlag;
          if (rv < 0.7) {
            value = randomFloat(low, high, 2);
            flag = LabResultFlag.NORMAL;
          } else if (rv < 0.85) {
            value = randomFloat(0, Math.max(0.01, low * 0.8), 2);
            flag = LabResultFlag.LOW;
          } else if (rv < 0.95) {
            value = randomFloat(high * 1.1, high * 2, 2);
            flag = LabResultFlag.HIGH;
          } else {
            value = test.panicHigh ?? high * 3;
            flag = LabResultFlag.CRITICAL;
          }

          await prisma.labResult.create({
            data: {
              orderItemId: item.id,
              parameter: range.parameter ?? test.name,
              value: String(value),
              unit: range.unit ?? test.unit,
              normalRange: range.low !== undefined ? `${range.low}-${range.high}` : test.normalRange,
              flag,
              notes: flag === "CRITICAL" ? "Critical value — clinician notified" : null,
              enteredBy: labStaff.id,
              reportedAt: completedAt ?? new Date(),
            },
          });
          resultsCreated++;
        }
      }
    }
  }

  console.log(`\n✔ Specialty tests created: ${testsCreated}`);
  console.log(`✔ Reference ranges:        ${rangesCreated}`);
  console.log(`✔ Lab orders created:      ${ordersCreated}`);
  console.log(`✔ Lab results created:     ${resultsCreated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
