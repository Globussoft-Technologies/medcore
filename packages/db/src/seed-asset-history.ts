import { PrismaClient, MaintenanceType, AssetStatus, Role } from "@prisma/client";

const prisma = new PrismaClient();

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d;
}

const MAINTENANCE_VENDORS = [
  "Siemens Service Centre",
  "GE Healthcare Field Service",
  "Philips India Biomedical",
  "BioTech Calibrations Pvt Ltd",
  "Allied Medical Services",
  "In-house Biomedical Dept",
];

const SCHEDULED_DESCRIPTIONS = [
  "Quarterly preventive maintenance — cleaning, firmware update, safety check",
  "Annual service — belt replacement, bearing lubrication, sensor calibration",
  "Bi-annual PM — coolant level check, filter replacement, function test",
  "Routine servicing as per AMC contract — all parameters within spec",
];
const BREAKDOWN_DESCRIPTIONS = [
  "Unit not powering on — replaced faulty PSU; resolved same day",
  "Intermittent error code E-12; replaced main logic board",
  "Display panel flickering — replaced ribbon connector",
  "Mechanical jam in carriage; cleaned and lubricated",
  "Battery backup failure — replaced UPS battery pack",
];
const CALIBRATION_DESCRIPTIONS = [
  "Calibration against reference standard — deviation within acceptable limits",
  "NABL-traceable calibration certificate issued; valid 12 months",
  "Pressure & flow calibration; all readings within ±2%",
  "Temperature sensor calibration at 3 points; passed",
];
const INSPECTION_DESCRIPTIONS = [
  "NABH annual inspection — all safety checks passed",
  "Electrical safety inspection — earth leakage within limits",
  "Visual inspection, cable integrity and alarms tested",
];

async function main() {
  console.log("\n=== Seeding Asset History ===\n");

  const assets = await prisma.asset.findMany({ orderBy: { assetTag: "asc" }, take: 20 });
  if (assets.length === 0) {
    console.warn("  No assets found — run seed-phase4-ops first. Skipping.");
    return;
  }

  const technicians = await prisma.user.findMany({
    where: { role: { in: [Role.ADMIN, Role.NURSE, Role.DOCTOR] }, isActive: true },
    take: 8,
  });
  if (technicians.length === 0) {
    console.warn("  No users available to mark as technicians. Skipping.");
    return;
  }

  let maintenanceCreated = 0;
  let transfersCreated = 0;
  let disposedCount = 0;
  let calibrationScheduled = 0;
  let amcUpdated = 0;

  // ─── Maintenance logs (2-5 per asset spanning 2 years) ─
  for (let idx = 0; idx < assets.length; idx++) {
    const a = assets[idx];
    const existing = await prisma.assetMaintenance.count({ where: { assetId: a.id } });
    if (existing >= 2) {
      continue; // already has records
    }

    const numLogs = randomInt(2, 5);
    // spaced across past 730 days
    for (let j = 0; j < numLogs; j++) {
      const daysBack = randomInt(30, 730) - j * 120;
      const safeBack = Math.max(10, Math.abs(daysBack));
      const type: MaintenanceType = randomItem([
        MaintenanceType.SCHEDULED,
        MaintenanceType.SCHEDULED,
        MaintenanceType.BREAKDOWN,
        MaintenanceType.CALIBRATION,
        MaintenanceType.INSPECTION,
      ]);
      const descPool =
        type === "SCHEDULED"
          ? SCHEDULED_DESCRIPTIONS
          : type === "BREAKDOWN"
          ? BREAKDOWN_DESCRIPTIONS
          : type === "CALIBRATION"
          ? CALIBRATION_DESCRIPTIONS
          : INSPECTION_DESCRIPTIONS;

      // Next-due: some within next 30 days, some overdue, some future
      let nextDue: Date | null = null;
      if (type === "SCHEDULED" || type === "CALIBRATION") {
        const choice = Math.random();
        if (choice < 0.25) nextDue = daysFromNow(randomInt(-45, -1)); // overdue
        else if (choice < 0.5) nextDue = daysFromNow(randomInt(1, 30)); // next 30 days
        else nextDue = daysFromNow(randomInt(30, 365)); // future
      }

      await prisma.assetMaintenance.create({
        data: {
          assetId: a.id,
          type,
          performedAt: daysFromNow(-safeBack),
          performedBy: randomItem(technicians).id,
          vendor:
            type === "BREAKDOWN" || type === "CALIBRATION"
              ? randomItem(MAINTENANCE_VENDORS)
              : Math.random() > 0.4
              ? randomItem(MAINTENANCE_VENDORS)
              : null,
          cost:
            type === "BREAKDOWN"
              ? randomInt(2500, 45000)
              : type === "CALIBRATION"
              ? randomInt(3000, 12000)
              : randomInt(0, 8000),
          description: randomItem(descPool),
          nextDueDate: nextDue,
        },
      });
      maintenanceCreated++;
      if (type === "CALIBRATION") calibrationScheduled++;
    }

    // Set nextCalibrationAt & amcExpiryDate on asset (mix of expired/expiring/valid)
    const idxMod = idx % 4;
    const amcExpiry =
      idxMod === 0
        ? daysFromNow(-randomInt(10, 120)) // expired
        : idxMod === 1
        ? daysFromNow(randomInt(5, 30)) // expiring soon
        : daysFromNow(randomInt(60, 400)); // valid

    const nextCal =
      idxMod === 3
        ? daysFromNow(-randomInt(5, 45))
        : daysFromNow(randomInt(10, 180));

    await prisma.asset.update({
      where: { id: a.id },
      data: {
        amcProvider: a.amcProvider ?? randomItem(MAINTENANCE_VENDORS),
        amcExpiryDate: amcExpiry,
        calibrationInterval: 365,
        lastCalibrationAt: daysFromNow(-randomInt(30, 340)),
        nextCalibrationAt: nextCal,
      },
    });
    amcUpdated++;
  }

  // ─── Asset transfers (3) ──────────────────────────────
  const transferDefs = [
    { assetIdx: 3, from: "Ward A", to: "Ward C", reason: "Ward reconfiguration — re-balancing bed count" },
    { assetIdx: 8, from: "Admin office", to: "Reception", reason: "Equipment reallocation due to staff rotation" },
    { assetIdx: 12, from: "CSSD", to: "OT-2", reason: "Higher utilization requirement in OT-2" },
  ];

  for (const t of transferDefs) {
    if (!assets[t.assetIdx]) continue;
    const asset = assets[t.assetIdx];
    const existing = await prisma.assetTransfer.count({ where: { assetId: asset.id } });
    if (existing > 0) continue;

    await prisma.assetTransfer.create({
      data: {
        assetId: asset.id,
        fromLocation: asset.location ?? t.from,
        toLocation: t.to,
        fromDepartment: asset.department ?? null,
        toDepartment: t.to.includes("Ward")
          ? "Wards"
          : t.to.includes("OT")
          ? "Surgery"
          : "Operations",
        transferredBy: randomItem(technicians).id,
        reason: t.reason,
        transferredAt: daysFromNow(-randomInt(30, 180)),
      },
    });
    // Update asset location
    await prisma.asset.update({
      where: { id: asset.id },
      data: { location: t.to },
    });
    transfersCreated++;
  }

  // ─── Asset disposals (2) ──────────────────────────────
  const disposalCandidates = assets.slice(-3); // use last few (likely older)
  const disposalReasons = [
    { method: "SOLD_AS_SCRAP", value: 3500, notes: "End of useful life — sold to authorized scrap vendor" },
    { method: "E_WASTE_RECYCLING", value: 0, notes: "Obsolete IT asset — handed over to e-waste recycler with certificate" },
  ];

  for (let i = 0; i < Math.min(2, disposalCandidates.length); i++) {
    const asset = disposalCandidates[i];
    if (asset.disposedAt) continue;
    const d = disposalReasons[i];

    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: AssetStatus.RETIRED,
        disposedAt: daysFromNow(-randomInt(5, 60)),
        disposalMethod: d.method,
        disposalValue: d.value,
        disposalNotes: d.notes,
      },
    });
    disposedCount++;
  }

  console.log(`\n✔ Maintenance logs created: ${maintenanceCreated}`);
  console.log(`✔ Calibration logs:         ${calibrationScheduled}`);
  console.log(`✔ Asset transfers:          ${transfersCreated}`);
  console.log(`✔ Asset disposals:          ${disposedCount}`);
  console.log(`✔ AMC/calibration updated:  ${amcUpdated} assets`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
