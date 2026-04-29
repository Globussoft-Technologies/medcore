import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── MEDICINES ─────────────────────────────────────────
// Issue #40: every prescription-only drug has prescriptionRequired explicitly
//   set. Prior to the fix, cardiovascular / antibiotic / psych drugs relied on
//   the schema default (`true`), which was OK for the DB but the web UI reads
//   `rxRequired` (now aliased in the API). We now spell out the flag on every
//   row so seed intent is auditable in code review.
// Issue #41: every row has a realistic Indian manufacturer in `brand` (the
//   medicines.manufacturer UI column reads from `brand` via the API alias
//   layer — see apps/api/src/services/medicines/serialize.ts).
const MEDICINES: Array<{
  name: string;
  genericName: string;
  form: string;
  strength: string;
  category: string;
  prescriptionRequired: boolean;
  manufacturer: string;
  sideEffects?: string;
  contraindications?: string;
}> = [
  // ── OTC analgesics / vitamins / electrolytes ─────────
  { name: "Paracetamol 500mg", genericName: "Paracetamol", form: "Tablet", strength: "500mg", category: "Analgesic", prescriptionRequired: false, manufacturer: "GSK", sideEffects: "Rare: rash, nausea", contraindications: "Severe liver disease" },
  { name: "Ibuprofen 400mg", genericName: "Ibuprofen", form: "Tablet", strength: "400mg", category: "Analgesic", prescriptionRequired: false, manufacturer: "Cipla", sideEffects: "GI upset, dizziness", contraindications: "Peptic ulcer, renal failure" },
  { name: "Aspirin 75mg", genericName: "Acetylsalicylic acid", form: "Tablet", strength: "75mg", category: "Antiplatelet", prescriptionRequired: true, manufacturer: "USV", sideEffects: "Bleeding, GI upset", contraindications: "Active bleeding, children <16" },
  // ── Antibiotics (ALL prescription-only) ──────────────
  { name: "Amoxicillin 500mg", genericName: "Amoxicillin", form: "Capsule", strength: "500mg", category: "Antibiotic", prescriptionRequired: true, manufacturer: "Cipla", sideEffects: "Rash, diarrhea", contraindications: "Penicillin allergy" },
  { name: "Azithromycin 500mg", genericName: "Azithromycin", form: "Tablet", strength: "500mg", category: "Antibiotic", prescriptionRequired: true, manufacturer: "Alembic", sideEffects: "Nausea, QT prolongation", contraindications: "Macrolide allergy" },
  { name: "Ciprofloxacin 500mg", genericName: "Ciprofloxacin", form: "Tablet", strength: "500mg", category: "Antibiotic", prescriptionRequired: true, manufacturer: "Dr. Reddy's", sideEffects: "Tendonitis, GI upset", contraindications: "Pregnancy, children" },
  { name: "Doxycycline 100mg", genericName: "Doxycycline", form: "Capsule", strength: "100mg", category: "Antibiotic", prescriptionRequired: true, manufacturer: "Zydus", sideEffects: "Photosensitivity", contraindications: "Pregnancy, children <8" },
  { name: "Metronidazole 400mg", genericName: "Metronidazole", form: "Tablet", strength: "400mg", category: "Antibiotic", prescriptionRequired: true, manufacturer: "Alkem", sideEffects: "Metallic taste, nausea", contraindications: "Alcohol use" },
  { name: "Cefixime 200mg", genericName: "Cefixime", form: "Tablet", strength: "200mg", category: "Antibiotic", prescriptionRequired: true, manufacturer: "Lupin", sideEffects: "Diarrhea, rash" },
  // ── Antihistamines (OTC) ─────────────────────────────
  { name: "Cetirizine 10mg", genericName: "Cetirizine", form: "Tablet", strength: "10mg", category: "Antihistamine", prescriptionRequired: false, manufacturer: "GSK", sideEffects: "Drowsiness, dry mouth" },
  { name: "Loratadine 10mg", genericName: "Loratadine", form: "Tablet", strength: "10mg", category: "Antihistamine", prescriptionRequired: false, manufacturer: "Glenmark" },
  // ── Antidiabetic (RX in India — incl. metformin) ─────
  { name: "Metformin 500mg", genericName: "Metformin", form: "Tablet", strength: "500mg", category: "Antidiabetic", prescriptionRequired: true, manufacturer: "USV", sideEffects: "GI upset, lactic acidosis (rare)", contraindications: "Severe renal impairment" },
  { name: "Glimepiride 2mg", genericName: "Glimepiride", form: "Tablet", strength: "2mg", category: "Antidiabetic", prescriptionRequired: true, manufacturer: "Sanofi India", sideEffects: "Hypoglycemia" },
  { name: "Insulin Regular 100IU/ml", genericName: "Insulin Regular", form: "Injection", strength: "100IU/ml", category: "Antidiabetic", prescriptionRequired: true, manufacturer: "Biocon", sideEffects: "Hypoglycemia" },
  // ── Cardiovascular (Issue #40 primary regression set) ─
  { name: "Amlodipine 5mg", genericName: "Amlodipine", form: "Tablet", strength: "5mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Cipla", sideEffects: "Ankle edema, flushing" },
  { name: "Losartan 50mg", genericName: "Losartan", form: "Tablet", strength: "50mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Torrent", sideEffects: "Hyperkalemia, dizziness", contraindications: "Pregnancy" },
  { name: "Enalapril 5mg", genericName: "Enalapril", form: "Tablet", strength: "5mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Cipla", sideEffects: "Cough, angioedema", contraindications: "Pregnancy" },
  { name: "Atenolol 50mg", genericName: "Atenolol", form: "Tablet", strength: "50mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Alembic", sideEffects: "Bradycardia, fatigue" },
  { name: "Metoprolol 25mg", genericName: "Metoprolol", form: "Tablet", strength: "25mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Zydus" },
  { name: "Atorvastatin 10mg", genericName: "Atorvastatin", form: "Tablet", strength: "10mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Sun Pharma", sideEffects: "Myalgia, elevated LFTs" },
  { name: "Rosuvastatin 10mg", genericName: "Rosuvastatin", form: "Tablet", strength: "10mg", category: "Cardiovascular", prescriptionRequired: true, manufacturer: "Dr. Reddy's" },
  { name: "Clopidogrel 75mg", genericName: "Clopidogrel", form: "Tablet", strength: "75mg", category: "Antiplatelet", prescriptionRequired: true, manufacturer: "Lupin", sideEffects: "Bleeding" },
  { name: "Warfarin 5mg", genericName: "Warfarin", form: "Tablet", strength: "5mg", category: "Anticoagulant", prescriptionRequired: true, manufacturer: "Cipla", sideEffects: "Bleeding", contraindications: "Pregnancy, active bleeding" },
  { name: "Heparin 5000IU/ml", genericName: "Heparin", form: "Injection", strength: "5000IU/ml", category: "Anticoagulant", prescriptionRequired: true, manufacturer: "Intas" },
  // ── GI / PPIs (RX in India) ──────────────────────────
  { name: "Pantoprazole 40mg", genericName: "Pantoprazole", form: "Tablet", strength: "40mg", category: "Gastric", prescriptionRequired: true, manufacturer: "Sun Pharma", sideEffects: "Headache, diarrhea" },
  { name: "Omeprazole 20mg", genericName: "Omeprazole", form: "Capsule", strength: "20mg", category: "Gastric", prescriptionRequired: true, manufacturer: "Dr. Reddy's" },
  { name: "Ranitidine 150mg", genericName: "Ranitidine", form: "Tablet", strength: "150mg", category: "Gastric", prescriptionRequired: true, manufacturer: "GSK" },
  { name: "Ondansetron 4mg", genericName: "Ondansetron", form: "Tablet", strength: "4mg", category: "Antiemetic", prescriptionRequired: true, manufacturer: "Emcure", sideEffects: "Headache, constipation" },
  { name: "Domperidone 10mg", genericName: "Domperidone", form: "Tablet", strength: "10mg", category: "Antiemetic", prescriptionRequired: true, manufacturer: "Torrent" },
  // ── Respiratory ──────────────────────────────────────
  { name: "Salbutamol Inhaler", genericName: "Salbutamol", form: "Inhaler", strength: "100mcg/dose", category: "Respiratory", prescriptionRequired: true, manufacturer: "Cipla", sideEffects: "Tremor, tachycardia" },
  { name: "Montelukast 10mg", genericName: "Montelukast", form: "Tablet", strength: "10mg", category: "Respiratory", prescriptionRequired: true, manufacturer: "Mankind" },
  // ── Corticosteroids ──────────────────────────────────
  { name: "Prednisolone 5mg", genericName: "Prednisolone", form: "Tablet", strength: "5mg", category: "Corticosteroid", prescriptionRequired: true, manufacturer: "Cipla", sideEffects: "Weight gain, hyperglycemia" },
  { name: "Hydrocortisone 100mg", genericName: "Hydrocortisone", form: "Injection", strength: "100mg", category: "Corticosteroid", prescriptionRequired: true, manufacturer: "Pfizer India" },
  // ── Endocrine ────────────────────────────────────────
  { name: "Levothyroxine 50mcg", genericName: "Levothyroxine", form: "Tablet", strength: "50mcg", category: "Endocrine", prescriptionRequired: true, manufacturer: "Abbott India", sideEffects: "Palpitations if overdosed" },
  // ── OTC vitamins / supplements / ORS ─────────────────
  { name: "Folic Acid 5mg", genericName: "Folic acid", form: "Tablet", strength: "5mg", category: "Vitamin", prescriptionRequired: false, manufacturer: "Zydus" },
  { name: "Vitamin B12 1500mcg", genericName: "Cyanocobalamin", form: "Tablet", strength: "1500mcg", category: "Vitamin", prescriptionRequired: false, manufacturer: "Mankind" },
  { name: "Vitamin D3 60000IU", genericName: "Cholecalciferol", form: "Capsule", strength: "60000IU", category: "Vitamin", prescriptionRequired: false, manufacturer: "Alkem" },
  { name: "Iron + Folic Acid", genericName: "Ferrous sulfate + Folic acid", form: "Tablet", strength: "100mg+0.5mg", category: "Hematinic", prescriptionRequired: false, manufacturer: "Emcure" },
  { name: "Calcium Carbonate 500mg", genericName: "Calcium carbonate", form: "Tablet", strength: "500mg", category: "Supplement", prescriptionRequired: false, manufacturer: "Abbott India" },
  { name: "ORS Sachet", genericName: "Oral Rehydration Salts", form: "Sachet", strength: "21g", category: "Electrolyte", prescriptionRequired: false, manufacturer: "FDC" },
];

// ─── DRUG INTERACTIONS ─────────────────────────────────
const INTERACTIONS: Array<{
  drugA: string;
  drugB: string;
  severity: "MILD" | "MODERATE" | "SEVERE" | "CONTRAINDICATED";
  description: string;
}> = [
  { drugA: "Warfarin 5mg", drugB: "Aspirin 75mg", severity: "SEVERE", description: "Increased bleeding risk. Avoid concurrent use unless strictly indicated." },
  { drugA: "Warfarin 5mg", drugB: "Ibuprofen 400mg", severity: "SEVERE", description: "NSAIDs increase bleeding risk with warfarin." },
  { drugA: "Warfarin 5mg", drugB: "Azithromycin 500mg", severity: "MODERATE", description: "May increase INR; monitor closely." },
  { drugA: "Clopidogrel 75mg", drugB: "Aspirin 75mg", severity: "MODERATE", description: "Dual antiplatelet therapy — monitor for bleeding." },
  { drugA: "Clopidogrel 75mg", drugB: "Omeprazole 20mg", severity: "MODERATE", description: "Omeprazole reduces clopidogrel activation. Prefer pantoprazole." },
  { drugA: "Metformin 500mg", drugB: "Ciprofloxacin 500mg", severity: "MILD", description: "May slightly alter glucose levels; monitor." },
  { drugA: "Ciprofloxacin 500mg", drugB: "Ondansetron 4mg", severity: "MODERATE", description: "Both may prolong QT interval. Monitor ECG." },
  { drugA: "Azithromycin 500mg", drugB: "Ondansetron 4mg", severity: "MODERATE", description: "Additive QT prolongation risk." },
  { drugA: "Atorvastatin 10mg", drugB: "Azithromycin 500mg", severity: "MODERATE", description: "Possible increased statin exposure; watch for myopathy." },
  { drugA: "Enalapril 5mg", drugB: "Losartan 50mg", severity: "SEVERE", description: "Dual RAAS blockade increases hyperkalemia and renal failure risk." },
  { drugA: "Atenolol 50mg", drugB: "Salbutamol Inhaler", severity: "MODERATE", description: "Beta-blockers may reduce bronchodilator efficacy." },
  { drugA: "Prednisolone 5mg", drugB: "Ibuprofen 400mg", severity: "MODERATE", description: "Increased risk of GI ulceration and bleeding." },
];

// ─── LAB TESTS ─────────────────────────────────────────
const LAB_TESTS: Array<{
  code: string;
  name: string;
  category: string;
  price: number;
  sampleType?: string;
  normalRange?: string;
}> = [
  { code: "CBC", name: "Complete Blood Count", category: "Hematology", price: 350, sampleType: "Blood (EDTA)", normalRange: "See per-parameter ranges" },
  { code: "ESR", name: "Erythrocyte Sedimentation Rate", category: "Hematology", price: 150, sampleType: "Blood", normalRange: "M 0-15, F 0-20 mm/hr" },
  { code: "PT", name: "Prothrombin Time / INR", category: "Hematology", price: 400, sampleType: "Citrate", normalRange: "INR 0.8-1.2" },
  { code: "LFT", name: "Liver Function Test", category: "Biochemistry", price: 650, sampleType: "Serum" },
  { code: "KFT", name: "Kidney Function Test", category: "Biochemistry", price: 600, sampleType: "Serum" },
  { code: "LIPID", name: "Lipid Profile", category: "Biochemistry", price: 800, sampleType: "Fasting serum" },
  { code: "TFT", name: "Thyroid Function Test", category: "Biochemistry", price: 750, sampleType: "Serum", normalRange: "TSH 0.4-4.0 uIU/ml" },
  { code: "FBS", name: "Blood Sugar Fasting", category: "Biochemistry", price: 100, sampleType: "Plasma", normalRange: "70-100 mg/dL" },
  { code: "PPBS", name: "Blood Sugar Post Prandial", category: "Biochemistry", price: 100, sampleType: "Plasma", normalRange: "<140 mg/dL" },
  { code: "HBA1C", name: "Glycated Hemoglobin", category: "Biochemistry", price: 500, sampleType: "Blood (EDTA)", normalRange: "<5.7%" },
  { code: "URIC", name: "Serum Uric Acid", category: "Biochemistry", price: 200, sampleType: "Serum", normalRange: "3.5-7.2 mg/dL" },
  { code: "CRP", name: "C-Reactive Protein", category: "Biochemistry", price: 350, sampleType: "Serum", normalRange: "<5 mg/L" },
  { code: "VITD", name: "Vitamin D 25-OH", category: "Biochemistry", price: 1500, sampleType: "Serum", normalRange: "30-100 ng/mL" },
  { code: "VITB12", name: "Vitamin B12", category: "Biochemistry", price: 900, sampleType: "Serum", normalRange: "200-900 pg/mL" },
  // Issue #402: removed duplicate "Iron Studies" row (code IRON). The richer
  // multi-parameter version with reference ranges lives in
  // packages/db/src/seed-lab-panels.ts (code IRONST). Both seeds upsert by
  // `code`, so previously a reseed reliably produced two rows in the catalog
  // with identical name+category but different codes.
  { code: "URINE", name: "Urine Routine & Microscopy", category: "Clinical Pathology", price: 150, sampleType: "Urine" },
  { code: "STOOL", name: "Stool Routine", category: "Clinical Pathology", price: 150, sampleType: "Stool" },
  { code: "URINCUL", name: "Urine Culture & Sensitivity", category: "Microbiology", price: 600, sampleType: "Urine (midstream)" },
  { code: "BLOODCUL", name: "Blood Culture", category: "Microbiology", price: 1200, sampleType: "Blood" },
  { code: "DENGUE", name: "Dengue NS1 + IgM/IgG", category: "Serology", price: 800, sampleType: "Serum" },
  { code: "MALARIA", name: "Malaria Parasite", category: "Microbiology", price: 250, sampleType: "Blood" },
  { code: "TYPHOID", name: "Widal Test", category: "Serology", price: 300, sampleType: "Serum" },
  { code: "HIV", name: "HIV I & II Screening", category: "Serology", price: 500, sampleType: "Serum" },
  { code: "HBSAG", name: "Hepatitis B Surface Antigen", category: "Serology", price: 400, sampleType: "Serum" },
  { code: "HCV", name: "Hepatitis C Antibody", category: "Serology", price: 500, sampleType: "Serum" },
  { code: "XRAYCHEST", name: "X-Ray Chest PA View", category: "Radiology", price: 400, sampleType: "N/A" },
  { code: "ECG", name: "Electrocardiogram", category: "Cardiology", price: 300, sampleType: "N/A" },
  { code: "ECHO", name: "2D Echocardiogram", category: "Cardiology", price: 1500, sampleType: "N/A" },
  { code: "USGABD", name: "Ultrasound Abdomen", category: "Radiology", price: 1200, sampleType: "N/A" },
  { code: "USGPELV", name: "Ultrasound Pelvis", category: "Radiology", price: 1200, sampleType: "N/A" },
];

function randomBatchNumber(i: number): string {
  const letters = "ABCDEFGHJKMN";
  const a = letters[i % letters.length];
  const b = letters[(i * 3 + 1) % letters.length];
  const n = 1000 + (i * 137) % 9000;
  return `${a}${b}${n}`;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

async function main() {
  console.log("Seeding pharmacy & lab data...");

  // ── Seed Medicines ─────────────────────────────────
  // `brand` is the DB column that backs the UI "Manufacturer" column via the
  // API alias layer (apps/api/src/services/medicines/serialize.ts). See Issue
  // #41 for why we don't use a dedicated `manufacturer` column.
  const medicineRecords: Record<string, string> = {};
  for (const m of MEDICINES) {
    const med = await prisma.medicine.upsert({
      where: { name: m.name },
      update: {
        genericName: m.genericName,
        brand: m.manufacturer,
        form: m.form,
        strength: m.strength,
        category: m.category,
        sideEffects: m.sideEffects,
        contraindications: m.contraindications,
        prescriptionRequired: m.prescriptionRequired,
      },
      create: {
        name: m.name,
        genericName: m.genericName,
        brand: m.manufacturer,
        form: m.form,
        strength: m.strength,
        category: m.category,
        sideEffects: m.sideEffects,
        contraindications: m.contraindications,
        prescriptionRequired: m.prescriptionRequired,
      },
    });
    medicineRecords[m.name] = med.id;
  }
  console.log(`  Medicines: ${Object.keys(medicineRecords).length}`);

  // ── Seed Drug Interactions ─────────────────────────
  let interactionCount = 0;
  for (const i of INTERACTIONS) {
    const drugAId = medicineRecords[i.drugA];
    const drugBId = medicineRecords[i.drugB];
    if (!drugAId || !drugBId) continue;

    await prisma.drugInteraction
      .upsert({
        where: { drugAId_drugBId: { drugAId, drugBId } },
        update: { severity: i.severity, description: i.description },
        create: {
          drugAId,
          drugBId,
          severity: i.severity,
          description: i.description,
        },
      })
      .then(() => {
        interactionCount++;
      })
      .catch(() => {});
  }
  console.log(`  Drug interactions: ${interactionCount}`);

  // ── Seed Lab Tests ─────────────────────────────────
  for (const t of LAB_TESTS) {
    await prisma.labTest.upsert({
      where: { code: t.code },
      update: {
        name: t.name,
        category: t.category,
        price: t.price,
        sampleType: t.sampleType,
        normalRange: t.normalRange,
      },
      create: {
        code: t.code,
        name: t.name,
        category: t.category,
        price: t.price,
        sampleType: t.sampleType,
        normalRange: t.normalRange,
      },
    });
  }
  console.log(`  Lab tests: ${LAB_TESTS.length}`);

  // ── Seed Inventory for first 20 medicines ──────────
  // Issue #50: every InventoryItem with quantity > 0 must have a corresponding
  //   StockMovement of type PURCHASE so the "Movements" tab in
  //   apps/web/.../pharmacy/page.tsx isn't blank when stock is on hand. The
  //   schema enum doesn't have a literal RECEIVED — PURCHASE is the equivalent
  //   intake type (see schema.prisma StockMovementType). performedBy must be a
  //   real User row; we fall back to the system admin from seed.ts.
  const first20 = MEDICINES.slice(0, 20);
  let inventoryCount = 0;
  let movementCount = 0;
  const now = new Date();

  // Resolve a user id for stock movement audit trail. Prefer admin, but fall
  // back to any user so this seed works even if seed.ts hasn't yet been run.
  const adminUser =
    (await prisma.user.findUnique({
      where: { email: "admin@medcore.local" },
    })) ?? (await prisma.user.findFirst());
  if (!adminUser) {
    console.warn(
      "  No user found for StockMovement.performedBy — skipping movement seed.",
    );
  }

  for (let i = 0; i < first20.length; i++) {
    const med = first20[i];
    const medId = medicineRecords[med.name];
    if (!medId) continue;

    const quantity = 50 + ((i * 47) % 450);
    const unitCost = 2 + ((i * 3) % 28);
    const markup = 2 + ((i % 3) * 0.5);
    const sellingPrice = Math.round(unitCost * markup * 100) / 100;
    const monthsToExpiry = 6 + ((i * 7) % 19);
    const expiryDate = addMonths(now, monthsToExpiry);
    const batchNumber = randomBatchNumber(i);

    try {
      const inv = await prisma.inventoryItem.upsert({
        where: {
          medicineId_batchNumber: { medicineId: medId, batchNumber },
        },
        update: {
          quantity,
          unitCost,
          sellingPrice,
          expiryDate,
        },
        create: {
          medicineId: medId,
          batchNumber,
          quantity,
          unitCost,
          sellingPrice,
          expiryDate,
          supplier: ["MediSupply Co.", "PharmaDist Ltd.", "HealthLine Inc."][
            i % 3
          ],
          reorderLevel: 20,
          location: `Rack-${String.fromCharCode(65 + (i % 5))}-${(i % 10) + 1}`,
        },
      });
      inventoryCount++;

      // Issue #50: ensure an audit-trail PURCHASE row exists per inventory
      // item. Idempotent — only create if none yet for this item.
      if (adminUser) {
        const existing = await prisma.stockMovement.findFirst({
          where: { inventoryItemId: inv.id, type: "PURCHASE" },
          select: { id: true },
        });
        if (!existing) {
          await prisma.stockMovement.create({
            data: {
              inventoryItemId: inv.id,
              type: "PURCHASE",
              quantity, // positive = stock in
              reason: "Initial stock receipt (seed)",
              performedBy: adminUser.id,
              referenceId: null,
            },
          });
          movementCount++;
        }
      }
    } catch (e) {
      console.error(`  Failed inventory for ${med.name}:`, (e as Error).message);
    }
  }
  console.log(`  Inventory items: ${inventoryCount}`);
  console.log(`  Stock movements: ${movementCount}`);

  console.log("Pharmacy & lab seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
