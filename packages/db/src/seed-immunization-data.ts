/**
 * Realistic immunization data seed — UIP child schedule + adult vaccines.
 *
 * Idempotency contract (2026-05-10): this script is safe to re-run on a
 * populated demo without creating duplicate Immunization rows.
 *
 *   - All randomness is driven by a deterministic mulberry32 PRNG seeded
 *     from a fixed constant. Re-runs produce byte-identical decisions
 *     (which adult vaccines, which "wasGiven" outcome, which manufacturer).
 *   - The Immunization model has no `@unique` field we can upsert on. We
 *     gate every `.create` with a `findFirst({where:{patientId, vaccine,
 *     doseNumber}})` guard — that tuple is the natural logical-identity
 *     for an immunization row. With deterministic RNG the same (patient,
 *     vaccine, doseNumber) decisions are made on each run, so the guard
 *     keeps re-runs idempotent.
 *   - Each row's `notes` field is stamped with a stable
 *     `IMMUN-SEED-NNNNNN` marker so DB-side audits can identify
 *     seed-created rows separately from real clinical data.
 *
 * Wired into `scripts/deploy.sh` step 8l. Failures are non-fatal (matches
 * the policy of every other deploy-time fixture seed).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── DETERMINISTIC RNG ──────────────────────────────────
// mulberry32 — same pattern as seed-realistic.ts. Replaces every
// Math.random() so re-runs make byte-identical decisions and the
// (patientId, vaccine, doseNumber) idempotency guard keeps mapping back
// to the same logical row.
const SEED = 0xfeed_5eed >>> 0; // arbitrary fixed constant
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

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

interface VaccineEntry {
  vaccine: string;
  dueAgeDays: number;
  doseNumber?: number;
  manufacturer?: string;
  interval?: number;
  site?: string;
}

const CHILD_SCHEDULE: VaccineEntry[] = [
  { vaccine: "BCG", dueAgeDays: 0, doseNumber: 1, site: "Left upper arm" },
  { vaccine: "Hepatitis B", dueAgeDays: 0, doseNumber: 1, site: "Anterolateral thigh" },
  { vaccine: "OPV", dueAgeDays: 0, doseNumber: 1, site: "Oral drops" },
  { vaccine: "OPV", dueAgeDays: 42, doseNumber: 2, site: "Oral drops" },
  { vaccine: "Pentavalent (DPT+HepB+Hib)", dueAgeDays: 42, doseNumber: 1, site: "Anterolateral thigh" },
  { vaccine: "Rotavirus", dueAgeDays: 42, doseNumber: 1, site: "Oral drops" },
  { vaccine: "fIPV", dueAgeDays: 42, doseNumber: 1, site: "Right arm" },
  { vaccine: "OPV", dueAgeDays: 70, doseNumber: 3, site: "Oral drops" },
  { vaccine: "Pentavalent (DPT+HepB+Hib)", dueAgeDays: 70, doseNumber: 2, site: "Anterolateral thigh" },
  { vaccine: "Rotavirus", dueAgeDays: 70, doseNumber: 2, site: "Oral drops" },
  { vaccine: "OPV", dueAgeDays: 98, doseNumber: 4, site: "Oral drops" },
  { vaccine: "Pentavalent (DPT+HepB+Hib)", dueAgeDays: 98, doseNumber: 3, site: "Anterolateral thigh" },
  { vaccine: "Rotavirus", dueAgeDays: 98, doseNumber: 3, site: "Oral drops" },
  { vaccine: "fIPV", dueAgeDays: 98, doseNumber: 2, site: "Right arm" },
  { vaccine: "MR (Measles-Rubella)", dueAgeDays: 270, doseNumber: 1, site: "Right upper arm" },
  { vaccine: "JE (Japanese Encephalitis)", dueAgeDays: 270, doseNumber: 1, site: "Left upper arm" },
  { vaccine: "Vitamin A (1st dose)", dueAgeDays: 270, doseNumber: 1, site: "Oral" },
  { vaccine: "DPT Booster 1", dueAgeDays: 490, doseNumber: 1, site: "Anterolateral thigh" },
  { vaccine: "MR (Measles-Rubella)", dueAgeDays: 490, doseNumber: 2, site: "Right upper arm" },
  { vaccine: "OPV Booster", dueAgeDays: 490, doseNumber: 1, site: "Oral drops" },
  { vaccine: "JE (Japanese Encephalitis)", dueAgeDays: 490, doseNumber: 2, site: "Left upper arm" },
  { vaccine: "Vitamin A (2nd dose)", dueAgeDays: 547, doseNumber: 2, site: "Oral" },
  { vaccine: "DPT Booster 2", dueAgeDays: 1825, doseNumber: 2, site: "Upper arm" },
  { vaccine: "Td", dueAgeDays: 3650, doseNumber: 1, site: "Upper arm" },
  { vaccine: "Td", dueAgeDays: 5475, doseNumber: 2, site: "Upper arm" },
];

const ADULT_VACCINES = [
  { vaccine: "Influenza (Annual)", manufacturer: "Abbott", site: "Deltoid" },
  { vaccine: "Hepatitis B Booster", manufacturer: "GSK", site: "Deltoid" },
  { vaccine: "Typhoid (Typhim Vi)", manufacturer: "Sanofi", site: "Deltoid" },
  { vaccine: "Tdap", manufacturer: "Serum Institute", site: "Deltoid" },
  { vaccine: "HPV", manufacturer: "Cervarix", site: "Deltoid" },
  { vaccine: "Pneumococcal (PPSV23)", manufacturer: "Pfizer", site: "Deltoid" },
  { vaccine: "COVID-19 (Covaxin)", manufacturer: "Bharat Biotech", site: "Deltoid" },
  { vaccine: "COVID-19 (Covishield)", manufacturer: "Serum Institute", site: "Deltoid" },
  { vaccine: "Varicella", manufacturer: "MSD", site: "Deltoid" },
  { vaccine: "MMR", manufacturer: "Serum Institute", site: "Deltoid" },
];

const MANUFACTURERS = ["Serum Institute", "Bharat Biotech", "Biological E", "Panacea Biotec", "Indian Immunologicals"];

function randomBatch(vaccine: string): string {
  const prefix = vaccine.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, "V");
  return `${prefix}${String(rand(2024, 2026)).slice(2)}${String(rand(1, 999)).padStart(3, "0")}${String.fromCharCode(65 + rand(0, 25))}`;
}

/**
 * Idempotency guard: skip the create if a row matching (patientId, vaccine,
 * doseNumber) already exists. With deterministic RNG, the same logical
 * decisions are made on each run, so this tuple-as-natural-key approach
 * keeps re-runs from duplicating rows.
 */
async function createIfMissing(data: {
  patientId: string;
  vaccine: string;
  doseNumber: number;
  dateGiven: Date;
  administeredBy: string;
  batchNumber: string | null;
  manufacturer: string | null;
  site?: string;
  nextDueDate: Date | null;
  notes: string | null;
  seedSeq: number;
}): Promise<boolean> {
  const existing = await prisma.immunization.findFirst({
    where: {
      patientId: data.patientId,
      vaccine: data.vaccine,
      doseNumber: data.doseNumber,
    },
    select: { id: true },
  });
  if (existing) return false;

  const seedTag = `IMMUN-SEED-${String(data.seedSeq).padStart(6, "0")}`;
  const stampedNotes = data.notes ? `[${seedTag}] ${data.notes}` : `[${seedTag}]`;

  await prisma.immunization.create({
    data: {
      patientId: data.patientId,
      vaccine: data.vaccine,
      doseNumber: data.doseNumber,
      dateGiven: data.dateGiven,
      administeredBy: data.administeredBy,
      batchNumber: data.batchNumber,
      manufacturer: data.manufacturer,
      site: data.site,
      nextDueDate: data.nextDueDate,
      notes: stampedNotes,
    },
  });
  return true;
}

async function main() {
  console.log("=== Seeding immunization data (idempotent) ===\n");
  resetRng();

  const patients = await prisma.patient.findMany({
    select: {
      id: true,
      age: true,
      dateOfBirth: true,
      user: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });

  if (!patients.length) {
    console.log("No patients found. Run seed-realistic.ts first.");
    return;
  }
  console.log(`Found ${patients.length} patients`);

  const existing = await prisma.immunization.count();
  if (existing > 0) {
    console.log(`Found ${existing} existing immunization records — keeping those and re-asserting fixtures.`);
  }

  const staffUsers = await prisma.user.findMany({
    where: { role: { in: ["NURSE", "DOCTOR"] } },
    take: 5,
    orderBy: { id: "asc" },
  });
  const adminUserId = staffUsers[0]?.id ?? "system";

  let totalChildDoses = 0;
  let totalAdultDoses = 0;
  let totalUpcomingDue = 0;
  let totalSkipped = 0;
  let patientsProcessed = 0;
  let seedSeq = 1;

  for (const patient of patients) {
    const age = patient.age ?? 30;
    const isPediatric = age < 10;

    if (isPediatric) {
      const birthDate = patient.dateOfBirth
        ? new Date(patient.dateOfBirth)
        : daysAgo(age * 365);
      const ageInDays = Math.floor((Date.now() - birthDate.getTime()) / (1000 * 60 * 60 * 24));

      for (const entry of CHILD_SCHEDULE) {
        if (entry.dueAgeDays > ageInDays) {
          if (entry.dueAgeDays - ageInDays <= 180) {
            const nextDueDate = new Date(birthDate.getTime() + entry.dueAgeDays * 86400000);
            const created = await createIfMissing({
              patientId: patient.id,
              vaccine: entry.vaccine,
              doseNumber: entry.doseNumber ?? 1,
              dateGiven: daysAgo(0),
              administeredBy: "Scheduled",
              batchNumber: null,
              manufacturer: null,
              site: entry.site,
              nextDueDate,
              notes: `UPCOMING — Next scheduled dose`,
              seedSeq: seedSeq++,
            });
            if (created) totalUpcomingDue++; else totalSkipped++;
          }
          continue;
        }

        const wasGiven = rng() < 0.85;
        const dateGiven = new Date(birthDate.getTime() + entry.dueAgeDays * 86400000);

        if (wasGiven) {
          dateGiven.setDate(dateGiven.getDate() + rand(0, 14));
          if (dateGiven > new Date()) dateGiven.setTime(Date.now() - rand(1, 30) * 86400000);

          const created = await createIfMissing({
            patientId: patient.id,
            vaccine: entry.vaccine,
            doseNumber: entry.doseNumber ?? 1,
            dateGiven,
            administeredBy: pick(staffUsers)?.id ?? adminUserId,
            batchNumber: randomBatch(entry.vaccine),
            manufacturer: pick(MANUFACTURERS),
            site: entry.site,
            nextDueDate: null,
            notes: null,
            seedSeq: seedSeq++,
          });
          if (created) totalChildDoses++; else totalSkipped++;
        } else {
          const overdueDays = rand(7, 60);
          const clampedDueDate = daysAgo(overdueDays);
          const created = await createIfMissing({
            patientId: patient.id,
            vaccine: entry.vaccine,
            doseNumber: entry.doseNumber ?? 1,
            dateGiven: daysAgo(1),
            administeredBy: "Not given",
            batchNumber: null,
            manufacturer: null,
            site: entry.site,
            nextDueDate: clampedDueDate,
            notes: `OVERDUE — was due ${clampedDueDate.toLocaleDateString(
              "en-IN"
            )} (${overdueDays}d), not yet administered`,
            seedSeq: seedSeq++,
          });
          if (created) totalUpcomingDue++; else totalSkipped++;
        }
      }
    } else {
      const count = rand(2, 5);
      const shuffled = [...ADULT_VACCINES];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
      }
      const picked = shuffled.slice(0, count);

      for (const v of picked) {
        const daysAgoGiven = rand(30, 730);
        const dateGiven = daysAgo(daysAgoGiven);

        let nextDueDate: Date | null = null;
        const nextNotes: string | null = null;
        if (v.vaccine.includes("Influenza") || v.vaccine === "COVID-19 (Covishield)" || v.vaccine === "COVID-19 (Covaxin)") {
          nextDueDate = daysFromNow(365 - daysAgoGiven);
        }
        if (v.vaccine.includes("Tdap") || v.vaccine === "Td") {
          nextDueDate = daysFromNow(3650 - daysAgoGiven);
        }

        const doseNumber = v.vaccine.includes("COVID") ? rand(1, 3) : 1;
        const created = await createIfMissing({
          patientId: patient.id,
          vaccine: v.vaccine,
          doseNumber,
          dateGiven,
          administeredBy: pick(staffUsers)?.id ?? adminUserId,
          batchNumber: randomBatch(v.vaccine),
          manufacturer: v.manufacturer,
          site: v.site,
          nextDueDate,
          notes: nextNotes,
          seedSeq: seedSeq++,
        });
        if (created) totalAdultDoses++; else totalSkipped++;

        if (nextDueDate && nextDueDate < new Date()) totalUpcomingDue++;
      }

      if (rng() < 0.3) {
        const v = pick(ADULT_VACCINES);
        const nextDueDate = daysFromNow(rand(1, 90));
        const created = await createIfMissing({
          patientId: patient.id,
          vaccine: v.vaccine,
          doseNumber: 99,
          dateGiven: daysAgo(1),
          administeredBy: "Scheduled",
          batchNumber: null,
          manufacturer: null,
          site: v.site,
          nextDueDate,
          notes: "UPCOMING — Due within 90 days",
          seedSeq: seedSeq++,
        });
        if (created) totalUpcomingDue++; else totalSkipped++;
      }
    }

    patientsProcessed++;
  }

  console.log(`\n  Processed ${patientsProcessed} patients`);
  console.log(`  Pediatric doses given: ${totalChildDoses}`);
  console.log(`  Adult doses given: ${totalAdultDoses}`);
  console.log(`  Upcoming / overdue entries: ${totalUpcomingDue}`);
  console.log(`  Skipped (already present): ${totalSkipped}`);

  const totalInDB = await prisma.immunization.count();
  console.log(`  Total immunization records in DB: ${totalInDB}`);

  console.log("\n=== Immunization seed complete ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
