/**
 * Issue #93 (2026-04-26) — Controlled Substance Register seed.
 *
 * Production / staging deployments shipped without any sample data so the
 * Controlled Register page rendered an empty state with no way to verify
 * the workflow without manually dispensing first. This script:
 *
 *  1) Ensures a minimal set of Schedule H1 / X medicines exists (creates
 *     them if missing, otherwise just toggles `requiresRegister=true` and
 *     `scheduleClass`).
 *  2) Seeds 8 sample ControlledSubstanceEntry rows distributed across
 *     those medicines so the register, audit-report and per-medicine
 *     views all have data to display.
 *
 * Idempotent: re-running skips rows whose entryNumber already exists
 * (we generate stable numbers from a fixed offset). Run via:
 *   npm run -w @medcore/db db:seed-controlled-register
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface SeedMedicine {
  name: string;
  genericName: string;
  scheduleClass: "H1" | "X";
  form: string;
  strength: string;
}

const SAMPLE_MEDICINES: SeedMedicine[] = [
  { name: "Morphine 10mg INJ", genericName: "Morphine", scheduleClass: "X", form: "Injection", strength: "10mg" },
  { name: "Tramadol 50mg CAP", genericName: "Tramadol", scheduleClass: "H1", form: "Capsule", strength: "50mg" },
  { name: "Alprazolam 0.5mg TAB", genericName: "Alprazolam", scheduleClass: "H1", form: "Tablet", strength: "0.5mg" },
  { name: "Diazepam 5mg TAB", genericName: "Diazepam", scheduleClass: "H1", form: "Tablet", strength: "5mg" },
];

interface SeedEntry {
  medicineName: string;
  quantity: number;
  notes: string;
  daysAgo: number;
}

const SAMPLE_ENTRIES: SeedEntry[] = [
  { medicineName: "Morphine 10mg INJ", quantity: 2, notes: "Post-op analgesia, CABG patient", daysAgo: 0 },
  { medicineName: "Morphine 10mg INJ", quantity: 1, notes: "Palliative care, advanced metastatic disease", daysAgo: 1 },
  { medicineName: "Tramadol 50mg CAP", quantity: 10, notes: "Chronic back pain, 5-day supply", daysAgo: 2 },
  { medicineName: "Tramadol 50mg CAP", quantity: 14, notes: "Knee replacement step-down", daysAgo: 3 },
  { medicineName: "Alprazolam 0.5mg TAB", quantity: 7, notes: "Acute anxiety crisis, 1-week titration", daysAgo: 4 },
  { medicineName: "Alprazolam 0.5mg TAB", quantity: 5, notes: "Pre-procedure sedation", daysAgo: 5 },
  { medicineName: "Diazepam 5mg TAB", quantity: 6, notes: "Status epilepticus follow-up", daysAgo: 6 },
  { medicineName: "Diazepam 5mg TAB", quantity: 4, notes: "Alcohol withdrawal protocol", daysAgo: 7 },
];

async function ensureMedicines(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // Medicine is now a per-tenant catalog (@@unique([tenantId, name])); tag rows
  // with the default tenant and look up by (tenant, name) instead of the old
  // global name-unique.
  const defaultTenant = await prisma.tenant.findFirst({
    where: { subdomain: "default" },
    select: { id: true },
  });
  const defaultTenantId = defaultTenant?.id ?? null;
  for (const m of SAMPLE_MEDICINES) {
    const existing = await prisma.medicine.findFirst({
      where: { name: m.name, tenantId: defaultTenantId },
      select: { id: true },
    });
    if (existing) {
      // Make sure the controlled flags are set even if the row pre-existed.
      await prisma.medicine.update({
        where: { id: existing.id },
        data: {
          scheduleClass: m.scheduleClass,
          requiresRegister: true,
          isNarcotic: true,
        },
      });
      out[m.name] = existing.id;
    } else {
      const created = await prisma.medicine.create({
        data: {
          name: m.name,
          tenantId: defaultTenantId,
          genericName: m.genericName,
          form: m.form,
          strength: m.strength,
          scheduleClass: m.scheduleClass,
          requiresRegister: true,
          isNarcotic: true,
          prescriptionRequired: true,
          category: "Controlled Substance",
        },
      });
      out[m.name] = created.id;
    }
  }
  return out;
}

async function pickDispenser(): Promise<string> {
  // Prefer an existing PHARMACIST → ADMIN → first user. The register page
  // displays this user's name in the "Dispensed by" column.
  const pharma = await prisma.user.findFirst({
    where: { role: "PHARMACIST" as any },
    select: { id: true },
  });
  if (pharma) return pharma.id;
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" as any },
    select: { id: true },
  });
  if (admin) return admin.id;
  const any = await prisma.user.findFirst({ select: { id: true } });
  if (!any) {
    throw new Error(
      "seed-controlled-register: no User rows exist. Run the base seed first."
    );
  }
  return any.id;
}

async function nextBalance(medicineId: string, quantity: number): Promise<number> {
  const last = await prisma.controlledSubstanceEntry.findFirst({
    where: { medicineId },
    orderBy: { dispensedAt: "desc" },
    select: { balance: true },
  });
  if (last) return Math.max(0, last.balance - quantity);
  // No prior entry — start from a reasonable on-hand stock so the audit
  // report has something to compare against.
  const opening = 100;
  return Math.max(0, opening - quantity);
}

async function main() {
  console.log("Seeding controlled-substance register…");

  const medIds = await ensureMedicines();
  console.log(`Ensured ${Object.keys(medIds).length} controlled medicines.`);

  const dispenserId = await pickDispenser();

  let created = 0;
  let skipped = 0;
  // Stable entry numbers based on the seed index so re-running this
  // script doesn't double-write rows.
  for (let i = 0; i < SAMPLE_ENTRIES.length; i++) {
    const e = SAMPLE_ENTRIES[i];
    const entryNumber = `CSR-SEED-${String(i + 1).padStart(4, "0")}`;
    const exists = await prisma.controlledSubstanceEntry.findUnique({
      where: { entryNumber },
      select: { id: true },
    });
    if (exists) {
      skipped++;
      continue;
    }
    const medicineId = medIds[e.medicineName];
    if (!medicineId) {
      console.warn(`  skipping entry ${i + 1}: medicine "${e.medicineName}" missing`);
      continue;
    }
    const balance = await nextBalance(medicineId, e.quantity);
    const dispensedAt = new Date(Date.now() - e.daysAgo * 24 * 60 * 60 * 1000);
    await prisma.controlledSubstanceEntry.create({
      data: {
        entryNumber,
        medicineId,
        quantity: e.quantity,
        notes: e.notes,
        balance,
        dispensedAt,
        dispensedBy: dispenserId,
      },
    });
    created++;
  }

  console.log(
    `Controlled register seed complete — created ${created}, skipped ${skipped} (already present).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
