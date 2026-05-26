/**
 * Clinical Enhancements Seed
 * ──────────────────────────
 * Seeds the new tables added by the clinical enhancement pass:
 *   - Icd10Code (common codes)
 *   - PrescriptionTemplate (common diagnoses)
 * Enriches existing Patient records with new demographic fields
 * (occupation, marital status, language, religion, ABHA id, photo).
 * Creates follow-up appointment reminders & immunization reminders.
 *
 * Run AFTER seed-realistic so there are patients to enrich.
 *
 * Idempotency contract (2026-05-11): safe to re-run on a populated demo
 * without creating duplicate rows.
 *   - Icd10Code, PrescriptionTemplate: already upserted on natural keys.
 *   - Patient demographic enrichment: keyed on Patient.id with stable
 *     per-row payload (no Math.random()), so re-runs idempotent.
 *   - Notification rows (follow-up + immunization reminders) get a
 *     stable dedupKey of the form `CLINENH-SEED-<kind>-<NNNN>` and we
 *     skip-if-exists via findUnique on the @@unique dedupKey field
 *     before .create.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Pearl ERP §2.1.3 — SNOMED CT starter set. Common primary-care
// concepts so the consult-screen Assessment tab autocomplete has real
// rows to return until the licensed C-DAC SNOMED CT distribution is
// ETL'd in. Same shape as ICD10_CODES so the seed loop is identical.
const SNOMED_CODES: Array<{ code: string; description: string; category: string }> = [
  { code: "38341003", description: "Hypertensive disorder", category: "Circulatory" },
  { code: "59621000", description: "Essential hypertension", category: "Circulatory" },
  { code: "44054006", description: "Type 2 diabetes mellitus", category: "Endocrine" },
  { code: "73211009", description: "Diabetes mellitus", category: "Endocrine" },
  { code: "46635009", description: "Type 1 diabetes mellitus", category: "Endocrine" },
  { code: "195967001", description: "Asthma", category: "Respiratory" },
  { code: "13645005", description: "Chronic obstructive pulmonary disease", category: "Respiratory" },
  { code: "233604007", description: "Pneumonia", category: "Respiratory" },
  { code: "10509002", description: "Acute bronchitis", category: "Respiratory" },
  { code: "62315008", description: "Diarrhea", category: "Digestive" },
  { code: "422587007", description: "Nausea", category: "Digestive" },
  { code: "16932000", description: "Nausea and vomiting", category: "Digestive" },
  { code: "21522001", description: "Abdominal pain", category: "Digestive" },
  { code: "25064002", description: "Headache", category: "Nervous" },
  { code: "37796009", description: "Migraine", category: "Nervous" },
  { code: "84229001", description: "Fatigue", category: "General" },
  { code: "386661006", description: "Fever", category: "General" },
  { code: "49727002", description: "Cough", category: "Respiratory" },
  { code: "267036007", description: "Dyspnea", category: "Respiratory" },
  { code: "29857009", description: "Chest pain", category: "Circulatory" },
  { code: "271807003", description: "Skin rash", category: "Skin" },
  { code: "30746006", description: "Anxiety disorder", category: "Mental" },
  { code: "35489007", description: "Depressive disorder", category: "Mental" },
  { code: "82423001", description: "Chronic pain", category: "General" },
  { code: "162059005", description: "Vertigo", category: "Nervous" },
  { code: "267102003", description: "Sore throat", category: "Respiratory" },
  { code: "419076005", description: "Allergic reaction", category: "Immune" },
  { code: "57676002", description: "Joint pain", category: "Musculoskeletal" },
  { code: "161891005", description: "Backache", category: "Musculoskeletal" },
  { code: "271737000", description: "Anaemia", category: "Blood" },
  { code: "414916001", description: "Obesity", category: "Endocrine" },
];

const ICD10_CODES: Array<{ code: string; description: string; category: string }> = [
  // Cardiovascular
  { code: "I10", description: "Essential (primary) hypertension", category: "Cardiovascular" },
  { code: "I11.9", description: "Hypertensive heart disease without heart failure", category: "Cardiovascular" },
  { code: "I25.10", description: "Atherosclerotic heart disease of native coronary artery", category: "Cardiovascular" },
  { code: "I48.91", description: "Unspecified atrial fibrillation", category: "Cardiovascular" },
  { code: "I50.9", description: "Heart failure, unspecified", category: "Cardiovascular" },
  { code: "I63.9", description: "Cerebral infarction, unspecified", category: "Cardiovascular" },
  // Endocrine
  { code: "E11.9", description: "Type 2 diabetes mellitus without complications", category: "Endocrine" },
  { code: "E11.65", description: "Type 2 diabetes with hyperglycemia", category: "Endocrine" },
  { code: "E10.9", description: "Type 1 diabetes mellitus without complications", category: "Endocrine" },
  { code: "E03.9", description: "Hypothyroidism, unspecified", category: "Endocrine" },
  { code: "E05.90", description: "Thyrotoxicosis, unspecified", category: "Endocrine" },
  { code: "E66.9", description: "Obesity, unspecified", category: "Endocrine" },
  { code: "E78.5", description: "Hyperlipidemia, unspecified", category: "Endocrine" },
  // Respiratory
  { code: "J06.9", description: "Acute upper respiratory infection, unspecified", category: "Respiratory" },
  { code: "J20.9", description: "Acute bronchitis, unspecified", category: "Respiratory" },
  { code: "J45.909", description: "Unspecified asthma, uncomplicated", category: "Respiratory" },
  { code: "J44.9", description: "Chronic obstructive pulmonary disease, unspecified", category: "Respiratory" },
  { code: "J18.9", description: "Pneumonia, unspecified organism", category: "Respiratory" },
  { code: "U07.1", description: "COVID-19, virus identified", category: "Respiratory" },
  // GI
  { code: "K21.9", description: "Gastro-esophageal reflux disease without esophagitis", category: "Gastrointestinal" },
  { code: "K29.70", description: "Gastritis, unspecified, without bleeding", category: "Gastrointestinal" },
  { code: "K59.00", description: "Constipation, unspecified", category: "Gastrointestinal" },
  { code: "A09", description: "Infectious gastroenteritis and colitis, unspecified", category: "Gastrointestinal" },
  // Musculoskeletal
  { code: "M54.5", description: "Low back pain", category: "Musculoskeletal" },
  { code: "M25.50", description: "Pain in unspecified joint", category: "Musculoskeletal" },
  { code: "M19.90", description: "Unspecified osteoarthritis, unspecified site", category: "Musculoskeletal" },
  { code: "M79.3", description: "Panniculitis, unspecified", category: "Musculoskeletal" },
  // Infections
  { code: "N39.0", description: "Urinary tract infection, site not specified", category: "Infection" },
  { code: "B34.9", description: "Viral infection, unspecified", category: "Infection" },
  { code: "A90", description: "Dengue fever", category: "Infection" },
  { code: "B50.9", description: "Plasmodium falciparum malaria, unspecified", category: "Infection" },
  // Mental / Neuro
  { code: "F41.9", description: "Anxiety disorder, unspecified", category: "Mental" },
  { code: "F32.9", description: "Major depressive disorder, single episode, unspecified", category: "Mental" },
  { code: "G43.909", description: "Migraine, unspecified, not intractable", category: "Neurology" },
  { code: "R51", description: "Headache", category: "Neurology" },
  // Pregnancy
  { code: "Z34.90", description: "Encounter for supervision of normal pregnancy", category: "Pregnancy" },
  { code: "O80", description: "Encounter for full-term uncomplicated delivery", category: "Pregnancy" },
  // Paediatrics
  { code: "J06.0", description: "Acute laryngopharyngitis", category: "Pediatrics" },
  { code: "A08.4", description: "Viral intestinal infection, unspecified", category: "Pediatrics" },
  // Skin
  { code: "L20.9", description: "Atopic dermatitis, unspecified", category: "Dermatology" },
  { code: "L30.9", description: "Dermatitis, unspecified", category: "Dermatology" },
  // General
  { code: "R50.9", description: "Fever, unspecified", category: "General" },
  { code: "R11.2", description: "Nausea with vomiting, unspecified", category: "General" },
  { code: "Z00.00", description: "General adult medical examination", category: "General" },
  { code: "Z23", description: "Encounter for immunization", category: "General" },
];

const PRESCRIPTION_TEMPLATES = [
  {
    name: "Hypertension — Initial",
    diagnosis: "Essential Hypertension (I10)",
    specialty: "Cardiology",
    advice: "Low-salt diet, 30 min daily walk, home BP monitoring twice daily.",
    items: [
      {
        medicineName: "Amlodipine 5 mg",
        dosage: "1 tablet",
        frequency: "Once daily",
        duration: "30 days",
        instructions: "Take in the morning after breakfast",
        refills: 2,
      },
      {
        medicineName: "Telmisartan 40 mg",
        dosage: "1 tablet",
        frequency: "Once daily",
        duration: "30 days",
        instructions: "Take after dinner",
        refills: 2,
      },
    ],
  },
  {
    name: "Type 2 Diabetes — Follow-up",
    diagnosis: "Type 2 Diabetes Mellitus (E11.9)",
    specialty: "Endocrinology",
    advice: "Check HbA1c in 3 months. Avoid sugar and white rice. 30 min walk daily.",
    items: [
      {
        medicineName: "Metformin 500 mg",
        dosage: "1 tablet",
        frequency: "Twice daily",
        duration: "60 days",
        instructions: "After breakfast and dinner",
        refills: 3,
      },
      {
        medicineName: "Glimepiride 1 mg",
        dosage: "1 tablet",
        frequency: "Once daily",
        duration: "60 days",
        instructions: "15 minutes before breakfast",
        refills: 3,
      },
    ],
  },
  {
    name: "URI — Adult",
    diagnosis: "Acute Upper Respiratory Infection (J06.9)",
    specialty: "General Medicine",
    advice: "Plenty of fluids, steam inhalation twice daily, rest. Return if fever > 3 days.",
    items: [
      {
        medicineName: "Paracetamol 650 mg",
        dosage: "1 tablet",
        frequency: "Thrice daily (SOS)",
        duration: "5 days",
        instructions: "If temperature > 100°F",
      },
      {
        medicineName: "Cetirizine 10 mg",
        dosage: "1 tablet",
        frequency: "Once daily at night",
        duration: "5 days",
        instructions: "May cause drowsiness",
      },
      {
        medicineName: "Ambroxol syrup",
        dosage: "10 ml",
        frequency: "Thrice daily",
        duration: "5 days",
        instructions: "After meals",
      },
    ],
  },
  {
    name: "Gastritis / GERD",
    diagnosis: "Gastro-esophageal Reflux Disease (K21.9)",
    specialty: "Gastroenterology",
    advice: "Avoid spicy / oily food, alcohol, smoking. Do not lie down within 2 hours of meals.",
    items: [
      {
        medicineName: "Pantoprazole 40 mg",
        dosage: "1 tablet",
        frequency: "Once daily",
        duration: "14 days",
        instructions: "Empty stomach, 30 min before breakfast",
        refills: 1,
      },
      {
        medicineName: "Domperidone 10 mg",
        dosage: "1 tablet",
        frequency: "Thrice daily",
        duration: "7 days",
        instructions: "Before meals",
      },
    ],
  },
  {
    name: "UTI — Adult Female",
    diagnosis: "Urinary Tract Infection (N39.0)",
    specialty: "General Medicine",
    advice: "Increase oral fluid intake (3 L/day). Review if symptoms persist beyond 3 days.",
    items: [
      {
        medicineName: "Nitrofurantoin 100 mg",
        dosage: "1 capsule",
        frequency: "Twice daily",
        duration: "5 days",
        instructions: "With food",
      },
      {
        medicineName: "Paracetamol 500 mg",
        dosage: "1 tablet",
        frequency: "SOS",
        duration: "3 days",
        instructions: "For pain/fever",
      },
    ],
  },
  {
    name: "Migraine — Acute",
    diagnosis: "Migraine (G43.909)",
    specialty: "Neurology",
    advice: "Rest in a dark, quiet room. Identify and avoid triggers (irregular sleep, skipped meals).",
    items: [
      {
        medicineName: "Sumatriptan 50 mg",
        dosage: "1 tablet",
        frequency: "At onset",
        duration: "3 days",
        instructions: "Max 2 per day. Do not repeat within 2 hours.",
      },
      {
        medicineName: "Naproxen 250 mg",
        dosage: "1 tablet",
        frequency: "Twice daily",
        duration: "3 days",
        instructions: "With food",
      },
    ],
  },
  {
    name: "Asthma — Exacerbation",
    diagnosis: "Asthma exacerbation (J45.909)",
    specialty: "Pulmonology",
    advice: "Avoid triggers. Maintain peak flow diary. Urgent review if SpO2 < 94%.",
    items: [
      {
        medicineName: "Salbutamol inhaler",
        dosage: "2 puffs",
        frequency: "QID (SOS)",
        duration: "7 days",
        instructions: "Use spacer. Rinse mouth after.",
        refills: 2,
      },
      {
        medicineName: "Budesonide 200 mcg inhaler",
        dosage: "2 puffs",
        frequency: "Twice daily",
        duration: "30 days",
        instructions: "Morning and night. Rinse mouth after.",
        refills: 3,
      },
      {
        medicineName: "Montelukast 10 mg",
        dosage: "1 tablet",
        frequency: "Once daily at night",
        duration: "30 days",
        instructions: "",
        refills: 3,
      },
    ],
  },
  {
    name: "Hypothyroidism — New",
    diagnosis: "Hypothyroidism (E03.9)",
    specialty: "Endocrinology",
    advice: "Repeat TSH in 6 weeks. Take on empty stomach, avoid calcium/iron within 4 hours.",
    items: [
      {
        medicineName: "Levothyroxine 50 mcg",
        dosage: "1 tablet",
        frequency: "Once daily",
        duration: "42 days",
        instructions: "Empty stomach, 30 min before breakfast",
        refills: 2,
      },
    ],
  },
  {
    name: "Acute Gastroenteritis",
    diagnosis: "Infectious gastroenteritis (A09)",
    specialty: "General Medicine",
    advice: "ORS after every loose stool. BRAT diet. Avoid dairy and spicy food.",
    items: [
      {
        medicineName: "ORS sachet",
        dosage: "1 sachet in 1 L water",
        frequency: "Sip throughout the day",
        duration: "3 days",
        instructions: "",
      },
      {
        medicineName: "Ofloxacin 200 mg + Ornidazole 500 mg",
        dosage: "1 tablet",
        frequency: "Twice daily",
        duration: "3 days",
        instructions: "After meals",
      },
      {
        medicineName: "Racecadotril 100 mg",
        dosage: "1 capsule",
        frequency: "Thrice daily",
        duration: "3 days",
        instructions: "Before meals",
      },
    ],
  },
  {
    name: "Low Back Pain",
    diagnosis: "Low back pain (M54.5)",
    specialty: "Orthopaedics",
    advice: "Hot fomentation BID. Avoid heavy lifting. Start back-strengthening exercises after pain resolves.",
    items: [
      {
        medicineName: "Diclofenac 50 mg",
        dosage: "1 tablet",
        frequency: "Twice daily",
        duration: "5 days",
        instructions: "After meals",
      },
      {
        medicineName: "Thiocolchicoside 4 mg",
        dosage: "1 tablet",
        frequency: "Twice daily",
        duration: "5 days",
        instructions: "",
      },
    ],
  },
];

const DEMOGRAPHICS_POOL = [
  {
    maritalStatus: "MARRIED",
    occupation: "Software Engineer",
    religion: "Hindu",
    preferredLanguage: "English",
  },
  {
    maritalStatus: "SINGLE",
    occupation: "Teacher",
    religion: "Christian",
    preferredLanguage: "Hindi",
  },
  {
    maritalStatus: "MARRIED",
    occupation: "Homemaker",
    religion: "Hindu",
    preferredLanguage: "Marathi",
  },
  {
    maritalStatus: "MARRIED",
    occupation: "Shopkeeper",
    religion: "Muslim",
    preferredLanguage: "Urdu",
  },
  {
    maritalStatus: "WIDOWED",
    occupation: "Retired",
    religion: "Hindu",
    preferredLanguage: "Gujarati",
  },
  {
    maritalStatus: "SINGLE",
    occupation: "Student",
    religion: "Hindu",
    preferredLanguage: "English",
  },
  {
    maritalStatus: "MARRIED",
    occupation: "Driver",
    religion: "Sikh",
    preferredLanguage: "Punjabi",
  },
  {
    maritalStatus: "DIVORCED",
    occupation: "Accountant",
    religion: "Hindu",
    preferredLanguage: "English",
  },
  {
    maritalStatus: "SINGLE",
    occupation: "Nurse",
    religion: "Christian",
    preferredLanguage: "Malayalam",
  },
  {
    maritalStatus: "MARRIED",
    occupation: "Farmer",
    religion: "Hindu",
    preferredLanguage: "Marathi",
  },
];

async function main() {
  console.log("=== Seeding Clinical Enhancements ===\n");

  // ─── 1. ICD-10 Codes ─────────────────────────────────
  console.log(`Seeding ${ICD10_CODES.length} ICD-10 codes...`);
  let icdCreated = 0;
  for (const c of ICD10_CODES) {
    await prisma.icd10Code.upsert({
      where: { code: c.code },
      update: { description: c.description, category: c.category },
      create: c,
    });
    icdCreated += 1;
  }
  console.log(`  Upserted ${icdCreated} ICD-10 codes.`);

  // ─── 1b. SNOMED CT Codes ─────────────────────────────
  // Pearl §2.1.3 — same upsert pattern as ICD-10 so re-running
  // db:seed is idempotent and edits to the starter set propagate.
  console.log(`\nSeeding ${SNOMED_CODES.length} SNOMED CT codes...`);
  let snomedCreated = 0;
  for (const c of SNOMED_CODES) {
    await prisma.snomedCode.upsert({
      where: { code: c.code },
      update: { description: c.description, category: c.category },
      create: c,
    });
    snomedCreated += 1;
  }
  console.log(`  Upserted ${snomedCreated} SNOMED CT codes.`);

  // ─── 2. Prescription Templates ───────────────────────
  console.log(`\nSeeding ${PRESCRIPTION_TEMPLATES.length} prescription templates...`);
  let tplCreated = 0;
  for (const t of PRESCRIPTION_TEMPLATES) {
    await prisma.prescriptionTemplate.upsert({
      where: { name: t.name },
      update: {
        diagnosis: t.diagnosis,
        specialty: t.specialty,
        advice: t.advice,
        items: t.items as any,
        isActive: true,
      },
      create: {
        name: t.name,
        diagnosis: t.diagnosis,
        specialty: t.specialty,
        advice: t.advice,
        items: t.items as any,
      },
    });
    tplCreated += 1;
  }
  console.log(`  Upserted ${tplCreated} prescription templates.`);

  // ─── 3. Enrich existing patients with demographics & photos ──
  console.log(`\nEnriching existing patient demographics...`);
  const patients = await prisma.patient.findMany({
    take: 20,
    include: { user: { select: { name: true } } },
  });
  let enriched = 0;
  for (let i = 0; i < patients.length; i++) {
    const p = patients[i];
    const demo = DEMOGRAPHICS_POOL[i % DEMOGRAPHICS_POOL.length];
    const nameSlug = encodeURIComponent(p.user.name);
    const abha = `${String(10000000000 + i * 137)}XX${String(i).padStart(2, "0")}`;
    const aadhaar = `XXXX-XXXX-${String(1000 + i * 7).slice(-4)}`;
    await prisma.patient.update({
      where: { id: p.id },
      data: {
        maritalStatus: demo.maritalStatus,
        occupation: demo.occupation,
        religion: demo.religion,
        preferredLanguage: demo.preferredLanguage,
        abhaId: abha,
        aadhaarMasked: aadhaar,
        photoUrl: `https://ui-avatars.com/api/?name=${nameSlug}&background=random&size=128`,
      },
    });
    enriched += 1;
  }
  console.log(`  Enriched ${enriched} patients.`);

  // ─── 4. Follow-up reminders (notifications) for patients with upcoming follow-up dates ──
  // Idempotency: each row gets a stable dedupKey "CLINENH-SEED-FOLLOWUP-NNNN"
  // gated by findUnique on the @@unique(dedupKey) field.
  console.log(`\nCreating follow-up reminders...`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7 = new Date(today);
  in7.setDate(in7.getDate() + 7);
  const upcomingFollowUps = await prisma.prescription.findMany({
    where: {
      followUpDate: { gte: today, lte: in7 },
    },
    include: {
      patient: { include: { user: { select: { id: true, name: true } } } },
      doctor: { include: { user: { select: { name: true } } } },
    },
    orderBy: { id: "asc" },
    take: 50,
  });
  let followUpCount = 0;
  let followUpSkipped = 0;
  for (let i = 0; i < upcomingFollowUps.length; i++) {
    const rx = upcomingFollowUps[i];
    const dedupKey = `CLINENH-SEED-FOLLOWUP-${String(i + 1).padStart(4, "0")}`;
    const existing = await prisma.notification.findUnique({
      where: { dedupKey },
      select: { id: true },
    });
    if (existing) {
      followUpSkipped += 1;
      continue;
    }
    await prisma.notification.create({
      data: {
        userId: rx.patient.user.id,
        type: "APPOINTMENT_REMINDER" as any,
        channel: "WHATSAPP" as any,
        title: "Follow-up Reminder",
        message: `Hi ${rx.patient.user.name}, your follow-up with Dr. ${
          rx.doctor.user.name
        } is due on ${rx.followUpDate!.toISOString().split("T")[0]}.`,
        data: { prescriptionId: rx.id } as any,
        sentAt: new Date(),
        dedupKey,
      },
    });
    followUpCount += 1;
  }
  console.log(
    `  Created ${followUpCount} follow-up reminders (skipped ${followUpSkipped} pre-existing).`,
  );

  // ─── 5. Immunization reminders for pediatric patients ───
  // Idempotency: each row gets a stable dedupKey "CLINENH-SEED-IMMUN-NNNN".
  console.log(`\nCreating pediatric immunization reminders...`);
  const children = await prisma.patient.findMany({
    where: {
      dateOfBirth: {
        gte: new Date(new Date().setFullYear(new Date().getFullYear() - 15)),
      },
    },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { id: "asc" },
    take: 30,
  });
  let pedReminders = 0;
  let pedSkipped = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child.dateOfBirth) continue;
    const dedupKey = `CLINENH-SEED-IMMUN-${String(i + 1).padStart(4, "0")}`;
    const existing = await prisma.notification.findUnique({
      where: { dedupKey },
      select: { id: true },
    });
    if (existing) {
      pedSkipped += 1;
      continue;
    }
    // Queue one reminder per child for the next DPT/MMR/etc due
    await prisma.notification.create({
      data: {
        userId: child.user.id,
        type: "APPOINTMENT_REMINDER" as any,
        channel: "SMS" as any,
        title: "Vaccine Reminder",
        message: `Hi ${child.user.name}, please check your immunization schedule. We'll share the next due vaccines at your upcoming visit.`,
        data: { kind: "immunization-reminder" } as any,
        sentAt: new Date(),
        dedupKey,
      },
    });
    pedReminders += 1;
  }
  console.log(
    `  Created ${pedReminders} pediatric immunization reminders (skipped ${pedSkipped} pre-existing).`,
  );

  console.log("\n=== Clinical Enhancements seed complete ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
