// Seeds hospital identity + tax + notification-template SystemConfig rows.
// Idempotent: uses upsert on the unique `key` column.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ENTRIES: Record<string, string> = {
  hospital_name: "MedCore Hospital & Diagnostics",
  hospital_address:
    "42 Linking Road, Bandra West, Mumbai, Maharashtra 400050",
  hospital_phone: "+91 22 2640 5678",
  hospital_email: "info@medcorehospital.in",
  hospital_registration: "MH/MUM/2024/HC-4521",
  hospital_gstin: "27AAACM1234Z1Z5",
  hospital_license: "NABH-2024-MUM-0042",
  hospital_logo_url: "",
  hospital_tagline: "Excellence in Healthcare Since 2024",
  tax_cgst_rate: "9",
  tax_sgst_rate: "9",
  vitals_alert_sms_template:
    "Alert: Your SpO2 reading {{spo2}}% is below normal. Please contact your doctor immediately.",
};

async function main() {
  console.log("\n=== Seeding Hospital SystemConfig ===\n");

  let created = 0;
  let updated = 0;

  for (const [key, value] of Object.entries(ENTRIES)) {
    const existing = await prisma.systemConfig.findUnique({ where: { key } });
    await prisma.systemConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    if (existing) updated++;
    else created++;
    console.log(`  ${existing ? "updated" : "created"}  ${key}`);
  }

  console.log(`\n  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Total keys: ${Object.keys(ENTRIES).length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
