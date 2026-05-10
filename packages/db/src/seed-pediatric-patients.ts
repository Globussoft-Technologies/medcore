/**
 * Pediatric patient seed — 8 children, growth records, immunizations.
 *
 * Idempotency contract (2026-05-11):
 *   - Users: `upsert({ where: { email: ped.patient${i}@medcore.local } })`.
 *   - Patients: `upsert({ where: { userId } })`. mrNumbers are namespaced
 *     as `MR-PED-SEED-${NNN}` so they NEVER collide with the live
 *     `next_mr_number` counter (`MR000001..`) consumed by
 *     `apps/api/src/routes/patients.ts` and `apps/api/src/routes/auth.ts`.
 *     Earlier the seed used contiguous `MR000036..MR000043` which DID
 *     collide — if the live counter passed 36, patient creation would
 *     P2002 on the next deploy. Now the seed runs in its own namespace.
 *   - GrowthRecord: no native unique; guarded with `findFirst({patientId,
 *     ageMonths})` skip per measurement point. The schedule is computed
 *     deterministically from `ageMonthsNow` so re-runs produce the same
 *     point set.
 *   - Immunization: no native unique either; guarded with `findFirst(
 *     {patientId, vaccine, doseNumber})` skip per dose.
 *
 *   - Replaced every `Math.random()` with a fixed-seed mulberry32 PRNG so
 *     the "skip random vaccine 30% of the time" / "weight jitter" / "Indian
 *     language pick" decisions are byte-identical run-over-run. Without
 *     this, the `randomItem(["Serum Institute", "Bharat Biotech", ...])`
 *     manufacturer choice could differ across runs, but the find-guard
 *     would still keep idempotency.
 */
import { PrismaClient, Role, Gender } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ─── DETERMINISTIC RNG ──────────────────────────────────
// mulberry32 — same pattern as seed-realistic.ts (commit 4554706). Same
// SEED → same number sequence → same demo state. resetRng() lets a future
// caller restart the sequence between passes if needed.
const SEED = 0xc0ffee_44; // distinct constant per file
let _rngState = SEED;
function rng(): number {
  _rngState |= 0;
  _rngState = (_rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hash(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 1) {
  return parseFloat((rng() * (max - min) + min).toFixed(decimals));
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
    // Bug #497: was ageDays: 3 (newborn) which floor-divided to age=0 yrs in
    // the Patient.age column. The pediatric dashboard rendered "Age: 0 yrs"
    // which looks like a data-entry bug. Bumped to ~5y so the row is
    // age-coherent. Newborn coverage is still provided by Ishani Patel
    // (6 mo) and the growth-record schedule below — the seed produces an
    // initial measurement at ageMonths=0 (DOB) for every patient regardless
    // of current age, so the "newborn measurements" data point still exists.
    ageDays: 365 * 5 + 45, // 5y 1.5m
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
  const delta = v * pct * (rng() * 2 - 1);
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

  // 2026-05-11 idempotency rewrite: previously pediatric used contiguous
  // `MR000036..MR000043` (sat right after seed-realistic.ts's MR000001..035
  // range). That format DID collide with the live `next_mr_number`
  // SystemConfig counter consumed by patients.ts and auth.ts — once the
  // counter passed 36, the next deploy's seed would P2002 on the unique
  // mrNumber. Now namespaced as `MR-PED-SEED-${NNN}`. Live customer patients
  // continue to get `MR000001..` from the SystemConfig counter, untouched
  // by this seed.
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

    const mrNumber = `MR-PED-SEED-${String(i + 1).padStart(3, "0")}`;
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
              rng() > 0.7 ? randomItem([
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
        if (!isUpToDate && monthsSince < 4 && rng() > 0.4) continue;

        // Skip pediatric-newborn for older kids if already past
        const daysAgoGiven = Math.max(1, p.ageDays - v.ageMonths * 30 - randomInt(0, 10));

        // Issue #46: nextDueDate used to be `addDays(dob, next.ageMonths * 30)` —
        // for older kids (e.g. 9.5y Saanvi Joshi), that landed years in the past
        // and the dashboard showed "DPT 3375 days overdue". Now we anchor to
        // DOB+UIP offset only when it falls within the next 180 days; otherwise
        // we either skip the next-due (the dose was already missed and is too
        // far in the past to be plausible) OR clamp it to a realistic 7-60 day
        // overdue window using a deterministic offset derived from the seed
        // index so the demo is reproducible run-over-run. See also
        // scripts/fix-stale-immunizations.ts which does the same correction
        // on data already in the DB.
        const nextDue = (() => {
          // find next vaccine of same line
          const next = VACCINE_SCHEDULE.find(
            (x) => x.vaccine === v.vaccine && x.doseNumber === v.doseNumber + 1,
          );
          if (!next) return null;
          const daysFromDob = next.ageMonths * 30;
          const anchoredDueDate = addDays(dob, daysFromDob);
          const daysOld = Math.floor(
            (Date.now() - anchoredDueDate.getTime()) / 86_400_000,
          );
          // Anchor falls within "soon" (next 180d) or only mildly overdue (≤60d) — use it.
          if (daysOld <= 60) return anchoredDueDate;
          // For "up-to-date" kids: don't show stale pending entries.
          if (isUpToDate) return null;
          // For "overdue" kids: only show every 3rd stale-anchored vaccine,
          // and clamp it to a 7-60d overdue window. Deterministic via index
          // so re-seeding produces the same demo state.
          const seed = (i * 31 + v.ageMonths * 7 + v.doseNumber) >>> 0;
          if (seed % 3 !== 0) return null;
          const overdueDays = 7 + (seed % 54); // 7..60d
          return new Date(Date.now() - overdueDays * 86_400_000);
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
            notes: rng() > 0.8 ? "Mild fever post-vaccination, subsided in 24h" : null,
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
