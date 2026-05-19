/**
 * Issue #899 (May 2026) — backfill regulatory + safety metadata on the
 * medicines master. The sidebar exposes a "Controlled Register" module
 * and the prescribing UI calls into a maxDailyDose alert engine, but
 * neither has anything to react to: shipped state on staging was
 * `schedule=null` on all 87 medicines, `isNarcotic=false` on all,
 * `maxDailyDoseMg` null on 79/82, `contraindications` empty on 70/82.
 *
 * This seed encodes the canonical regulatory schedule (Drugs & Cosmetics
 * Act / NDPS Act) per generic, plus a max-daily-dose figure and the
 * single most-clinically-important contraindication for the common
 * ~40 generics. Anything not in the map is left untouched — null is a
 * safer default than wrong data for the long tail.
 *
 * Idempotent: every update is a where-by-name + targeted SET. Re-runs
 * are byte-identical no-ops.
 *
 * Run via deploy.sh step 8f area:
 *   npx tsx packages/db/src/seed-medicine-regulatory.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Schedule = "H" | "H1" | "X" | "OTC";

interface RegulatoryEntry {
  /** Generic name match — case-insensitive equality. */
  genericName: string;
  /** Drug & Cosmetics Act schedule (H = Rx-only, H1 = narcotic register,
   *  X = NDPS register). OTC means deliberately no schedule. */
  schedule: Schedule;
  /** NDPS narcotic register flag — true for opioids and a few
   *  habit-forming psychotropics. */
  isNarcotic: boolean;
  /** Maximum daily dose in mg for an adult. null when dose is
   *  unit-dependent (e.g. insulin units, drops, sprays). */
  maxDailyDoseMg: number | null;
  /** Single highest-priority contraindication string surfaced in the
   *  prescribing UI's red-banner alert. Multi-CI guidance lives in
   *  patient leaflets (see seed-medicine-leaflets.ts). */
  contraindications: string;
}

const ENTRIES: RegulatoryEntry[] = [
  // ─── NDPS / narcotics ───────────────────────────────────────────
  {
    genericName: "Codeine Phosphate",
    schedule: "X",
    isNarcotic: true,
    maxDailyDoseMg: 240,
    contraindications:
      "Children under 12. Respiratory depression. Asthma. Concurrent MAO inhibitors.",
  },
  {
    genericName: "Tramadol",
    schedule: "H1",
    isNarcotic: true,
    maxDailyDoseMg: 400,
    contraindications:
      "Seizure disorders. Severe respiratory depression. Concurrent SSRIs (serotonin syndrome). MAO inhibitor use within 14 days.",
  },
  {
    genericName: "Alprazolam",
    schedule: "H1",
    isNarcotic: true,
    maxDailyDoseMg: 4,
    contraindications:
      "Acute narrow-angle glaucoma. Severe respiratory insufficiency. Concurrent opioids. History of substance abuse.",
  },
  // ─── Anticoagulants (Schedule H — narrow therapeutic window) ────
  {
    genericName: "Warfarin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 10,
    contraindications:
      "Active bleeding. Recent surgery. Pregnancy (Category X). Severe hepatic impairment. INR monitoring mandatory.",
  },
  {
    genericName: "Heparin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: null, // dosed in units, not mg
    contraindications:
      "Active major bleeding. Heparin-induced thrombocytopenia (HIT) history. Recent intracranial surgery.",
  },
  {
    genericName: "Clopidogrel",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 75,
    contraindications:
      "Active pathological bleeding. Severe hepatic impairment. Stop 5 days before elective surgery.",
  },
  // ─── Cardiovascular (Schedule H) ────────────────────────────────
  {
    genericName: "Digoxin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 0.25,
    contraindications:
      "Ventricular fibrillation. WPW syndrome. AV block (without pacemaker). Narrow therapeutic index — monitor levels.",
  },
  {
    genericName: "Atenolol",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 100,
    contraindications:
      "Asthma/COPD with bronchospasm. Bradycardia <50 bpm. Second/third-degree AV block. Cardiogenic shock.",
  },
  {
    genericName: "Metoprolol",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 400,
    contraindications:
      "Severe bradycardia. Second/third-degree AV block. Decompensated heart failure. Severe asthma.",
  },
  {
    genericName: "Enalapril",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 40,
    contraindications:
      "Pregnancy (Category D). Bilateral renal artery stenosis. History of ACE-inhibitor-induced angioedema. Hyperkalemia.",
  },
  {
    genericName: "Lisinopril",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Pregnancy. Bilateral renal artery stenosis. ACE-inhibitor angioedema history. Concomitant aliskiren in diabetics.",
  },
  {
    genericName: "Losartan",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 100,
    contraindications:
      "Pregnancy. Severe renal impairment. Bilateral renal artery stenosis. Concomitant aliskiren in diabetics.",
  },
  {
    genericName: "Amlodipine",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 10,
    contraindications:
      "Severe aortic stenosis. Cardiogenic shock. Hypersensitivity to dihydropyridines.",
  },
  {
    genericName: "Furosemide",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 600,
    contraindications:
      "Anuria. Severe hypokalemia or hyponatremia. Hepatic coma. Sulfonamide hypersensitivity.",
  },
  {
    genericName: "Spironolactone",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 400,
    contraindications:
      "Hyperkalemia. Addison's disease. Anuria. Severe renal impairment. Concomitant eplerenone.",
  },
  {
    genericName: "Nitroglycerin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: null, // sublingual + IV + patch, varied units
    contraindications:
      "Concurrent PDE5 inhibitors (sildenafil/tadalafil) within 24h. Severe hypotension. Right ventricular MI. Increased ICP.",
  },
  // ─── Statins ────────────────────────────────────────────────────
  {
    genericName: "Atorvastatin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Active liver disease. Pregnancy/lactation. Concurrent strong CYP3A4 inhibitors (clarithromycin, itraconazole).",
  },
  {
    genericName: "Rosuvastatin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 40,
    contraindications:
      "Active liver disease. Pregnancy/lactation. Severe renal impairment (CrCl<30) — limit to 10mg/day.",
  },
  {
    genericName: "Simvastatin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 40,
    contraindications:
      "Active liver disease. Pregnancy/lactation. Concurrent strong CYP3A4 inhibitors. Avoid grapefruit juice.",
  },
  // ─── Diabetes ───────────────────────────────────────────────────
  {
    genericName: "Metformin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 2550,
    contraindications:
      "eGFR <30 (lactic acidosis risk). Acute heart failure. Metabolic acidosis. Hold 48h around IV contrast.",
  },
  {
    genericName: "Metformin Extended Release",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 2000,
    contraindications:
      "eGFR <30. Acute heart failure. Metabolic acidosis. Hold 48h around IV contrast.",
  },
  {
    genericName: "Glimepiride",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 8,
    contraindications:
      "Type 1 diabetes. Severe renal impairment. Severe hepatic impairment. G6PD deficiency (hemolytic anemia risk).",
  },
  {
    genericName: "Sitagliptin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 100,
    contraindications:
      "History of pancreatitis. Severe renal impairment — dose-adjust. Type 1 diabetes (not indicated).",
  },
  {
    genericName: "Dapagliflozin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 10,
    contraindications:
      "eGFR <25. Active genitourinary infection. DKA risk in Type 1 diabetes. Volume depletion.",
  },
  {
    genericName: "Empagliflozin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 25,
    contraindications:
      "eGFR <30. DKA history. Recurrent UTI/genital mycotic infections. Type 1 diabetes (not indicated).",
  },
  // ─── Antibiotics ────────────────────────────────────────────────
  {
    genericName: "Amoxicillin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 3000,
    contraindications:
      "Penicillin allergy. Infectious mononucleosis (rash risk). Severe renal impairment — dose-adjust.",
  },
  {
    genericName: "Azithromycin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 500,
    contraindications:
      "Macrolide allergy. QT prolongation history. Severe hepatic impairment. Concurrent ergot derivatives.",
  },
  {
    genericName: "Ciprofloxacin",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 1500,
    contraindications:
      "Tendon disorder history (fluoroquinolone tendinopathy). Myasthenia gravis. Pregnancy. Children <18 (cartilage damage). QT prolongation.",
  },
  {
    genericName: "Doxycycline",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 200,
    contraindications:
      "Pregnancy. Children <8 years (tooth discoloration). Severe hepatic impairment. Concurrent retinoids.",
  },
  {
    genericName: "Linezolid",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 1200,
    contraindications:
      "Concurrent MAO inhibitors or SSRIs (serotonin syndrome). Uncontrolled hypertension. Carcinoid syndrome.",
  },
  {
    genericName: "Metronidazole",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 4000,
    contraindications:
      "First trimester pregnancy. Severe hepatic impairment. Disulfiram-like reaction with alcohol — abstain during + 3 days after.",
  },
  // ─── Steroids ───────────────────────────────────────────────────
  {
    genericName: "Prednisone",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Systemic fungal infection. Live virus vaccines. Long-term: monitor for adrenal suppression, taper slowly.",
  },
  {
    genericName: "Prednisolone",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Systemic fungal infection. Live virus vaccines. Long-term: monitor for adrenal suppression, taper slowly.",
  },
  {
    genericName: "Hydrocortisone",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 400,
    contraindications:
      "Systemic fungal infection. Live virus vaccines. Cushing's syndrome.",
  },
  // ─── GI / antacids ──────────────────────────────────────────────
  {
    genericName: "Pantoprazole",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Long-term use: B12 deficiency, hip fracture risk, C. difficile risk. Concurrent rilpivirine or high-dose methotrexate.",
  },
  {
    genericName: "Omeprazole",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Concurrent clopidogrel (reduced antiplatelet effect). Long-term: B12 deficiency, hypomagnesemia, hip fracture risk.",
  },
  {
    genericName: "Ranitidine",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 300,
    contraindications:
      "Porphyria history. Severe renal/hepatic impairment — dose-adjust. (Note: NDMA contamination led to global recall — verify current supplier.)",
  },
  {
    genericName: "Ondansetron",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 32,
    contraindications:
      "Concurrent apomorphine. Long QT syndrome. Severe hepatic impairment — max 8mg/day.",
  },
  {
    genericName: "Domperidone",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 30,
    contraindications:
      "QT prolongation. Concurrent strong CYP3A4 inhibitors. Pituitary prolactinoma. Moderate/severe hepatic impairment.",
  },
  // ─── Respiratory ────────────────────────────────────────────────
  {
    genericName: "Salbutamol",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: null, // inhaled dosing in mcg + puffs
    contraindications:
      "Tachyarrhythmia. Severe coronary artery disease. Excessive use → paradoxical bronchospasm.",
  },
  {
    genericName: "Montelukast",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 10,
    contraindications:
      "Aspirin-sensitive asthma — does not replace controller therapy. Neuropsychiatric adverse-event monitoring (FDA black-box: agitation, suicidal ideation).",
  },
  // ─── Endocrine ──────────────────────────────────────────────────
  {
    genericName: "Levothyroxine",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 0.3,
    contraindications:
      "Acute MI. Untreated thyrotoxicosis. Uncorrected adrenal insufficiency. Take 30-60 min before breakfast.",
  },
  {
    genericName: "Sildenafil",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 100,
    contraindications:
      "Concurrent nitrates (any form, even sublingual) — severe hypotension. Severe hepatic impairment. Recent stroke or MI.",
  },
  // ─── Psych ──────────────────────────────────────────────────────
  {
    genericName: "Fluoxetine",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 80,
    contraindications:
      "Concurrent MAO inhibitors (14-day washout). QT prolongation. Pediatric/adolescent — suicidal ideation black-box.",
  },
  {
    genericName: "Sertraline",
    schedule: "H",
    isNarcotic: false,
    maxDailyDoseMg: 200,
    contraindications:
      "Concurrent MAO inhibitors or pimozide. Severe hepatic impairment. Adolescent suicidal ideation monitoring.",
  },
  // ─── Anti-inflammatory / pain (OTC at low dose, H above) ───────
  {
    genericName: "Paracetamol",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 4000,
    contraindications:
      "Severe hepatic impairment. Chronic alcohol use (>3 drinks/day). Daily limit drops to 2g in liver disease.",
  },
  {
    genericName: "Ibuprofen",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 2400,
    contraindications:
      "Active peptic ulcer / GI bleed. Severe heart failure. Third-trimester pregnancy. Severe renal impairment (eGFR<30).",
  },
  {
    genericName: "Acetylsalicylic acid",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 4000,
    contraindications:
      "Children <16 (Reye's syndrome). Active GI bleed. Hemophilia. Severe hepatic/renal impairment. Aspirin-induced asthma.",
  },
  // ─── OTC / vitamins ─────────────────────────────────────────────
  {
    genericName: "Cetirizine",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 10,
    contraindications:
      "Severe renal impairment (CrCl<10). End-stage renal disease.",
  },
  {
    genericName: "Loratadine",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 10,
    contraindications:
      "Severe hepatic impairment — alternate-day dosing. Phenylketonuria (some formulations contain aspartame).",
  },
  {
    genericName: "Calcium carbonate",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 2500,
    contraindications:
      "Hypercalcemia. Severe renal impairment. Concurrent thiazide diuretics — milk-alkali syndrome risk.",
  },
  {
    genericName: "Cholecalciferol",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 0.1, // 4000 IU = 0.1mg
    contraindications:
      "Hypercalcemia. Severe renal impairment with hyperphosphatemia. Vitamin D toxicity history.",
  },
  {
    genericName: "Folic acid",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 5,
    contraindications:
      "Untreated B12 deficiency (masks pernicious anemia diagnosis). Vitamin B12 deficiency.",
  },
  {
    genericName: "Cyanocobalamin",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: 2,
    contraindications:
      "Leber's optic neuropathy (may worsen). Cobalt sensitivity.",
  },
  {
    genericName: "Oral Rehydration Salts",
    schedule: "OTC",
    isNarcotic: false,
    maxDailyDoseMg: null, // dosed in sachets, not mg
    contraindications:
      "Anuria or severe oliguria. Intestinal obstruction. Severe hypernatremia.",
  },
];

async function main() {
  console.log(`[seed-medicine-regulatory] start — ${ENTRIES.length} entries`);
  let updated = 0;
  let skipped = 0;

  for (const entry of ENTRIES) {
    const existing = await prisma.medicine.findFirst({
      where: {
        genericName: {
          equals: entry.genericName,
          mode: "insensitive",
        },
      },
      select: { id: true, name: true, schedule: true, isNarcotic: true },
    });

    if (!existing) {
      console.log(`  skip — "${entry.genericName}" not in master`);
      skipped++;
      continue;
    }

    await prisma.medicine.update({
      where: { id: existing.id },
      data: {
        schedule: entry.schedule === "OTC" ? null : entry.schedule,
        isNarcotic: entry.isNarcotic,
        maxDailyDoseMg: entry.maxDailyDoseMg,
        contraindications: entry.contraindications,
        // requiresRegister: anything on H1 or X gets register treatment.
        requiresRegister:
          entry.schedule === "H1" || entry.schedule === "X" ? true : undefined,
      },
    });
    updated++;
  }

  console.log(
    `[seed-medicine-regulatory] done — ${updated} updated, ${skipped} skipped (not in master)`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[seed-medicine-regulatory] FAILED:", e);
  process.exit(1);
});
