/**
 * Phase 4 ops seed — blood bank (donors / donations / units), ambulance
 * fleet + trips, and asset register (with assignments and maintenance).
 *
 * Idempotency contract (2026-05-11): safe to re-run on a populated demo
 * without creating duplicate rows. Unlike its phase4 siblings, this file
 * never used `deleteMany` — the pre-2026-05-11 version was already
 * largely idempotent via `upsert`, `findUnique`, and coarse
 * `count() === 0` gates. This commit tightens the last three coarse
 * gates (AmbulanceTrip, AssetAssignment, AssetMaintenance) into
 * per-row stable-anchor guards so partial-run recovery is precise:
 *
 *   - BloodDonor: `upsert({ where: { donorNumber } })` — pre-existing.
 *   - BloodDonation: `findUnique({ where: { unitNumber } })` skip-or-
 *     create — pre-existing.
 *   - BloodUnit: per-row try/catch on `unitNumber @unique` — pre-existing.
 *   - Ambulance: `upsert({ where: { vehicleNumber } })` — pre-existing.
 *   - AmbulanceTrip (TIGHTENED 2026-05-11): per-trip `findUnique({ where:
 *     { tripNumber } })` skip-or-create. Pre-existing coarse
 *     `tripCount === 0` would have skipped seed trips entirely once any
 *     human-entered trip existed.
 *   - Asset: `upsert({ where: { assetTag } })` — pre-existing.
 *   - AssetAssignment (TIGHTENED 2026-05-11): per-row `findFirst({ where:
 *     { assetId, assignedTo } })` skip-or-create + a stable seed-marker
 *     in the notes column (`[PH4-OPS-ASSIGN-SEED-NNNN]`).
 *   - AssetMaintenance (TIGHTENED 2026-05-11): per-row `findFirst({
 *     where: { assetId, type, performedAt } })` skip-or-create. The
 *     three (assetId, type, performedAt) triples below are unique and
 *     stable (performedAt quantized to UTC midnight).
 *
 * Wired into `scripts/deploy.sh` by the orchestrator (separate commit).
 * Failures are non-fatal (matches the policy of every other deploy-time
 * fixture seed).
 */
import {
  PrismaClient,
  BloodGroupType,
  BloodComponent,
  BloodUnitStatus,
  AmbulanceStatus,
  AmbulanceTripStatus,
  AssetStatus,
  MaintenanceType,
  Gender,
  Role,
} from "@prisma/client";

const prisma = new PrismaClient();

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

// Stable per-day-offset helper that quantizes to UTC midnight, so re-runs
// at different times of day still produce the same `performedAt` and the
// (assetId, type, performedAt) findFirst anchor lands on the same row.
function daysFromNowAtMidnight(n: number): Date {
  const d = daysFromNow(n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function main() {
  console.log("=== Seeding Phase 4 Ops (Blood Bank, Ambulance, Assets) ===\n");

  // ─── Blood Donors ──────────────────────────────────────
  console.log("Creating blood donors...");

  const donorSpecs = [
    { name: "Rahul Sharma", phone: "9812300001", bloodGroup: "O_POS" as BloodGroupType, gender: "MALE" as Gender },
    { name: "Priya Patel", phone: "9812300002", bloodGroup: "A_POS" as BloodGroupType, gender: "FEMALE" as Gender },
    { name: "Amit Kumar", phone: "9812300003", bloodGroup: "B_POS" as BloodGroupType, gender: "MALE" as Gender },
    { name: "Sneha Reddy", phone: "9812300004", bloodGroup: "AB_POS" as BloodGroupType, gender: "FEMALE" as Gender },
    { name: "Vikram Singh", phone: "9812300005", bloodGroup: "O_NEG" as BloodGroupType, gender: "MALE" as Gender },
    { name: "Anjali Gupta", phone: "9812300006", bloodGroup: "A_NEG" as BloodGroupType, gender: "FEMALE" as Gender },
    { name: "Rohan Mehra", phone: "9812300007", bloodGroup: "B_NEG" as BloodGroupType, gender: "MALE" as Gender },
    { name: "Kavita Iyer", phone: "9812300008", bloodGroup: "AB_NEG" as BloodGroupType, gender: "FEMALE" as Gender },
    { name: "Sanjay Verma", phone: "9812300009", bloodGroup: "O_POS" as BloodGroupType, gender: "MALE" as Gender },
    { name: "Neha Joshi", phone: "9812300010", bloodGroup: "A_POS" as BloodGroupType, gender: "FEMALE" as Gender },
  ];

  const donors = [];
  for (let i = 0; i < donorSpecs.length; i++) {
    const spec = donorSpecs[i];
    const donorNumber = "BD" + String(i + 1).padStart(6, "0");
    const d = await prisma.bloodDonor.upsert({
      where: { donorNumber },
      update: {},
      create: {
        donorNumber,
        name: spec.name,
        phone: spec.phone,
        bloodGroup: spec.bloodGroup,
        gender: spec.gender,
        weight: 60 + (i % 5) * 5,
        isEligible: true,
      },
    });
    donors.push(d);
  }
  console.log(`  Created ${donors.length} donors`);

  // ─── Blood Donations ───────────────────────────────────
  console.log("\nCreating blood donations...");
  const donations = [];
  for (let i = 0; i < 5; i++) {
    const unitNumber = "BU" + String(i + 1).padStart(6, "0");
    const existing = await prisma.bloodDonation.findUnique({
      where: { unitNumber },
    });
    if (existing) {
      donations.push(existing);
      continue;
    }
    const donor = donors[i];
    const d = await prisma.bloodDonation.create({
      data: {
        donorId: donor.id,
        unitNumber,
        volumeMl: 450,
        donatedAt: daysFromNow(-i * 7),
        approved: true,
        screeningNotes: "All screening tests passed",
      },
    });
    donations.push(d);
  }
  console.log(`  Created ${donations.length} donations`);

  // ─── Blood Units ───────────────────────────────────────
  console.log("\nCreating blood units...");
  const groups: BloodGroupType[] = [
    "A_POS", "A_NEG", "B_POS", "B_NEG",
    "AB_POS", "AB_NEG", "O_POS", "O_NEG",
  ];
  const components: BloodComponent[] = [
    "PACKED_RED_CELLS",
    "PLATELETS",
    "FRESH_FROZEN_PLASMA",
    "WHOLE_BLOOD",
  ];

  let unitCount = 0;
  const existingUnits = await prisma.bloodUnit.count();
  if (existingUnits < 30) {
    for (let i = 0; i < 30; i++) {
      const group = groups[i % groups.length];
      const component = components[i % components.length];
      const collectedAt = daysFromNow(-(i % 10));
      const expiryDays = component === "PLATELETS" ? 5 : component === "FRESH_FROZEN_PLASMA" ? 365 : 42;
      const expiresAt = new Date(
        collectedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000
      );
      const unitNumber = `BUNIT-${String(i + 1).padStart(4, "0")}`;
      try {
        await prisma.bloodUnit.create({
          data: {
            unitNumber,
            bloodGroup: group,
            component,
            volumeMl: component === "PLATELETS" ? 250 : 450,
            collectedAt,
            expiresAt,
            status: "AVAILABLE" as BloodUnitStatus,
            storageLocation: `Shelf ${(i % 4) + 1}`,
          },
        });
        unitCount++;
      } catch {
        // already exists
      }
    }
  }
  console.log(`  Created ${unitCount} blood units (total in DB: ${await prisma.bloodUnit.count()})`);

  // ─── Ambulances ────────────────────────────────────────
  console.log("\nCreating ambulances...");
  const ambSpecs = [
    { vehicleNumber: "AMB-001", type: "BLS", driverName: "Ramesh Kumar", driverPhone: "9876543210", paramedicName: "Suresh N." },
    { vehicleNumber: "AMB-002", type: "ALS", driverName: "Mahesh Singh", driverPhone: "9876543211", paramedicName: "Deepa M." },
    { vehicleNumber: "AMB-003", type: "ICU", driverName: "Rajesh Verma", driverPhone: "9876543212", paramedicName: "Karthik S." },
    { vehicleNumber: "AMB-004", type: "Patient Transport", driverName: "Naresh Gupta", driverPhone: "9876543213" },
  ];

  type AmbulanceRow = Awaited<ReturnType<typeof prisma.ambulance.upsert>>;
  const ambulances: AmbulanceRow[] = [];
  for (let i = 0; i < ambSpecs.length; i++) {
    const spec = ambSpecs[i];
    const a = await prisma.ambulance.upsert({
      where: { vehicleNumber: spec.vehicleNumber },
      update: {},
      create: {
        ...spec,
        make: "Force",
        model: "Traveller",
        status: i === 0 ? ("ON_TRIP" as AmbulanceStatus) : ("AVAILABLE" as AmbulanceStatus),
      },
    });
    ambulances.push(a);
  }
  console.log(`  Created ${ambulances.length} ambulances`);

  // ─── Ambulance Trips ───────────────────────────────────
  console.log("\nCreating ambulance trips...");
  const patient = await prisma.patient.findFirst();

  // Per-trip findUnique on stable tripNumber. Pre-2026-05-11 used a
  // coarse `tripCount === 0` gate which would have skipped seed trips
  // entirely once any human-entered trip existed.
  const tripSpecs: Array<{
    tripNumber: string;
    build: () => Parameters<typeof prisma.ambulanceTrip.create>[0]["data"];
  }> = [
    {
      tripNumber: "TRP000001",
      build: () => ({
        tripNumber: "TRP000001",
        ambulanceId: ambulances[1].id,
        patientId: patient?.id,
        pickupAddress: "123 MG Road, Bengaluru",
        dropAddress: "MedCore Hospital",
        chiefComplaint: "Chest pain",
        status: "COMPLETED" as AmbulanceTripStatus,
        requestedAt: daysFromNow(-3),
        dispatchedAt: daysFromNow(-3),
        arrivedAt: daysFromNow(-3),
        completedAt: daysFromNow(-3),
        distanceKm: 12.5,
        cost: 1200,
      }),
    },
    {
      tripNumber: "TRP000002",
      build: () => ({
        tripNumber: "TRP000002",
        ambulanceId: ambulances[0].id,
        callerName: "Mohan Rao",
        callerPhone: "9900011122",
        pickupAddress: "Apartment 302, Whitefield",
        chiefComplaint: "Fall injury",
        status: "EN_ROUTE_HOSPITAL" as AmbulanceTripStatus,
        requestedAt: new Date(Date.now() - 30 * 60 * 1000),
        dispatchedAt: new Date(Date.now() - 25 * 60 * 1000),
        arrivedAt: new Date(Date.now() - 15 * 60 * 1000),
      }),
    },
    {
      tripNumber: "TRP000003",
      build: () => ({
        tripNumber: "TRP000003",
        ambulanceId: ambulances[2].id,
        callerName: "Lakshmi Devi",
        callerPhone: "9900011133",
        pickupAddress: "HSR Layout",
        chiefComplaint: "Breathing difficulty",
        status: "REQUESTED" as AmbulanceTripStatus,
      }),
    },
  ];

  let tripsCreated = 0;
  let tripsSkipped = 0;
  for (const t of tripSpecs) {
    const existing = await prisma.ambulanceTrip.findUnique({
      where: { tripNumber: t.tripNumber },
    });
    if (existing) {
      tripsSkipped++;
      continue;
    }
    await prisma.ambulanceTrip.create({ data: t.build() });
    tripsCreated++;
  }
  console.log(`  Trips: ${tripsCreated} created, ${tripsSkipped} skipped`);

  // ─── Assets ────────────────────────────────────────────
  console.log("\nCreating assets...");
  const assetSpecs = [
    { assetTag: "AST-001", name: "X-Ray Machine", category: "Medical Equipment", manufacturer: "Siemens", modelNumber: "Multix-Fusion", location: "Radiology-1", purchaseCost: 2500000 },
    { assetTag: "AST-002", name: "Ultrasound Scanner", category: "Medical Equipment", manufacturer: "GE", modelNumber: "Voluson-S10", location: "Radiology-2", purchaseCost: 1500000 },
    { assetTag: "AST-003", name: "ECG Machine", category: "Medical Equipment", manufacturer: "Philips", modelNumber: "PageWriter-TC30", location: "Cardiology", purchaseCost: 150000 },
    { assetTag: "AST-004", name: "Hospital Bed #1", category: "Furniture", manufacturer: "Godrej", location: "Ward A", purchaseCost: 35000 },
    { assetTag: "AST-005", name: "Hospital Bed #2", category: "Furniture", manufacturer: "Godrej", location: "Ward A", purchaseCost: 35000 },
    { assetTag: "AST-006", name: "Hospital Bed #3", category: "Furniture", manufacturer: "Godrej", location: "Ward B", purchaseCost: 35000 },
    { assetTag: "AST-007", name: "Hospital Bed #4", category: "Furniture", manufacturer: "Godrej", location: "Ward B", purchaseCost: 35000 },
    { assetTag: "AST-008", name: "Hospital Bed #5", category: "Furniture", manufacturer: "Godrej", location: "Private-1", purchaseCost: 55000 },
    { assetTag: "AST-009", name: "Laptop - Admin", category: "IT", manufacturer: "Dell", modelNumber: "Latitude 5430", location: "Admin office", purchaseCost: 65000 },
    { assetTag: "AST-010", name: "Laptop - Reception", category: "IT", manufacturer: "Lenovo", modelNumber: "ThinkPad L14", location: "Reception", purchaseCost: 60000 },
    { assetTag: "AST-011", name: "Laptop - Doctor", category: "IT", manufacturer: "HP", modelNumber: "ProBook 450", location: "OPD-1", purchaseCost: 58000 },
    { assetTag: "AST-012", name: "Printer - MFP", category: "IT", manufacturer: "Canon", modelNumber: "imageCLASS MF445dw", location: "Reception", purchaseCost: 35000 },
    { assetTag: "AST-013", name: "Autoclave", category: "Medical Equipment", manufacturer: "Equitron", location: "CSSD", purchaseCost: 180000 },
    { assetTag: "AST-014", name: "Suction Machine", category: "Medical Equipment", manufacturer: "Allied", location: "ICU", purchaseCost: 45000 },
    { assetTag: "AST-015", name: "Defibrillator", category: "Medical Equipment", manufacturer: "Philips", modelNumber: "HeartStart FR3", location: "Emergency", purchaseCost: 220000 },
  ];

  const assets = [];
  for (let i = 0; i < assetSpecs.length; i++) {
    const spec = assetSpecs[i];
    // Issue #59 (Apr 2026): an asset's "is it actually in service" status
    // should follow its location. The Emergency-room defibrillator is
    // permanently deployed (always plugged in, ready) — seeding it as IDLE
    // misled the asset dashboard into thinking it was a spare. Likewise the
    // Cardiology ECG, the ICU suction, the CSSD autoclave, and Radiology's
    // X-Ray + Ultrasound are all permanently deployed in their bays.
    const inServiceLocations = new Set([
      "Emergency",
      "ICU",
      "Cardiology",
      "Radiology-1",
      "Radiology-2",
      "CSSD",
    ]);
    const isInService =
      spec.category === "Medical Equipment" &&
      typeof spec.location === "string" &&
      inServiceLocations.has(spec.location);
    // Issue #59: department should reflect physical location for clinical
    // gear so the per-department asset roll-up isn't all "Clinical".
    const department =
      spec.category === "IT"
        ? "IT"
        : spec.category === "Furniture"
          ? "Wards"
          : spec.location === "Emergency"
            ? "Emergency"
            : spec.location === "ICU"
              ? "ICU"
              : spec.location === "Cardiology"
                ? "Cardiology"
                : spec.location?.startsWith("Radiology")
                  ? "Radiology"
                  : spec.location === "CSSD"
                    ? "CSSD"
                    : "Clinical";
    const a = await prisma.asset.upsert({
      where: { assetTag: spec.assetTag },
      update: {
        // Idempotent re-seed: keep status/department in sync if the rules
        // above change. We do NOT clobber a manually-changed status (we only
        // upgrade IDLE→IN_USE for our deployed-by-default rule).
        ...(isInService ? { status: "IN_USE" as AssetStatus } : {}),
        department,
      },
      create: {
        ...spec,
        purchaseDate: daysFromNow(-(400 + i * 10)),
        warrantyExpiry: daysFromNow(i < 3 ? 20 : 365 + i * 10),
        status: (isInService ? "IN_USE" : "IDLE") as AssetStatus,
        department,
      },
    });
    assets.push(a);
  }
  console.log(`  Created ${assets.length} assets`);

  // ─── Asset Assignments ─────────────────────────────────
  console.log("\nCreating asset assignments...");
  const assignableUsers = await prisma.user.findMany({
    where: { role: { in: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] } },
    take: 5,
  });

  if (assignableUsers.length > 0) {
    // Pre-2026-05-11 used a coarse `existingAssignments === 0` gate which
    // would have skipped seed assignments entirely once any human-entered
    // assignment existed. Replaced with per-row findFirst on
    // (assetId, assignedTo) + a stable seed-marker in the notes column
    // so re-runs precisely land on the same rows.
    const laptopAssets = assets.filter((a) => a.category === "IT").slice(0, 3);
    const otherAssets = [assets[12], assets[13]]; // autoclave, suction
    const toAssign = [...laptopAssets, ...otherAssets].filter(Boolean);

    let assignsCreated = 0;
    let assignsSkipped = 0;
    for (let i = 0; i < toAssign.length && i < assignableUsers.length; i++) {
      const asset = toAssign[i];
      const user = assignableUsers[i];

      const existing = await prisma.assetAssignment.findFirst({
        where: { assetId: asset.id, assignedTo: user.id },
      });
      if (existing) {
        assignsSkipped++;
        continue;
      }

      await prisma.assetAssignment.create({
        data: {
          assetId: asset.id,
          assignedTo: user.id,
          location: asset.location,
          notes: `[PH4-OPS-ASSIGN-SEED-${String(i + 1).padStart(4, "0")}] Initial assignment from seed`,
        },
      });
      await prisma.asset.update({
        where: { id: asset.id },
        data: { status: "IN_USE" as AssetStatus },
      });
      assignsCreated++;
    }
    console.log(`  Asset assignments: ${assignsCreated} created, ${assignsSkipped} skipped`);
  }

  // ─── Asset Maintenance Logs ────────────────────────────
  console.log("\nCreating maintenance logs...");
  const technician = assignableUsers[0];
  if (technician) {
    // Per-row findFirst on (assetId, type, performedAt). The three
    // triples below are unique and stable (performedAt quantized to UTC
    // midnight so re-runs at different times of day hit the same row).
    const maintSpecs: Array<{
      assetId: string;
      type: MaintenanceType;
      performedAt: Date;
      data: Parameters<typeof prisma.assetMaintenance.create>[0]["data"];
    }> = [
      {
        assetId: assets[0].id, // X-Ray
        type: "CALIBRATION" as MaintenanceType,
        performedAt: daysFromNowAtMidnight(-60),
        data: {
          assetId: assets[0].id,
          type: "CALIBRATION" as MaintenanceType,
          performedBy: technician.id,
          vendor: "Siemens Service",
          cost: 15000,
          description: "Annual calibration and tube inspection",
          performedAt: daysFromNowAtMidnight(-60),
          nextDueDate: daysFromNowAtMidnight(305),
        },
      },
      {
        assetId: assets[12].id, // Autoclave
        type: "SCHEDULED" as MaintenanceType,
        performedAt: daysFromNowAtMidnight(-30),
        data: {
          assetId: assets[12].id,
          type: "SCHEDULED" as MaintenanceType,
          performedBy: technician.id,
          vendor: "Equitron Services",
          cost: 5000,
          description: "Quarterly preventive maintenance",
          performedAt: daysFromNowAtMidnight(-30),
          nextDueDate: daysFromNowAtMidnight(60),
        },
      },
      {
        assetId: assets[14].id, // Defibrillator
        type: "INSPECTION" as MaintenanceType,
        performedAt: daysFromNowAtMidnight(-10),
        data: {
          assetId: assets[14].id,
          type: "INSPECTION" as MaintenanceType,
          performedBy: technician.id,
          vendor: "Philips Healthcare",
          cost: 2500,
          description: "Battery replacement and self-test",
          performedAt: daysFromNowAtMidnight(-10),
          nextDueDate: daysFromNowAtMidnight(80),
        },
      },
    ];

    let maintCreated = 0;
    let maintSkipped = 0;
    for (const m of maintSpecs) {
      const existing = await prisma.assetMaintenance.findFirst({
        where: {
          assetId: m.assetId,
          type: m.type,
          performedAt: m.performedAt,
        },
      });
      if (existing) {
        maintSkipped++;
        continue;
      }
      await prisma.assetMaintenance.create({ data: m.data });
      maintCreated++;
    }
    console.log(`  Maintenance logs: ${maintCreated} created, ${maintSkipped} skipped`);
  }

  console.log("\n=== Phase 4 Ops seeding complete ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
