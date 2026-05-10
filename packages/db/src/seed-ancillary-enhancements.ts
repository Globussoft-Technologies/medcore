/**
 * Seeds additional realistic data for the Ancillary Services enhancements:
 *  - Lab reference ranges (age/gender) + lab results
 *  - Inventory items with barcodes, reorder levels, batch numbers
 *  - Drug interactions, pregnancy categories, pediatric doses
 *  - Blood screening records
 *  - Ambulance trips + fuel logs
 *  - Asset warranty/AMC + maintenance + calibration data
 *
 * Run: tsx packages/db/src/seed-ancillary-enhancements.ts
 *
 * Idempotency contract (2026-05-11): safe to re-run on a populated demo
 * without creating duplicate rows.
 *   - LabTest, LabTestReferenceRange, InventoryItem(@@unique medicineId+batchNumber),
 *     DrugInteraction(@@unique drugA+drugB), BloodScreening(donationId @unique),
 *     LabResult(per orderItemId) already guarded via findUnique/findFirst.
 *   - AmbulanceTrip: now uses stable namespaced tripNumber
 *     `TRP-SEED-NNNN` (was reading the live TRP###### counter — removed).
 *   - AmbulanceFuelLog and BloodTemperatureLog (no natural unique key): we
 *     skip the section entirely if any fuel log / temperature log already
 *     exists for that ambulance / location (so re-runs are no-ops).
 *   - AssetMaintenance (no natural unique key): skip per-asset if any
 *     maintenance log already exists for that asset.
 *   - Math.random() replaced by fixed-seed mulberry32 PRNG so re-runs
 *     produce byte-identical decisions.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Deterministic mulberry32 PRNG — same fixed-seed pattern as
// seed-realistic.ts so re-runs of the partial set produce the same
// downstream decisions for which lab values are abnormal / critical,
// which donations fail screening, ambulance fuel litres, etc.
const SEED_RNG = 0xa5c11051;
let _rngState = SEED_RNG;
function rng(): number {
  _rngState |= 0;
  _rngState = (_rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 3600 * 1000);
}

function daysAgo(days: number): Date {
  return daysFromNow(-days);
}

async function seedLab() {
  console.log("Seeding lab enhancements...");

  // Upsert common tests with panic thresholds, units, TAT
  const tests = [
    {
      code: "RBS",
      name: "Random Blood Sugar",
      category: "Biochemistry",
      price: 150,
      sampleType: "Blood",
      unit: "mg/dL",
      panicLow: 50,
      panicHigh: 400,
      tatHours: 2,
      normalRange: "70-140 mg/dL",
    },
    {
      code: "TSH",
      name: "Thyroid Stimulating Hormone",
      category: "Endocrinology",
      price: 400,
      sampleType: "Blood",
      unit: "mIU/L",
      panicLow: 0.1,
      panicHigh: 20,
      tatHours: 24,
      normalRange: "0.4-4.0 mIU/L",
    },
    {
      code: "CBC",
      name: "Complete Blood Count",
      category: "Hematology",
      price: 300,
      sampleType: "Blood (EDTA)",
      unit: "",
      tatHours: 4,
      normalRange: "See component ranges",
    },
    {
      code: "HB",
      name: "Hemoglobin",
      category: "Hematology",
      price: 100,
      sampleType: "Blood",
      unit: "g/dL",
      panicLow: 7,
      panicHigh: 20,
      tatHours: 2,
      normalRange: "13-17 M / 12-15 F",
    },
    {
      code: "SCR",
      name: "Serum Creatinine",
      category: "Biochemistry",
      price: 200,
      sampleType: "Blood",
      unit: "mg/dL",
      panicHigh: 5,
      tatHours: 4,
      normalRange: "0.6-1.3 mg/dL",
    },
    {
      code: "NA",
      name: "Sodium",
      category: "Electrolytes",
      price: 150,
      sampleType: "Blood",
      unit: "mEq/L",
      panicLow: 125,
      panicHigh: 155,
      tatHours: 2,
      normalRange: "135-145 mEq/L",
    },
    {
      code: "K",
      name: "Potassium",
      category: "Electrolytes",
      price: 150,
      sampleType: "Blood",
      unit: "mEq/L",
      panicLow: 2.5,
      panicHigh: 6.0,
      tatHours: 2,
      normalRange: "3.5-5.0 mEq/L",
    },
    {
      code: "WBC",
      name: "White Blood Cell Count",
      category: "Hematology",
      price: 120,
      sampleType: "Blood",
      unit: "10^3/uL",
      panicLow: 2,
      panicHigh: 30,
      tatHours: 4,
      normalRange: "4-11 x 10^3/uL",
    },
    {
      code: "PLT",
      name: "Platelet Count",
      category: "Hematology",
      price: 120,
      sampleType: "Blood",
      unit: "10^3/uL",
      panicLow: 50,
      panicHigh: 1000,
      tatHours: 4,
      normalRange: "150-450 x 10^3/uL",
    },
    {
      code: "HBA1C",
      name: "HbA1c (Glycated Hemoglobin)",
      category: "Biochemistry",
      price: 500,
      sampleType: "Blood",
      unit: "%",
      tatHours: 48,
      normalRange: "<5.7% normal",
    },
  ];

  const createdTests: Record<string, string> = {};
  for (const t of tests) {
    const saved = await prisma.labTest.upsert({
      where: { code: t.code },
      create: t,
      update: {
        unit: t.unit,
        panicLow: t.panicLow ?? null,
        panicHigh: t.panicHigh ?? null,
        tatHours: t.tatHours ?? null,
      },
    });
    createdTests[t.code] = saved.id;
  }

  // Reference ranges per age/gender
  const ranges: Array<{
    code: string;
    parameter?: string;
    gender?: "MALE" | "FEMALE" | null;
    ageMin?: number;
    ageMax?: number;
    low: number;
    high: number;
    unit: string;
  }> = [
    // Hemoglobin
    { code: "HB", gender: "MALE", ageMin: 18, ageMax: 65, low: 13.5, high: 17.5, unit: "g/dL" },
    { code: "HB", gender: "FEMALE", ageMin: 18, ageMax: 65, low: 12.0, high: 15.5, unit: "g/dL" },
    { code: "HB", ageMin: 1, ageMax: 6, low: 11.0, high: 14.0, unit: "g/dL" },
    { code: "HB", ageMin: 6, ageMax: 12, low: 11.5, high: 15.5, unit: "g/dL" },
    { code: "HB", ageMin: 0, ageMax: 1, low: 10.5, high: 13.5, unit: "g/dL" },
    // TSH
    { code: "TSH", ageMin: 18, ageMax: 120, low: 0.4, high: 4.0, unit: "mIU/L" },
    { code: "TSH", ageMin: 0, ageMax: 18, low: 0.7, high: 6.0, unit: "mIU/L" },
    // Creatinine
    { code: "SCR", gender: "MALE", ageMin: 18, ageMax: 120, low: 0.7, high: 1.3, unit: "mg/dL" },
    { code: "SCR", gender: "FEMALE", ageMin: 18, ageMax: 120, low: 0.6, high: 1.1, unit: "mg/dL" },
    // RBS
    { code: "RBS", ageMin: 0, ageMax: 120, low: 70, high: 140, unit: "mg/dL" },
    // Na / K
    { code: "NA", ageMin: 0, ageMax: 120, low: 135, high: 145, unit: "mEq/L" },
    { code: "K", ageMin: 0, ageMax: 120, low: 3.5, high: 5.0, unit: "mEq/L" },
    // WBC
    { code: "WBC", ageMin: 18, ageMax: 120, low: 4, high: 11, unit: "10^3/uL" },
    { code: "WBC", ageMin: 0, ageMax: 18, low: 5, high: 15, unit: "10^3/uL" },
    // PLT
    { code: "PLT", ageMin: 0, ageMax: 120, low: 150, high: 450, unit: "10^3/uL" },
    // HbA1c diagnostic bands
    { code: "HBA1C", ageMin: 0, ageMax: 120, low: 4.0, high: 5.6, unit: "%" },
  ];

  for (const r of ranges) {
    const testId = createdTests[r.code];
    if (!testId) continue;
    // Check if already exists
    const existing = await prisma.labTestReferenceRange.findFirst({
      where: {
        testId,
        parameter: r.parameter ?? null,
        gender: r.gender ?? null,
        ageMin: r.ageMin ?? null,
        ageMax: r.ageMax ?? null,
      },
    });
    if (!existing) {
      await prisma.labTestReferenceRange.create({
        data: {
          testId,
          parameter: r.parameter,
          gender: r.gender ?? null,
          ageMin: r.ageMin ?? null,
          ageMax: r.ageMax ?? null,
          low: r.low,
          high: r.high,
          unit: r.unit,
        },
      });
    }
  }

  // Add lab results to recent orders
  const recentOrders = await prisma.labOrder.findMany({
    take: 5,
    orderBy: { orderedAt: "desc" },
    include: { items: { include: { test: true } } },
  });

  const anyUser = await prisma.user.findFirst({ where: { role: "NURSE" } });
  if (!anyUser) return;

  let totalResults = 0;
  for (const order of recentOrders) {
    for (const item of order.items) {
      // Skip if already has results
      const existing = await prisma.labResult.count({
        where: { orderItemId: item.id },
      });
      if (existing > 0) continue;

      const code = item.test.code;
      let param = item.test.name;
      let value = "";
      let unit = item.test.unit || "";
      let flag: "NORMAL" | "LOW" | "HIGH" | "CRITICAL" = "NORMAL";
      let normalRange = item.test.normalRange || "";

      // Inject a mix of normal/abnormal — deterministic via mulberry32.
      const abnormal = rng() < 0.4;
      const critical = rng() < 0.1;
      switch (code) {
        case "RBS":
          value = critical ? "38" : abnormal ? "210" : "98";
          flag = critical ? "CRITICAL" : abnormal ? "HIGH" : "NORMAL";
          break;
        case "HB":
          value = abnormal ? "9.5" : "14.2";
          flag = abnormal ? "LOW" : "NORMAL";
          break;
        case "TSH":
          value = critical ? "25.5" : abnormal ? "6.2" : "1.8";
          flag = critical ? "CRITICAL" : abnormal ? "HIGH" : "NORMAL";
          break;
        case "SCR":
          value = abnormal ? "2.1" : "1.0";
          flag = abnormal ? "HIGH" : "NORMAL";
          break;
        case "K":
          value = critical ? "6.8" : abnormal ? "5.4" : "4.2";
          flag = critical ? "CRITICAL" : abnormal ? "HIGH" : "NORMAL";
          break;
        case "NA":
          value = abnormal ? "132" : "140";
          flag = abnormal ? "LOW" : "NORMAL";
          break;
        case "WBC":
          value = abnormal ? "13.5" : "7.2";
          flag = abnormal ? "HIGH" : "NORMAL";
          break;
        case "PLT":
          value = abnormal ? "120" : "245";
          flag = abnormal ? "LOW" : "NORMAL";
          break;
        case "HBA1C":
          value = abnormal ? "8.1" : "5.3";
          flag = abnormal ? "HIGH" : "NORMAL";
          break;
        default:
          value = "Normal";
          flag = "NORMAL";
      }

      await prisma.labResult.create({
        data: {
          orderItemId: item.id,
          parameter: param,
          value,
          unit,
          normalRange,
          flag,
          enteredBy: anyUser.id,
        },
      });
      totalResults++;

      await prisma.labOrderItem.update({
        where: { id: item.id },
        data: { status: "COMPLETED" },
      });
    }

    // Mark order COMPLETED if not already
    await prisma.labOrder.update({
      where: { id: order.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  }
  console.log(`  ✓ Lab tests upserted + ${ranges.length} ranges + ${totalResults} results`);
}

async function seedPharmacy() {
  console.log("Seeding pharmacy enhancements...");

  // Find an existing supplier or keep null
  const meds = await prisma.medicine.findMany({ take: 20, orderBy: { name: "asc" } });
  if (meds.length === 0) {
    console.log("  No medicines present; skipping inventory seed");
    return;
  }

  let count = 0;
  for (let i = 0; i < Math.min(20, meds.length); i++) {
    const m = meds[i];
    const batchNumber = `BATCH${String(2000 + i)}`;
    const existing = await prisma.inventoryItem.findUnique({
      where: { medicineId_batchNumber: { medicineId: m.id, batchNumber } },
    });
    if (existing) continue;
    await prisma.inventoryItem.create({
      data: {
        medicineId: m.id,
        batchNumber,
        quantity: 50 + Math.floor(rng() * 300),
        unitCost: parseFloat((5 + rng() * 95).toFixed(2)),
        sellingPrice: parseFloat((10 + rng() * 140).toFixed(2)),
        expiryDate: daysFromNow(180 + i * 30),
        reorderLevel: 25,
        reorderQuantity: 100,
        barcode: `890${String(1000000 + i * 137).padStart(10, "0")}`,
        location: `Rack-${String.fromCharCode(65 + (i % 5))}${(i % 8) + 1}`,
      },
    });
    count++;
  }

  // Mark a couple of medicines as narcotic
  const narcoticNames = ["Morphine", "Pethidine", "Tramadol", "Fentanyl"];
  for (const name of narcoticNames) {
    await prisma.medicine.updateMany({
      where: { name: { contains: name, mode: "insensitive" } },
      data: { isNarcotic: true, schedule: "H1" },
    });
  }

  // Set pregnancy categories & pediatric doses on key meds
  await prisma.medicine.updateMany({
    where: { name: { contains: "Paracetamol", mode: "insensitive" } },
    data: {
      pregnancyCategory: "B",
      pediatricDoseMgPerKg: 15,
      maxDailyDoseMg: 4000,
    },
  });
  await prisma.medicine.updateMany({
    where: { name: { contains: "Ibuprofen", mode: "insensitive" } },
    data: {
      pregnancyCategory: "C",
      pediatricDoseMgPerKg: 10,
      maxDailyDoseMg: 2400,
    },
  });
  await prisma.medicine.updateMany({
    where: { name: { contains: "Amoxicillin", mode: "insensitive" } },
    data: { pregnancyCategory: "B", pediatricDoseMgPerKg: 25, maxDailyDoseMg: 3000 },
  });
  await prisma.medicine.updateMany({
    where: { name: { contains: "Warfarin", mode: "insensitive" } },
    data: { pregnancyCategory: "X" },
  });
  await prisma.medicine.updateMany({
    where: { name: { contains: "Atorvastatin", mode: "insensitive" } },
    data: { pregnancyCategory: "X" },
  });
  await prisma.medicine.updateMany({
    where: { name: { contains: "Enalapril", mode: "insensitive" } },
    data: { pregnancyCategory: "D" },
  });

  // Add some drug interactions (skip duplicates)
  const pairs: Array<[string, string, string, string]> = [
    ["Warfarin", "Aspirin", "SEVERE", "Increased bleeding risk"],
    ["Warfarin", "Ibuprofen", "SEVERE", "Increased bleeding and GI risk"],
    ["Clopidogrel", "Omeprazole", "MODERATE", "Reduced antiplatelet effect"],
    ["Metformin", "Atorvastatin", "MILD", "Monitor LFTs"],
    ["Amoxicillin", "Warfarin", "MODERATE", "May enhance anticoagulant effect"],
    ["Ciprofloxacin", "Warfarin", "SEVERE", "Significantly enhances warfarin effect"],
    ["Enalapril", "Losartan", "CONTRAINDICATED", "Dual RAAS blockade"],
    ["Ondansetron", "Azithromycin", "MODERATE", "QT prolongation risk"],
  ];

  let interactionsAdded = 0;
  for (const [a, b, sev, desc] of pairs) {
    const ma = await prisma.medicine.findFirst({
      where: { name: { contains: a, mode: "insensitive" } },
    });
    const mb = await prisma.medicine.findFirst({
      where: { name: { contains: b, mode: "insensitive" } },
    });
    if (!ma || !mb) continue;
    try {
      await prisma.drugInteraction.create({
        data: { drugAId: ma.id, drugBId: mb.id, severity: sev, description: desc },
      });
      interactionsAdded++;
    } catch {
      // duplicate - ignore
    }
  }

  console.log(`  ✓ ${count} inventory items + ${interactionsAdded} drug interactions`);
}

async function seedBloodBank() {
  console.log("Seeding blood bank enhancements...");

  const donations = await prisma.bloodDonation.findMany({
    where: { approved: true },
    take: 15,
    orderBy: { donatedAt: "desc" },
  });

  const anyUser = await prisma.user.findFirst({ where: { role: "DOCTOR" } });
  if (!anyUser) {
    console.log("  No doctor user present; skipping screening seed");
    return;
  }

  let screens = 0;
  for (const d of donations) {
    const exists = await prisma.bloodScreening.findUnique({
      where: { donationId: d.id },
    });
    if (exists) continue;
    // 90% pass, 10% deterministic-positive — driven by mulberry32 so re-runs
    // produce byte-identical screening verdicts.
    const fail = rng() < 0.1;
    const positive = () => (rng() < 0.5 ? "POSITIVE" : "INDETERMINATE");
    await prisma.bloodScreening.create({
      data: {
        donationId: d.id,
        hivResult: fail ? positive() : "NEGATIVE",
        hcvResult: "NEGATIVE",
        hbsAgResult: fail && rng() > 0.5 ? positive() : "NEGATIVE",
        syphilisResult: "NEGATIVE",
        malariaResult: "NEGATIVE",
        bloodGrouping: "Confirmed",
        method: "ELISA",
        passed: !fail,
        screenedBy: anyUser.id,
      },
    });
    screens++;
  }

  // Temperature log entries — BloodTemperatureLog has no natural unique
  // key. We skip the section per-location if any log already exists for
  // that location, so re-runs are no-ops without duping rows.
  const locations = ["Fridge A (RBC)", "Fridge B (RBC)", "Freezer Plasma-1"];
  let temps = 0;
  let tempsSkipped = 0;
  for (const loc of locations) {
    const existingTempCount = await prisma.bloodTemperatureLog.count({
      where: { location: loc },
    });
    if (existingTempCount > 0) {
      tempsSkipped++;
      // Burn 15 rng rolls (5 iters * 3 rolls each) to keep downstream
      // decisions aligned with the original run when only some locations
      // were inserted.
      for (let k = 0; k < 5 * 3; k++) rng();
      continue;
    }
    for (let i = 0; i < 5; i++) {
      const base = loc.includes("Freezer") ? -30 : 4;
      const variance = (rng() - 0.5) * 3;
      const temp = base + variance;
      const inRange = loc.includes("Freezer") ? temp <= -18 : temp >= 2 && temp <= 6;
      await prisma.bloodTemperatureLog.create({
        data: {
          location: loc,
          temperature: Math.round(temp * 10) / 10,
          inRange,
          recordedBy: anyUser.id,
          recordedAt: daysAgo(i),
        },
      });
      temps++;
    }
  }

  console.log(
    `  ✓ ${screens} screenings + ${temps} temperature logs (skipped ${tempsSkipped} locations already populated)`,
  );
}

async function seedAmbulance() {
  console.log("Seeding ambulance enhancements...");

  const ambulances = await prisma.ambulance.findMany({ take: 3 });
  const anyUser = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (ambulances.length === 0 || !anyUser) {
    console.log("  No ambulances/admin; skipping");
    return;
  }

  // Fuel logs — AmbulanceFuelLog has no natural unique key. Skip the
  // 3-row insert per ambulance if any fuel log already exists for it.
  let fuels = 0;
  let fuelsSkipped = 0;
  for (const amb of ambulances) {
    const existingFuel = await prisma.ambulanceFuelLog.count({
      where: { ambulanceId: amb.id },
    });
    if (existingFuel > 0) {
      fuelsSkipped++;
      // Burn 6 rng rolls (3 iters * 2 rolls each) to keep alignment.
      for (let k = 0; k < 3 * 2; k++) rng();
      continue;
    }
    for (let i = 0; i < 3; i++) {
      const litres = 20 + rng() * 30;
      await prisma.ambulanceFuelLog.create({
        data: {
          ambulanceId: amb.id,
          litres: Math.round(litres * 10) / 10,
          costTotal: Math.round(litres * 100 * 100) / 100,
          odometerKm: 10000 + Math.floor(rng() * 20000),
          stationName: ["HP", "IOC", "Shell", "BP"][i % 4],
          filledAt: daysAgo(i * 7),
          filledBy: anyUser.id,
        },
      });
      fuels++;
    }
  }

  // Extra trips — stable seed-id namespace via TRP-SEED-NNNN, never
  // touches the live TRP###### counter (used by runtime allocator).
  let trips = 0;
  let tripsSkipped = 0;
  for (let i = 0; i < 5; i++) {
    const tripNumber = `TRP-SEED-${String(i + 1).padStart(4, "0")}`;
    const existingTrip = await prisma.ambulanceTrip.findUnique({
      where: { tripNumber },
      select: { id: true },
    });
    if (existingTrip) {
      tripsSkipped++;
      // Burn 4 rng rolls (pickupLat, pickupLng, distanceKm, cost) to
      // keep downstream alignment.
      for (let k = 0; k < 4; k++) rng();
      continue;
    }
    const amb = ambulances[i % ambulances.length];
    const isCompleted = i < 3;
    await prisma.ambulanceTrip.create({
      data: {
        tripNumber,
        ambulanceId: amb.id,
        callerName: ["Raj", "Sita", "Amit", "Kiran", "Priya"][i],
        callerPhone: `98${String(10000000 + i * 12345).padStart(8, "0")}`,
        pickupAddress: [
          "Andheri East",
          "Bandra West",
          "Powai Lake Road",
          "Malad West",
          "Kurla Station",
        ][i],
        pickupLat: 19.0 + rng() * 0.2,
        pickupLng: 72.8 + rng() * 0.2,
        dropAddress: "MedCore Hospital, Main Campus",
        dropLat: 19.12,
        dropLng: 72.86,
        distanceKm: isCompleted ? 5 + rng() * 20 : null,
        chiefComplaint: ["Chest pain", "Trauma - RTA", "Breathing difficulty", "Pregnancy labor", "Fever + seizure"][i],
        priority: ["RED", "RED", "YELLOW", "YELLOW", "GREEN"][i],
        equipmentChecked: true,
        equipmentNotes: "Oxygen OK, Defib OK, Stretcher OK, First-aid kit full",
        requestedAt: daysAgo(i),
        dispatchedAt: isCompleted ? daysAgo(i) : daysAgo(0),
        arrivedAt: isCompleted ? daysAgo(i) : null,
        completedAt: isCompleted ? daysAgo(i) : null,
        status: isCompleted ? "COMPLETED" : "EN_ROUTE_HOSPITAL",
        cost: isCompleted ? 1500 + rng() * 1500 : null,
      },
    });
    trips++;
  }

  console.log(
    `  ✓ ${fuels} fuel logs (skipped ${fuelsSkipped} ambulances) + ${trips} extra trips (skipped ${tripsSkipped} already present)`,
  );
}

async function seedAssets() {
  console.log("Seeding asset enhancements...");

  const assets = await prisma.asset.findMany({ take: 10 });
  const anyUser = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (assets.length === 0 || !anyUser) {
    console.log("  No assets/admin; skipping");
    return;
  }

  // Set warranty / AMC / depreciation for 10 assets
  let updated = 0;
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const purchaseDate = a.purchaseDate ?? daysAgo(365 * (1 + (i % 4)));
    const purchaseCost = a.purchaseCost ?? 50000 + i * 25000;
    await prisma.asset.update({
      where: { id: a.id },
      data: {
        purchaseDate,
        purchaseCost,
        salvageValue: Math.round(purchaseCost * 0.1),
        usefulLifeYears: 5 + (i % 6),
        depreciationMethod: "STRAIGHT_LINE",
        warrantyExpiry: daysFromNow(90 + (i % 5) * 30),
        amcProvider: ["HealthTech Services", "MediTech AMC", "Hospital Care Ltd"][i % 3],
        amcExpiryDate: daysFromNow(180 + (i % 6) * 30),
        calibrationInterval: 180,
        lastCalibrationAt: daysAgo(60 + i * 5),
        nextCalibrationAt: daysFromNow(120 - i * 5),
      },
    });
    updated++;
  }

  // Maintenance logs with next-due-dates on first 5 assets.
  // AssetMaintenance has no natural unique key — skip per-asset if any
  // maintenance log already exists for it.
  let maintLogs = 0;
  let maintSkipped = 0;
  for (let i = 0; i < Math.min(5, assets.length); i++) {
    const a = assets[i];
    const existingMaint = await prisma.assetMaintenance.count({
      where: { assetId: a.id },
    });
    if (existingMaint > 0) {
      maintSkipped++;
      continue;
    }
    const types = ["SCHEDULED", "INSPECTION", "CALIBRATION"] as const;
    await prisma.assetMaintenance.create({
      data: {
        assetId: a.id,
        type: types[i % 3],
        performedAt: daysAgo(30 + i * 10),
        performedBy: anyUser.id,
        vendor: ["Siemens Service", "GE Healthcare", "Philips Medical"][i % 3],
        cost: 2000 + i * 500,
        description:
          i % 2 === 0
            ? "Routine preventive maintenance & cleaning"
            : "Quarterly inspection and part replacement",
        nextDueDate: daysFromNow(60 + i * 30),
      },
    });
    maintLogs++;
  }

  console.log(
    `  ✓ ${updated} assets enriched + ${maintLogs} maintenance logs (skipped ${maintSkipped} assets already populated)`,
  );
}

async function main() {
  console.log("🌱 Seeding ancillary enhancements...");
  await seedLab();
  await seedPharmacy();
  await seedBloodBank();
  await seedAmbulance();
  await seedAssets();
  console.log("✅ Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
