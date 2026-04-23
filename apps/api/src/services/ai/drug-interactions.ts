// Drug safety checking — two-layer approach:
// Layer 1: deterministic rules (fast, no LLM cost, high precision on known pairs)
// Layer 2: LLM comprehensive check for interactions not in the curated list

import OpenAI from "openai";
import type { DrugInteractionAlert } from "@medcore/shared";
import { prisma } from "@medcore/db";

// Sarvam AI — India-region servers, DPDP-compliant
const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

// ─── Allergy cross-reactivity map ────────────────────────────────────────────
// Maps allergen keywords → drug families with documented cross-reactivity

const ALLERGY_CROSS_REACTIVITY: Record<string, { drugs: RegExp[]; description: string }> = {
  penicillin: {
    drugs: [/amoxicillin/i, /amoxyclav/i, /co.amoxiclav/i, /augmentin/i, /ampicillin/i, /flucloxacillin/i, /cloxacillin/i, /piperacillin/i, /tazobactam/i],
    description: "Cross-reactivity risk with documented penicillin allergy. Consider a cephalosporin with low cross-reactivity or a non-beta-lactam alternative.",
  },
  sulfa: {
    drugs: [/sulfamethoxazole/i, /co.trimoxazole/i, /septran/i, /bactrim/i, /sulfasalazine/i, /furosemide/i, /hydrochlorothiazide/i, /acetazolamide/i],
    description: "Sulfonamide cross-reactivity possible. Verify sulfa allergy history — furosemide and thiazides carry low but non-zero risk.",
  },
  aspirin: {
    drugs: [/ibuprofen/i, /diclofenac/i, /naproxen/i, /indomethacin/i, /ketorolac/i, /celecoxib/i, /etoricoxib/i, /mefenamic/i, /piroxicam/i],
    description: "NSAID cross-reactivity in aspirin-sensitive patients — may trigger aspirin-exacerbated respiratory disease or urticaria.",
  },
  codeine: {
    drugs: [/tramadol/i, /pethidine/i, /morphine/i, /oxycodone/i, /hydrocodone/i, /fentanyl/i, /tapentadol/i],
    description: "Opioid cross-sensitivity possible in codeine-allergic patients. Monitor closely and have naloxone available.",
  },
  cephalosporin: {
    drugs: [/cefalexin/i, /cephalexin/i, /cefixime/i, /cefuroxime/i, /ceftriaxone/i, /cefpodoxime/i, /cefdinir/i, /cefadroxil/i],
    description: "Cephalosporin allergy — cross-reactivity exists within the class. Use an alternative antibiotic class.",
  },
};

// ─── Known dangerous drug-drug interaction pairs ──────────────────────────────

const KNOWN_INTERACTIONS: {
  drugs: [RegExp, RegExp];
  severity: DrugInteractionAlert["severity"];
  description: string;
}[] = [
  // Anticoagulant interactions
  {
    drugs: [/warfarin/i, /aspirin|ibuprofen|diclofenac|naproxen|indomethacin|ketorolac|mefenamic/i],
    severity: "SEVERE",
    description: "Anticoagulant + NSAID: significantly increased bleeding risk (GI haemorrhage, intracranial bleed). Monitor INR closely; add gastroprotection (PPI).",
  },
  {
    drugs: [/warfarin/i, /fluconazole|metronidazole|clarithromycin|erythromycin|azithromycin|ciprofloxacin|levofloxacin/i],
    severity: "SEVERE",
    description: "These agents inhibit warfarin metabolism (CYP2C9/CYP3A4) — INR may rise sharply. Reduce warfarin dose and monitor INR every 2–3 days.",
  },
  // Serotonin syndrome combinations
  {
    drugs: [/ssri|fluoxetine|sertraline|paroxetine|escitalopram|citalopram|fluvoxamine/i, /maoi|phenelzine|tranylcypromine|selegiline|isocarboxazid/i],
    severity: "CONTRAINDICATED",
    description: "SSRI + MAOI: potentially fatal serotonin syndrome. Do not co-prescribe; allow 14-day washout (5 weeks for fluoxetine) when switching.",
  },
  {
    drugs: [/tramadol/i, /ssri|fluoxetine|sertraline|paroxetine|escitalopram|venlafaxine|duloxetine/i],
    severity: "SEVERE",
    description: "Tramadol + SSRI/SNRI: serotonin syndrome risk (hyperthermia, agitation, clonus). Choose alternative analgesic if possible.",
  },
  {
    drugs: [/tramadol/i, /maoi|phenelzine|tranylcypromine|selegiline/i],
    severity: "CONTRAINDICATED",
    description: "Tramadol + MAOI: contraindicated — high risk of fatal serotonin syndrome and seizures.",
  },
  {
    drugs: [/linezolid/i, /ssri|snri|tramadol|triptan|sumatriptan|rizatriptan/i],
    severity: "CONTRAINDICATED",
    description: "Linezolid is a weak MAOI — co-prescribing with serotonergic drugs risks serotonin syndrome.",
  },
  // Cardiac interactions
  {
    drugs: [/digoxin/i, /amiodarone/i],
    severity: "SEVERE",
    description: "Amiodarone inhibits digoxin clearance — digoxin toxicity risk (bradycardia, heart block, nausea). Reduce digoxin dose by ~50% and monitor levels.",
  },
  {
    drugs: [/sildenafil|tadalafil|vardenafil|avanafil/i, /nitrate|nitroglycerin|isosorbide|glyceryl trinitrate/i],
    severity: "CONTRAINDICATED",
    description: "PDE5 inhibitor + nitrate: severe, potentially fatal hypotension. Absolutely contraindicated.",
  },
  {
    drugs: [/qt.prolonging|amiodarone|sotalol|haloperidol|domperidone|erythromycin|azithromycin|ciprofloxacin|ondansetron/i, /qt.prolonging|amiodarone|sotalol|haloperidol|domperidone|erythromycin|azithromycin|ciprofloxacin|ondansetron/i],
    severity: "MODERATE",
    description: "Multiple QT-prolonging drugs: additive risk of Torsades de Pointes. Review list and monitor ECG.",
  },
  // ACE/ARB + potassium
  {
    drugs: [/enalapril|lisinopril|ramipril|captopril|perindopril|telmisartan|losartan|valsartan|irbesartan|olmesartan|candesartan/i, /spironolactone|eplerenone|amiloride|triamterene/i],
    severity: "MODERATE",
    description: "ACE inhibitor/ARB + potassium-sparing diuretic: hyperkalaemia risk. Monitor serum potassium and renal function, especially at initiation.",
  },
  // Statin interactions
  {
    drugs: [/simvastatin|lovastatin/i, /clarithromycin|erythromycin|itraconazole|fluconazole|verapamil|diltiazem|amiodarone/i],
    severity: "SEVERE",
    description: "Strong CYP3A4 inhibitor significantly raises simvastatin/lovastatin levels — rhabdomyolysis risk. Use rosuvastatin or pravastatin instead.",
  },
  {
    drugs: [/statin|atorvastatin|rosuvastatin|simvastatin|pravastatin|lovastatin/i, /gemfibrozil/i],
    severity: "SEVERE",
    description: "Statin + Gemfibrozil: greatly increased myopathy and rhabdomyolysis risk. Avoid; use fenofibrate if a fibrate is required.",
  },
  // Quinolone interactions
  {
    drugs: [/ciprofloxacin|levofloxacin|ofloxacin|norfloxacin|moxifloxacin/i, /antacid|aluminum|magnesium hydroxide|calcium carbonate|sucralfate/i],
    severity: "MODERATE",
    description: "Quinolone absorption is markedly reduced by polyvalent cation antacids. Separate doses by at least 2 hours (quinolone before antacid).",
  },
  {
    drugs: [/theophylline|aminophylline/i, /ciprofloxacin|enoxacin/i],
    severity: "SEVERE",
    description: "Ciprofloxacin/Enoxacin inhibits theophylline metabolism — theophylline toxicity risk (seizures, cardiac arrhythmias). Monitor theophylline levels.",
  },
  // Other important pairs
  {
    drugs: [/clopidogrel/i, /omeprazole|esomeprazole/i],
    severity: "MODERATE",
    description: "Omeprazole/Esomeprazole inhibit CYP2C19 and reduce clopidogrel activation. Consider pantoprazole or rabeprazole instead.",
  },
  {
    drugs: [/methotrexate/i, /nsaid|ibuprofen|diclofenac|naproxen|indomethacin|aspirin/i],
    severity: "SEVERE",
    description: "NSAIDs reduce methotrexate renal clearance — methotrexate toxicity risk (myelosuppression, mucositis). Avoid combination; if unavoidable, monitor FBC closely.",
  },
  {
    drugs: [/lithium/i, /nsaid|ibuprofen|diclofenac|naproxen|indomethacin/i],
    severity: "SEVERE",
    description: "NSAIDs reduce renal lithium clearance — lithium toxicity risk. Monitor lithium levels; use paracetamol for analgesia.",
  },
];

// ─── Condition-specific contraindications ────────────────────────────────────

const CONDITION_CONTRAINDICATIONS: {
  conditionPattern: RegExp;
  drugPattern: RegExp;
  severity: DrugInteractionAlert["severity"];
  description: string;
}[] = [
  {
    conditionPattern: /asthma|copd|reactive airway/i,
    drugPattern: /propranolol|atenolol|metoprolol|bisoprolol|carvedilol|labetalol|nadolol|timolol/i,
    severity: "SEVERE",
    description: "Beta-blockers (especially non-selective) can precipitate severe bronchospasm in asthma/COPD. Avoid or use highly cardioselective agent (bisoprolol) with extreme caution.",
  },
  {
    conditionPattern: /asthma/i,
    drugPattern: /aspirin|ibuprofen|diclofenac|naproxen|indomethacin|ketorolac/i,
    severity: "MODERATE",
    description: "NSAIDs can trigger aspirin-exacerbated respiratory disease (Samter's triad) in susceptible asthmatics. Use paracetamol instead.",
  },
  {
    conditionPattern: /renal|kidney|ckd|chronic kidney|nephropathy/i,
    drugPattern: /nsaid|ibuprofen|diclofenac|naproxen|ketorolac|indomethacin/i,
    severity: "SEVERE",
    description: "NSAIDs can worsen renal function and precipitate AKI in CKD patients. Use paracetamol; if NSAID essential, use lowest dose for shortest time with renal monitoring.",
  },
  {
    conditionPattern: /renal|kidney|ckd|chronic kidney|nephropathy/i,
    drugPattern: /metformin/i,
    severity: "MODERATE",
    description: "Metformin risk of lactic acidosis increases with renal impairment. Contraindicated if eGFR < 30 mL/min; reduce dose if eGFR 30–45.",
  },
  {
    conditionPattern: /diabetes|diabetic|type 2 dm|type 1 dm/i,
    drugPattern: /prednisolone|prednisone|dexamethasone|betamethasone|methylprednisolone|hydrocortisone/i,
    severity: "MODERATE",
    description: "Corticosteroids raise blood glucose and can destabilize glycaemic control in diabetic patients. Monitor blood sugar; may need insulin dose adjustment.",
  },
  {
    conditionPattern: /pregnancy|pregnant|gravid/i,
    drugPattern: /nsaid|ibuprofen|diclofenac|naproxen|indomethacin/i,
    severity: "SEVERE",
    description: "NSAIDs are contraindicated from 28 weeks gestation (premature closure of ductus arteriosus, oligohydramnios). Use paracetamol for analgesia.",
  },
  {
    conditionPattern: /pregnancy|pregnant|gravid/i,
    drugPattern: /warfarin/i,
    severity: "CONTRAINDICATED",
    description: "Warfarin crosses the placenta and is teratogenic/fetotoxic throughout pregnancy. Use LMWH (e.g., enoxaparin) instead.",
  },
  {
    conditionPattern: /pregnancy|pregnant|gravid/i,
    drugPattern: /tetracycline|doxycycline|minocycline/i,
    severity: "CONTRAINDICATED",
    description: "Tetracyclines are contraindicated in pregnancy — cause permanent tooth discolouration and impaired bone development in the fetus.",
  },
  {
    conditionPattern: /peptic ulcer|gastric ulcer|duodenal ulcer|gi bleed|gastrointestinal bleed/i,
    drugPattern: /nsaid|ibuprofen|aspirin|diclofenac|naproxen|indomethacin|ketorolac/i,
    severity: "SEVERE",
    description: "NSAIDs/aspirin contraindicated in active peptic ulcer disease — high risk of GI haemorrhage. Use paracetamol; add PPI cover if NSAID is unavoidable.",
  },
  {
    conditionPattern: /liver|hepatic|cirrhosis|hepatitis/i,
    drugPattern: /paracetamol|acetaminophen/i,
    severity: "MODERATE",
    description: "Paracetamol hepatotoxicity risk is increased in severe hepatic impairment or chronic alcohol use. Use lowest effective dose; max 2 g/day in hepatic disease.",
  },
];

// ─── Paediatric contraindications ────────────────────────────────────────────

const PAEDIATRIC_RESTRICTIONS: {
  drugPattern: RegExp;
  minAge: number;
  description: string;
}[] = [
  { drugPattern: /aspirin/i, minAge: 16, description: "Aspirin is contraindicated in children < 16 years (Reye's syndrome risk). Use paracetamol." },
  { drugPattern: /tetracycline|doxycycline|minocycline/i, minAge: 8, description: "Tetracyclines contraindicated < 8 years — permanent tooth discolouration and impaired bone growth." },
  { drugPattern: /fluoroquinolone|ciprofloxacin|levofloxacin|ofloxacin|norfloxacin/i, minAge: 18, description: "Fluoroquinolones generally avoided in < 18 years — cartilage toxicity risk (use only if no alternative)." },
  { drugPattern: /codeine/i, minAge: 12, description: "Codeine contraindicated < 12 years — ultra-rapid metabolisers risk of fatal respiratory depression." },
  { drugPattern: /ibuprofen|naproxen|diclofenac/i, minAge: 3, description: "NSAIDs: use with caution in children < 3 years. Paracetamol is preferred." },
  { drugPattern: /metformin/i, minAge: 10, description: "Metformin not approved below 10 years." },
];

// ─── Renal dosing restrictions ────────────────────────────────────────────────

const RENAL_RESTRICTIONS: {
  drugPattern: RegExp;
  eGFRThreshold: number;
  severity: DrugInteractionAlert["severity"];
  description: string;
}[] = [
  { drugPattern: /metformin/i, eGFRThreshold: 30, severity: "CONTRAINDICATED", description: "Metformin contraindicated if eGFR < 30 mL/min (lactic acidosis risk)." },
  { drugPattern: /metformin/i, eGFRThreshold: 45, severity: "MODERATE", description: "Metformin: reduce dose if eGFR 30–45 mL/min; monitor renal function every 3 months." },
  { drugPattern: /nsaid|ibuprofen|diclofenac|naproxen|indomethacin|ketorolac/i, eGFRThreshold: 60, severity: "SEVERE", description: "NSAIDs can worsen renal function. Avoid if eGFR < 60; use paracetamol instead." },
  { drugPattern: /digoxin/i, eGFRThreshold: 60, severity: "MODERATE", description: "Digoxin clearance reduced in renal impairment — toxicity risk. Reduce dose; monitor levels." },
  { drugPattern: /lithium/i, eGFRThreshold: 60, severity: "SEVERE", description: "Lithium primarily renally cleared — toxicity risk increases significantly with renal impairment. Monitor levels closely." },
  { drugPattern: /gabapentin|pregabalin/i, eGFRThreshold: 60, severity: "MODERATE", description: "Gabapentin/Pregabalin dose adjustment required in renal impairment (eGFR-based dosing)." },
  { drugPattern: /atenolol|bisoprolol/i, eGFRThreshold: 30, severity: "MODERATE", description: "Atenolol/Bisoprolol accumulate in severe renal impairment — reduce dose." },
];

// ─── Hepatic contraindications ────────────────────────────────────────────────

const HEPATIC_RESTRICTIONS: {
  drugPattern: RegExp;
  severity: DrugInteractionAlert["severity"];
  minImpairment: "mild" | "moderate" | "severe";
  description: string;
}[] = [
  { drugPattern: /paracetamol|acetaminophen/i, severity: "MODERATE", minImpairment: "mild", description: "Paracetamol hepatotoxicity risk elevated in hepatic impairment. Max 2 g/day; avoid in severe hepatic disease." },
  { drugPattern: /methotrexate/i, severity: "SEVERE", minImpairment: "mild", description: "Methotrexate hepatotoxic — contraindicated in pre-existing liver disease." },
  { drugPattern: /statins|atorvastatin|rosuvastatin|simvastatin|pravastatin/i, severity: "MODERATE", minImpairment: "moderate", description: "Statins: use with caution in moderate hepatic impairment; avoid in severe. Monitor LFTs." },
  { drugPattern: /fluconazole|itraconazole|ketoconazole/i, severity: "SEVERE", minImpairment: "moderate", description: "Azole antifungals heavily hepatically metabolised — significant toxicity risk in hepatic impairment." },
  { drugPattern: /carbamazepine|valproate|valproic acid/i, severity: "SEVERE", minImpairment: "mild", description: "Carbamazepine/Valproate are hepatotoxic — contraindicated in active hepatic disease." },
  { drugPattern: /rifampicin|rifampin/i, severity: "SEVERE", minImpairment: "moderate", description: "Rifampicin: hepatotoxic; avoid in moderate-severe hepatic impairment." },
];

// Severity ordering for hepatic impairment comparison
const HEPATIC_SEVERITY_ORDER: Record<"mild" | "moderate" | "severe", number> = {
  mild: 1,
  moderate: 2,
  severe: 3,
};

// ─── Public deterministic functions ──────────────────────────────────────────

/**
 * Check proposed medications against a patient's known allergies using
 * direct name matching and documented cross-reactivity families (e.g. penicillin,
 * sulfa, NSAID-aspirin). Returns SEVERE or CONTRAINDICATED alerts.
 */
export function checkAllergyContraindications(
  proposedMeds: string[],
  allergies: string[]
): DrugInteractionAlert[] {
  const alerts: DrugInteractionAlert[] = [];
  for (const allergen of allergies) {
    const lowerAllergen = allergen.toLowerCase().trim();

    // Cross-reactivity families
    for (const [key, { drugs, description }] of Object.entries(ALLERGY_CROSS_REACTIVITY)) {
      if (lowerAllergen.includes(key)) {
        for (const med of proposedMeds) {
          if (drugs.some((p) => p.test(med))) {
            alerts.push({ drug1: med, drug2: `[ALLERGY: ${allergen}]`, severity: "SEVERE", description });
          }
        }
      }
    }

    // Direct name match (e.g. allergy "penicillin" vs drug "penicillin V")
    for (const med of proposedMeds) {
      const lowerMed = med.toLowerCase();
      if (lowerMed.includes(lowerAllergen) || lowerAllergen.includes(lowerMed.split(" ")[0])) {
        const alreadyFlagged = alerts.some((a) => a.drug1 === med && a.drug2.includes(allergen));
        if (!alreadyFlagged) {
          alerts.push({
            drug1: med,
            drug2: `[ALLERGY: ${allergen}]`,
            severity: "CONTRAINDICATED",
            description: `Patient has a documented allergy to ${allergen}. Prescribing ${med} is contraindicated — use an alternative.`,
          });
        }
      }
    }
  }
  return alerts;
}

/**
 * Detect clinically significant drug-drug interactions between proposed and
 * current medications using the curated `KNOWN_INTERACTIONS` rule table.
 * Only raises an alert when at least one drug in the pair is newly proposed.
 */
export function checkKnownDrugInteractions(
  proposedMeds: string[],
  currentMeds: string[]
): DrugInteractionAlert[] {
  const allMeds = [...proposedMeds, ...currentMeds];
  const alerts: DrugInteractionAlert[] = [];
  const seen = new Set<string>();

  for (const { drugs: [patA, patB], severity, description } of KNOWN_INTERACTIONS) {
    const matchA = allMeds.filter((m) => patA.test(m));
    const matchB = allMeds.filter((m) => patB.test(m));

    for (const drugA of matchA) {
      for (const drugB of matchB) {
        if (drugA === drugB) continue;
        const key = [drugA, drugB].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        // Only alert if at least one drug is newly proposed (not both already existing)
        const aProposed = proposedMeds.some((m) => patA.test(m));
        const bProposed = proposedMeds.some((m) => patB.test(m));
        if (aProposed || bProposed) {
          alerts.push({ drug1: drugA, drug2: drugB, severity, description });
        }
      }
    }
  }
  return alerts;
}

/**
 * Flag drugs that are contraindicated or require caution given the patient's
 * chronic conditions (e.g. beta-blockers in asthma, NSAIDs in CKD, warfarin in
 * pregnancy).
 */
export function checkConditionContraindications(
  proposedMeds: string[],
  chronicConditions: string[]
): DrugInteractionAlert[] {
  const alerts: DrugInteractionAlert[] = [];
  for (const condition of chronicConditions) {
    for (const { conditionPattern, drugPattern, severity, description } of CONDITION_CONTRAINDICATIONS) {
      if (conditionPattern.test(condition)) {
        for (const med of proposedMeds) {
          if (drugPattern.test(med)) {
            alerts.push({ drug1: med, drug2: `[CONDITION: ${condition}]`, severity, description });
          }
        }
      }
    }
  }
  return alerts;
}

/**
 * Identify drugs restricted in children (e.g. aspirin <16 y, codeine <12 y,
 * tetracyclines <8 y). Returns an empty array when `patientAge` is undefined.
 */
export function checkPaediatricContraindications(
  proposedMeds: string[],
  patientAge: number | undefined
): DrugInteractionAlert[] {
  if (patientAge === undefined) return [];
  const alerts: DrugInteractionAlert[] = [];
  for (const { drugPattern, minAge, description } of PAEDIATRIC_RESTRICTIONS) {
    for (const med of proposedMeds) {
      if (drugPattern.test(med) && patientAge < minAge) {
        alerts.push({
          drug1: med,
          drug2: `[PAEDIATRIC: age ${patientAge}]`,
          severity: "SEVERE",
          description,
        });
      }
    }
  }
  return alerts;
}

/**
 * Alert on drugs that require dose adjustment or avoidance based on the
 * patient's estimated GFR (e.g. metformin, NSAIDs, digoxin). Returns an empty
 * array when `eGFR` is undefined.
 */
export function checkRenalDosing(
  proposedMeds: string[],
  eGFR: number | undefined
): DrugInteractionAlert[] {
  if (eGFR === undefined) return [];
  const alerts: DrugInteractionAlert[] = [];
  for (const { drugPattern, eGFRThreshold, severity, description } of RENAL_RESTRICTIONS) {
    for (const med of proposedMeds) {
      if (drugPattern.test(med) && eGFR < eGFRThreshold) {
        alerts.push({
          drug1: med,
          drug2: `[RENAL: eGFR ${eGFR} mL/min]`,
          severity,
          description,
        });
      }
    }
  }
  return alerts;
}

/**
 * Flag drugs contraindicated or requiring caution in hepatic impairment (e.g.
 * statins, azole antifungals, valproate). Severity thresholds are applied based
 * on the patient's impairment level (mild/moderate/severe).
 */
export function checkHepaticContraindications(
  proposedMeds: string[],
  hepaticImpairment: "mild" | "moderate" | "severe" | null
): DrugInteractionAlert[] {
  if (hepaticImpairment === null || hepaticImpairment === undefined) return [];
  const alerts: DrugInteractionAlert[] = [];
  const patientSeverityLevel = HEPATIC_SEVERITY_ORDER[hepaticImpairment];
  for (const { drugPattern, severity, minImpairment, description } of HEPATIC_RESTRICTIONS) {
    if (patientSeverityLevel >= HEPATIC_SEVERITY_ORDER[minImpairment]) {
      for (const med of proposedMeds) {
        if (drugPattern.test(med)) {
          alerts.push({
            drug1: med,
            drug2: `[HEPATIC: ${hepaticImpairment} impairment]`,
            severity,
            description,
          });
        }
      }
    }
  }
  return alerts;
}

// ─── Generic alternatives lookup ─────────────────────────────────────────────

async function getGenericAlternatives(
  proposedMedNames: string[]
): Promise<{ brandName: string; generics: string[] }[]> {
  const results: { brandName: string; generics: string[] }[] = [];

  for (const medName of proposedMedNames) {
    // Extract first meaningful word (at least 4 chars) for the search keyword
    const keyword = medName.trim().split(/\s+/).find((w) => w.length >= 4) ?? medName.trim();
    if (!keyword) continue;

    try {
      // Find medicines whose name or genericName contains the keyword
      // and have a genericName set; exclude exact case-insensitive match in JS
      const candidates = await prisma.medicine.findMany({
        where: {
          AND: [
            {
              OR: [
                { name: { contains: keyword, mode: "insensitive" } },
                { genericName: { contains: keyword, mode: "insensitive" } },
              ],
            },
            { genericName: { not: null } },
          ],
        },
        select: { name: true, genericName: true },
        take: 10,
      });

      const medNameLower = medName.toLowerCase();
      const matches = candidates
        .filter((m) => m.name.toLowerCase() !== medNameLower)
        .slice(0, 3);

      if (matches.length > 0) {
        results.push({
          brandName: medName,
          generics: matches.map((m) => m.genericName ?? m.name),
        });
      }
    } catch {
      // Non-fatal — skip this med
    }
  }

  return results;
}

// ─── LLM comprehensive check ──────────────────────────────────────────────────

async function checkWithAI(
  proposedMeds: { name: string; dose: string; frequency: string }[],
  currentMeds: string[],
  allergies: string[],
  chronicConditions: string[],
  patientMeta: {
    age?: number;
    gender?: string;
    weightKg?: number;
    eGFR?: number;
    hepaticImpairment?: "mild" | "moderate" | "severe" | null;
    pregnancyWeeks?: number;
  }
): Promise<DrugInteractionAlert[]> {
  const prompt = `Patient context:
- Age: ${patientMeta.age ?? "unknown"}, Gender: ${patientMeta.gender ?? "unknown"}
- Weight: ${patientMeta.weightKg !== undefined ? `${patientMeta.weightKg} kg` : "unknown"}
- eGFR: ${patientMeta.eGFR !== undefined ? `${patientMeta.eGFR} mL/min` : "unknown"}
- Hepatic impairment: ${patientMeta.hepaticImpairment ?? "none"}
- Pregnancy: ${patientMeta.pregnancyWeeks !== undefined ? `${patientMeta.pregnancyWeeks} weeks` : "N/A"}
- Known allergies: ${allergies.join(", ") || "none"}
- Chronic conditions: ${chronicConditions.join(", ") || "none"}
- Current medications: ${currentMeds.join(", ") || "none"}

Newly proposed medications:
${proposedMeds.map((m) => `- ${m.name} ${m.dose} ${m.frequency}`).join("\n")}

Identify any MODERATE, SEVERE, or CONTRAINDICATED drug-drug interactions, allergy contraindications, or condition-specific contraindications. Only report interactions you are confident about with clear clinical evidence. Do not report MILD interactions.`;

  const response = await sarvam.chat.completions.create({
    model: "sarvam-105b",
    max_tokens: 1024,
    tools: [
      {
        type: "function",
        function: {
          name: "report_drug_interactions",
          description: "Report clinically significant interactions",
          parameters: {
            type: "object",
            properties: {
              interactions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    drug1: { type: "string" },
                    drug2: { type: "string" },
                    severity: { type: "string", enum: ["MILD", "MODERATE", "SEVERE", "CONTRAINDICATED"] },
                    description: { type: "string" },
                  },
                  required: ["drug1", "drug2", "severity", "description"],
                },
              },
            },
            required: ["interactions"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "report_drug_interactions" } },
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.choices[0]?.message?.tool_calls?.[0];
  const toolCall = raw?.type === "function" ? raw : undefined;
  if (!toolCall) return [];
  return ((JSON.parse(toolCall.function.arguments) as any).interactions as DrugInteractionAlert[]) || [];
}

// ─── Combined public API ──────────────────────────────────────────────────────

/** Aggregated output of the two-layer drug safety check. */
export interface DrugSafetyReport {
  alerts: DrugInteractionAlert[];
  hasContraindicated: boolean;
  hasSevere: boolean;
  checkedAt: string;
  checkedMeds: string[];
  genericAlternatives: { brandName: string; generics: string[] }[];
}

/**
 * Run a full two-layer drug safety check on a proposed medication list.
 * Layer 1 runs deterministic rule checks (allergy, DDI, condition, paediatric,
 * renal, hepatic) synchronously — no API key required. Layer 2 sends the
 * full context to the Sarvam LLM for additional interaction discovery, and is
 * silently skipped if `SARVAM_API_KEY` is absent or the call fails.
 * Also looks up generic alternatives via the medicine catalogue.
 */
export async function checkDrugSafety(
  proposedMeds: { name: string; dose: string; frequency: string; duration: string }[],
  currentMeds: string[],
  allergies: string[],
  chronicConditions: string[],
  patientMeta: {
    age?: number;
    gender?: string;
    weightKg?: number;
    eGFR?: number;
    hepaticImpairment?: "mild" | "moderate" | "severe" | null;
    pregnancyWeeks?: number;
  } = {}
): Promise<DrugSafetyReport> {
  const medNames = proposedMeds.map((m) => m.name);

  // Layer 1 — fast deterministic (always runs, no API key needed)
  const deterministicAlerts = [
    ...checkAllergyContraindications(medNames, allergies),
    ...checkKnownDrugInteractions(medNames, currentMeds),
    ...checkConditionContraindications(medNames, chronicConditions),
    ...checkPaediatricContraindications(medNames, patientMeta.age),
    ...checkRenalDosing(medNames, patientMeta.eGFR),
    ...checkHepaticContraindications(medNames, patientMeta.hepaticImpairment ?? null),
  ];

  // Layer 2 — LLM (only if API key is present; non-fatal if it fails)
  let llmAlerts: DrugInteractionAlert[] = [];
  if (process.env.SARVAM_API_KEY && proposedMeds.length > 0) {
    try {
      const raw = await checkWithAI(proposedMeds, currentMeds, allergies, chronicConditions, patientMeta);
      // Deduplicate against deterministic results
      const detKeys = new Set(
        deterministicAlerts.map((a) => `${a.drug1}|${a.drug2}`.toLowerCase())
      );
      llmAlerts = raw.filter((a) => !detKeys.has(`${a.drug1}|${a.drug2}`.toLowerCase()));
    } catch {
      // non-fatal — deterministic results are still valid
    }
  }

  const alerts = [...deterministicAlerts, ...llmAlerts];

  const genericAlternatives = await getGenericAlternatives(medNames).catch(() => []);

  return {
    alerts,
    hasContraindicated: alerts.some((a) => a.severity === "CONTRAINDICATED"),
    hasSevere: alerts.some((a) => a.severity === "SEVERE"),
    checkedAt: new Date().toISOString(),
    checkedMeds: medNames,
    genericAlternatives,
  };
}
