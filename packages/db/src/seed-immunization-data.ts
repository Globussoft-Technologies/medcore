import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

/**
 * India National Immunization Schedule (UIP)
 * Plus common adult vaccines.
 */
interface VaccineEntry {
  vaccine: string;
  dueAgeDays: number;    // Age in days when due (for children)
  doseNumber?: number;
  manufacturer?: string;
  interval?: number;     // If follow-up dose, days after previous
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

async function main() {
  console.log("=== Seeding immunization data ===\n");

  const patients = await prisma.patient.findMany({
    select: {
      id: true,
      age: true,
      dateOfBirth: true,
      user: { select: { name: true } },
    },
  });

  if (!patients.length) {
    console.log("No patients found. Run seed-realistic.ts first.");
    return;
  }
  console.log(`Found ${patients.length} patients`);

  // Clear existing immunizations to avoid duplicates (we want fresh realistic data)
  const existing = await prisma.immunization.count();
  if (existing > 0) {
    console.log(`Found ${existing} existing immunization records — keeping those and adding more.`);
  }

  const staffUsers = await prisma.user.findMany({
    where: { role: { in: ["NURSE", "DOCTOR"] } },
    take: 5,
  });
  const adminUserId = staffUsers[0]?.id ?? "system";

  let totalChildDoses = 0;
  let totalAdultDoses = 0;
  let totalUpcomingDue = 0;
  let patientsProcessed = 0;

  for (const patient of patients) {
    const age = patient.age ?? 30;

    // Treat patients under 10 as "pediatric" for full schedule
    const isPediatric = age < 10;

    if (isPediatric) {
      // For pediatric patients, simulate partial completion of schedule
      // Generate hypothetical birth date (age years ago)
      const birthDate = patient.dateOfBirth
        ? new Date(patient.dateOfBirth)
        : daysAgo(age * 365);
      const ageInDays = Math.floor((Date.now() - birthDate.getTime()) / (1000 * 60 * 60 * 24));

      // Apply schedule entries where dueAgeDays <= ageInDays (vaccine should have been given)
      for (const entry of CHILD_SCHEDULE) {
        if (entry.dueAgeDays > ageInDays) {
          // Future vaccine — create upcoming-due entry if within next 180 days
          if (entry.dueAgeDays - ageInDays <= 180) {
            const nextDueDate = new Date(birthDate.getTime() + entry.dueAgeDays * 86400000);
            await prisma.immunization.create({
              data: {
                patientId: patient.id,
                vaccine: entry.vaccine,
                doseNumber: entry.doseNumber ?? 1,
                dateGiven: daysAgo(0), // placeholder; use notes to mark as upcoming
                administeredBy: "Scheduled",
                batchNumber: null,
                manufacturer: null,
                site: entry.site,
                nextDueDate,
                notes: `UPCOMING — Next scheduled dose`,
              },
            }).catch(() => {});
            totalUpcomingDue++;
          }
          continue;
        }

        // Past due — 85% chance given, 15% chance overdue (missed)
        const wasGiven = Math.random() < 0.85;
        const dateGiven = new Date(birthDate.getTime() + entry.dueAgeDays * 86400000);

        if (wasGiven) {
          // Maybe slight delay
          dateGiven.setDate(dateGiven.getDate() + rand(0, 14));
          if (dateGiven > new Date()) dateGiven.setTime(Date.now() - rand(1, 30) * 86400000);

          await prisma.immunization.create({
            data: {
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
            },
          }).catch(() => {});
          totalChildDoses++;
        } else {
          // Overdue — set nextDueDate in the past to flag it
          await prisma.immunization.create({
            data: {
              patientId: patient.id,
              vaccine: entry.vaccine,
              doseNumber: entry.doseNumber ?? 1,
              dateGiven: daysAgo(1), // mock placeholder since date is required
              administeredBy: "Not given",
              batchNumber: null,
              manufacturer: null,
              site: entry.site,
              nextDueDate: dateGiven,
              notes: `OVERDUE — was due ${dateGiven.toLocaleDateString("en-IN")}, not yet administered`,
            },
          }).catch(() => {});
          totalUpcomingDue++;
        }
      }
    } else {
      // Adult patients — pick 2-5 random adult vaccines
      const count = rand(2, 5);
      const picked = new Set<string>();
      for (let i = 0; i < count * 2 && picked.size < count; i++) {
        const v = pick(ADULT_VACCINES);
        if (picked.has(v.vaccine)) continue;
        picked.add(v.vaccine);

        const daysAgoGiven = rand(30, 730); // 1 month to 2 years ago
        const dateGiven = daysAgo(daysAgoGiven);

        // Some vaccines have boosters due
        let nextDueDate: Date | null = null;
        let nextNotes: string | null = null;
        if (v.vaccine.includes("Influenza") || v.vaccine === "COVID-19 (Covishield)" || v.vaccine === "COVID-19 (Covaxin)") {
          // annual
          nextDueDate = daysFromNow(365 - daysAgoGiven);
        }
        if (v.vaccine.includes("Tdap") || v.vaccine === "Td") {
          nextDueDate = daysFromNow(3650 - daysAgoGiven); // 10y
        }

        await prisma.immunization.create({
          data: {
            patientId: patient.id,
            vaccine: v.vaccine,
            doseNumber: v.vaccine.includes("COVID") ? rand(1, 3) : 1,
            dateGiven,
            administeredBy: pick(staffUsers)?.id ?? adminUserId,
            batchNumber: randomBatch(v.vaccine),
            manufacturer: v.manufacturer,
            site: v.site,
            nextDueDate,
            notes: nextNotes,
          },
        }).catch(() => {});
        totalAdultDoses++;

        if (nextDueDate && nextDueDate < new Date()) totalUpcomingDue++;
      }

      // 30% chance of an upcoming due booster
      if (Math.random() < 0.3) {
        const v = pick(ADULT_VACCINES);
        const nextDueDate = daysFromNow(rand(1, 90));
        await prisma.immunization.create({
          data: {
            patientId: patient.id,
            vaccine: v.vaccine,
            doseNumber: 1,
            dateGiven: daysAgo(1),
            administeredBy: "Scheduled",
            batchNumber: null,
            manufacturer: null,
            site: v.site,
            nextDueDate,
            notes: "UPCOMING — Due within 90 days",
          },
        }).catch(() => {});
        totalUpcomingDue++;
      }
    }

    patientsProcessed++;
  }

  console.log(`\n  Processed ${patientsProcessed} patients`);
  console.log(`  Pediatric doses given: ${totalChildDoses}`);
  console.log(`  Adult doses given: ${totalAdultDoses}`);
  console.log(`  Upcoming / overdue entries: ${totalUpcomingDue}`);

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
