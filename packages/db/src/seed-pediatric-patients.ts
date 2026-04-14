import { PrismaClient, Role, Gender } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function hash(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

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
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * 8 Pediatric patients spanning newborn → 10 years, each with varied growth records
 * and partial immunization history to power the Pediatric Growth module.
 */
const PEDIATRIC_PATIENTS = [
  {
    name: "Aarav Sharma",
    gender: "MALE" as Gender,
    ageDays: 3, // newborn
    bloodGroup: "A+",
    address: "B-404 Sai Residency, Powai, Mumbai 400076",
    parentName: "Ritesh Sharma (Father)",
    parentPhone: "9820011001",
  },
  {
    name: "Ishani Patel",
    gender: "FEMALE" as Gender,
    ageDays: 180, // 6 months
    bloodGroup: "O+",
    address: "Flat 12, Green Park Apts, Juhu, Mumbai 400049",
    parentName: "Neha Patel (Mother)",
    parentPhone: "9820011002",
  },
  {
    name: "Vihaan Kumar",
    gender: "MALE" as Gender,
    ageDays: 365, // 1 year
    bloodGroup: "B+",
    address: "23 Shanti Nagar, Vashi, Navi Mumbai 400703",
    parentName: "Anjali Kumar (Mother)",
    parentPhone: "9820011003",
  },
  {
    name: "Diya Iyer",
    gender: "FEMALE" as Gender,
    ageDays: 365 * 2 + 60, // 2y 2m
    bloodGroup: "A-",
    address: "C-9 Krishna Heights, Andheri East, Mumbai 400069",
    parentName: "Sridhar Iyer (Father)",
    parentPhone: "9820011004",
  },
  {
    name: "Kabir Singh",
    gender: "MALE" as Gender,
    ageDays: 365 * 3 + 120, // 3y 4m
    bloodGroup: "O-",
    address: "15 MG Road, Bandra West, Mumbai 400050",
    parentName: "Harpreet Singh (Father)",
    parentPhone: "9820011005",
  },
  {
    name: "Anaya Desai",
    gender: "FEMALE" as Gender,
    ageDays: 365 * 5 + 90, // 5y 3m
    bloodGroup: "AB+",
    address: "Flat 7A, Lotus Tower, Dadar East, Mumbai 400014",
    parentName: "Bhavna Desai (Mother)",
    parentPhone: "9820011006",
  },
  {
    name: "Reyansh Gupta",
    gender: "MALE" as Gender,
    ageDays: 365 * 7 + 30, // 7y 1m
    bloodGroup: "B-",
    address: "Plot 44, Sector 9, Airoli, Navi Mumbai 400708",
    parentName: "Ankit Gupta (Father)",
    parentPhone: "9820011007",
  },
  {
    name: "Saanvi Joshi",
    gender: "FEMALE" as Gender,
    ageDays: 365 * 9 + 200, // 9y 6m
    bloodGroup: "A+",
    address: "204 Sunflower CHS, Kandivali West, Mumbai 400067",
    parentName: "Rohini Joshi (Mother)",
    parentPhone: "9820011008",
  },
];

// Indian IAP immunization schedule milestones (simplified)
const VACCINE_SCHEDULE: Array<{ vaccine: string; doseNumber: number; ageMonths: number }> = [
  { vaccine: "BCG", doseNumber: 1, ageMonths: 0 },
  { vaccine: "Hepatitis B", doseNumber: 1, ageMonths: 0 },
  { vaccine: "OPV-0", doseNumber: 1, ageMonths: 0 },
  { vaccine: "DPT", doseNumber: 1, ageMonths: 2 },
  { vaccine: "OPV", doseNumber: 1, ageMonths: 2 },
  { vaccine: "Hib", doseNumber: 1, ageMonths: 2 },
  { vaccine: "Rotavirus", doseNumber: 1, ageMonths: 2 },
  { vaccine: "PCV", doseNumber: 1, ageMonths: 2 },
  { vaccine: "DPT", doseNumber: 2, ageMonths: 4 },
  { vaccine: "OPV", doseNumber: 2, ageMonths: 4 },
  { vaccine: "Hib", doseNumber: 2, ageMonths: 4 },
  { vaccine: "Rotavirus", doseNumber: 2, ageMonths: 4 },
  { vaccine: "PCV", doseNumber: 2, ageMonths: 4 },
  { vaccine: "DPT", doseNumber: 3, ageMonths: 6 },
  { vaccine: "OPV", doseNumber: 3, ageMonths: 6 },
  { vaccine: "Hepatitis B", doseNumber: 2, ageMonths: 6 },
  { vaccine: "MMR", doseNumber: 1, ageMonths: 9 },
  { vaccine: "Typhoid", doseNumber: 1, ageMonths: 12 },
  { vaccine: "Hepatitis A", doseNumber: 1, ageMonths: 12 },
  { vaccine: "Varicella", doseNumber: 1, ageMonths: 15 },
  { vaccine: "MMR", doseNumber: 2, ageMonths: 15 },
  { vaccine: "DPT Booster", doseNumber: 1, ageMonths: 18 },
  { vaccine: "OPV Booster", doseNumber: 1, ageMonths: 18 },
  { vaccine: "Hepatitis A", doseNumber: 2, ageMonths: 18 },
  { vaccine: "Typhoid Booster", doseNumber: 1, ageMonths: 24 },
  { vaccine: "DPT Booster", doseNumber: 2, ageMonths: 60 },
  { vaccine: "Tdap", doseNumber: 1, ageMonths: 120 },
];

// WHO-like approximate growth standard medians (per sex). Used to derive realistic values with jitter.
function expectedWeight(ageMonths: number, gender: Gender): number {
  if (ageMonths === 0) return gender === "MALE" ? 3.3 : 3.2;
  if (ageMonths <= 6) return (gender === "MALE" ? 3.3 : 3.2) + ageMonths * 0.7;
  if (ageMonths <= 12) return (gender === "MALE" ? 7.5 : 7.0) + (ageMonths - 6) * 0.35;
  if (ageMonths <= 24) return (gender === "MALE" ? 9.6 : 9.0) + (ageMonths - 12) * 0.22;
  // 2–10y: approx 2kg/year gain
  const years = ageMonths / 12;
  return (gender === "MALE" ? 12.2 : 11.5) + (years - 2) * 2.2;
}

function expectedHeight(ageMonths: number, gender: Gender): number {
  if (ageMonths === 0) return gender === "MALE" ? 50 : 49.5;
  if (ageMonths <= 12) return (gender === "MALE" ? 50 : 49.5) + ageMonths * 2.1;
  if (ageMonths <= 24) return (gender === "MALE" ? 75 : 74) + (ageMonths - 12) * 1.0;
  const years = ageMonths / 12;
  return (gender === "MALE" ? 87 : 86) + (years - 2) * 6.5;
}

function expectedHeadCirc(ageMonths: number): number | null {
  if (ageMonths > 36) return null;
  if (ageMonths === 0) return 35;
  if (ageMonths <= 6) return 35 + ageMonths * 1.3;
  if (ageMonths <= 12) return 43 + (ageMonths - 6) * 0.4;
  if (ageMonths <= 24) return 45.4 + (ageMonths - 12) * 0.15;
  return 47.2 + (ageMonths - 24) * 0.08;
}

function jitter(v: number, pct = 0.06): number {
  const delta = v * pct * (Math.random() * 2 - 1);
  return parseFloat((v + delta).toFixed(2));
}

async function main() {
  console.log("\n=== Seeding Pediatric Patients ===\n");

  // Ensure a nurse exists to tag as recordedBy
  const anyNurse = await prisma.user.findFirst({ where: { role: Role.NURSE } });
  const anyDoctor = await prisma.user.findFirst({ where: { role: Role.DOCTOR } });
  const recorderId = anyNurse?.id ?? anyDoctor?.id ?? null;

  if (!recorderId) {
    console.warn("  No nurse/doctor user found — growth records cannot be seeded. Skipping.");
    return;
  }

  let mrSeqBase = 9000; // pediatric MR range
  let patientsCreated = 0;
  let growthRecordsCreated = 0;
  let immunizationsCreated = 0;

  for (let i = 0; i < PEDIATRIC_PATIENTS.length; i++) {
    const p = PEDIATRIC_PATIENTS[i];
    const email = `ped.patient${i + 1}@medcore.local`;
    const phone = `98200110${String(i + 1).padStart(2, "0")}`;

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        phone,
        name: p.name,
        passwordHash: hash("pedpatient123"),
        role: Role.PATIENT,
      },
    });

    const dob = daysAgo(p.ageDays);
    const ageMonthsNow = Math.floor(p.ageDays / 30);
    const ageYears = Math.floor(p.ageDays / 365);

    const mrNumber = `MR${String(mrSeqBase + i).padStart(6, "0")}`;
    const patient = await prisma.patient.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        mrNumber,
        dateOfBirth: dob,
        age: ageYears,
        gender: p.gender,
        address: p.address,
        bloodGroup: p.bloodGroup,
        emergencyContactName: p.parentName,
        emergencyContactPhone: p.parentPhone,
        preferredLanguage: randomItem(["English", "Hindi", "Marathi"]),
      },
    });

    patientsCreated++;

    // ─── Growth records ───────────────────────────────────
    // Newborns: many records in first weeks (5-15 depending on age)
    const existingGrowth = await prisma.growthRecord.count({ where: { patientId: patient.id } });
    if (existingGrowth === 0) {
      const schedule: number[] = []; // age in months at time of measurement
      if (ageMonthsNow < 1) {
        // Fresh newborn: day 0, 1, 3, 7, 14 (but only those ≤ current age)
        for (const dPast of [0, 1, 3, 7, 14]) {
          if (dPast <= p.ageDays) schedule.push(Math.max(0, Math.floor(dPast / 30)));
        }
        // pad a few
        while (schedule.length < 5) schedule.push(0);
      } else if (ageMonthsNow <= 6) {
        // infant: weekly-monthly
        const points = [0, 1, 2, 3, 4, 5, 6].filter((m) => m <= ageMonthsNow);
        schedule.push(...points, ageMonthsNow);
      } else if (ageMonthsNow <= 24) {
        // toddler: monthly/bi-monthly
        for (let m = 0; m <= ageMonthsNow; m += 2) schedule.push(m);
      } else {
        // kids: quarterly/biannual
        for (let m = 0; m <= ageMonthsNow; m += 6) schedule.push(m);
      }
      // cap 5-15
      const scheduleFinal = schedule.slice(0, 15);
      if (scheduleFinal.length < 5) {
        while (scheduleFinal.length < 5) scheduleFinal.push(ageMonthsNow);
      }

      for (const m of scheduleFinal) {
        // measurement date = dob + m*30
        const measureDate = addDays(dob, Math.min(p.ageDays, Math.max(0, m * 30)));
        const w = jitter(expectedWeight(m, p.gender));
        const h = jitter(expectedHeight(m, p.gender), 0.04);
        const hc = expectedHeadCirc(m);
        const bmi = parseFloat((w / Math.pow(h / 100, 2)).toFixed(1));

        await prisma.growthRecord.create({
          data: {
            patientId: patient.id,
            measurementDate: measureDate,
            ageMonths: m,
            weightKg: w,
            heightCm: h,
            headCircumference: hc ? jitter(hc, 0.03) : null,
            bmi,
            weightPercentile: randomFloat(15, 90, 1),
            heightPercentile: randomFloat(20, 88, 1),
            milestoneNotes:
              m === 0
                ? "Birth measurements"
                : m === 6
                ? "Sitting with support; reaching for objects"
                : m === 12
                ? "First words; standing with support"
                : m === 24
                ? "Running; 2-word phrases"
                : m >= 60
                ? "School readiness OK"
                : null,
            developmentalNotes:
              Math.random() > 0.7 ? randomItem([
                "Active, responsive",
                "Meets age-appropriate milestones",
                "Slightly behind peers — recheck in 1 month",
                "Parent reports good feeding pattern",
                "No concerns raised",
              ]) : null,
            recordedBy: recorderId,
          },
        });
        growthRecordsCreated++;
      }
    }

    // ─── Immunizations (partial/up-to-date mix) ──────────
    const existingImm = await prisma.immunization.count({ where: { patientId: patient.id } });
    if (existingImm === 0) {
      // Up-to-date if seq i is even, overdue if odd
      const isUpToDate = i % 2 === 0;
      for (const v of VACCINE_SCHEDULE) {
        if (v.ageMonths > ageMonthsNow) break; // future vaccines not yet due
        // For "overdue" kids skip ~30% of recent-scheduled vaccines (close to today)
        const monthsSince = ageMonthsNow - v.ageMonths;
        if (!isUpToDate && monthsSince < 4 && Math.random() > 0.4) continue;

        // Skip pediatric-newborn for older kids if already past
        const daysAgoGiven = Math.max(1, p.ageDays - v.ageMonths * 30 - randomInt(0, 10));
        const nextDue = (() => {
          // find next vaccine of same line
          const next = VACCINE_SCHEDULE.find(
            (x) => x.vaccine === v.vaccine && x.doseNumber === v.doseNumber + 1,
          );
          if (!next) return null;
          const daysFromDob = next.ageMonths * 30;
          const dueDate = addDays(dob, daysFromDob);
          return dueDate;
        })();

        await prisma.immunization.create({
          data: {
            patientId: patient.id,
            vaccine: v.vaccine,
            doseNumber: v.doseNumber,
            dateGiven: daysAgo(daysAgoGiven),
            administeredBy: recorderId,
            batchNumber: `BT${randomInt(10000, 99999)}`,
            manufacturer: randomItem(["Serum Institute", "Bharat Biotech", "GSK", "Pfizer", "Sanofi"]),
            site: randomItem(["Left thigh", "Right thigh", "Left deltoid", "Right deltoid", "Oral"]),
            nextDueDate: nextDue,
            notes: Math.random() > 0.8 ? "Mild fever post-vaccination, subsided in 24h" : null,
          },
        });
        immunizationsCreated++;
      }
    }

    console.log(`  ${p.name} — age ${ageYears}y (${ageMonthsNow}m), MR ${mrNumber}`);
  }

  console.log(`\n✔ Pediatric patients: ${patientsCreated}`);
  console.log(`✔ Growth records:     ${growthRecordsCreated}`);
  console.log(`✔ Immunizations:      ${immunizationsCreated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
