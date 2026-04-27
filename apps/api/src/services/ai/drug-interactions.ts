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
// Curated against Stockley's Drug Interactions and Goodman & Gilman's
// Pharmacologic Basis of Therapeutics for Child-Pugh A (mild) / B (moderate) / C
// (severe) hepatic impairment.

interface HepaticRule {
  drugPattern: RegExp;
  drugLabel: string; // canonical generic name(s) for reporting
  action: "AVOID" | "DOSE_REDUCE" | "MONITOR";
  severity: DrugInteractionAlert["severity"];
  minImpairment: "mild" | "moderate" | "severe";
  rationale: string; // 1-line clinician-readable
  alternatives?: string[];
}

const HEPATIC_RESTRICTIONS: HepaticRule[] = [
  // Analgesics / antipyretics
  { drugPattern: /paracetamol|acetaminophen/i, drugLabel: "paracetamol", action: "DOSE_REDUCE", severity: "MODERATE", minImpairment: "mild", rationale: "Paracetamol: max 3 g/day in mild hepatic impairment, max 2 g/day in cirrhosis; avoid in severe acute liver failure.", alternatives: ["topical NSAID (no systemic load)", "physical measures"] },
  // NSAIDs
  { drugPattern: /ibuprofen/i, drugLabel: "ibuprofen", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "NSAIDs: hepatorenal syndrome risk in cirrhosis; precipitate variceal bleeding via platelet dysfunction.", alternatives: ["paracetamol (dose-reduced)"] },
  { drugPattern: /diclofenac/i, drugLabel: "diclofenac", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Diclofenac: idiosyncratic hepatotoxicity plus hepatorenal risk in advanced liver disease.", alternatives: ["paracetamol (dose-reduced)"] },
  { drugPattern: /naproxen/i, drugLabel: "naproxen", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Naproxen: hepatorenal syndrome and GI bleeding risk in cirrhosis.", alternatives: ["paracetamol (dose-reduced)"] },
  // Cytotoxics / DMARDs
  { drugPattern: /methotrexate/i, drugLabel: "methotrexate", action: "AVOID", severity: "CONTRAINDICATED", minImpairment: "mild", rationale: "Methotrexate is directly hepatotoxic — contraindicated in any active liver disease; chronic use causes fibrosis.", alternatives: ["sulfasalazine", "leflunomide (with monitoring)"] },
  // Statins
  { drugPattern: /atorvastatin/i, drugLabel: "atorvastatin", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Statins: contraindicated in active liver disease or unexplained persistent ALT elevation > 3× ULN.", alternatives: ["lifestyle/diet first", "ezetimibe (lower hepatic load)"] },
  { drugPattern: /simvastatin|lovastatin/i, drugLabel: "simvastatin", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Simvastatin: extensive CYP3A4 metabolism, raised levels in hepatic impairment increase rhabdomyolysis risk.", alternatives: ["pravastatin (less hepatic load)", "ezetimibe"] },
  { drugPattern: /rosuvastatin/i, drugLabel: "rosuvastatin", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Rosuvastatin: contraindicated in active liver disease; levels rise markedly in Child-Pugh B/C.", alternatives: ["lifestyle/diet first", "ezetimibe"] },
  // Antiarrhythmics
  { drugPattern: /amiodarone/i, drugLabel: "amiodarone", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Amiodarone: hepatotoxic (steatohepatitis, fibrosis, fatal hepatitis); avoid in pre-existing liver disease.", alternatives: ["β-blocker for rate control", "non-pharmacologic management"] },
  // Anticonvulsants / mood stabilisers
  { drugPattern: /valproate|valproic acid|sodium valproate|divalproex/i, drugLabel: "valproate", action: "AVOID", severity: "CONTRAINDICATED", minImpairment: "mild", rationale: "Valproate: idiosyncratic fatal hepatotoxicity, contraindicated in any hepatic dysfunction.", alternatives: ["levetiracetam", "lamotrigine"] },
  { drugPattern: /carbamazepine/i, drugLabel: "carbamazepine", action: "AVOID", severity: "SEVERE", minImpairment: "mild", rationale: "Carbamazepine: hepatotoxic; cholestatic and hepatocellular injury reported in pre-existing liver disease.", alternatives: ["levetiracetam", "lamotrigine"] },
  // Antitubercular
  { drugPattern: /isoniazid/i, drugLabel: "isoniazid", action: "DOSE_REDUCE", severity: "SEVERE", minImpairment: "moderate", rationale: "Isoniazid: dose-dependent hepatotoxicity; reduce dose and monitor LFTs every 2 weeks in moderate-severe impairment.", alternatives: ["modified DOTS regimen under specialist care"] },
  { drugPattern: /rifampicin|rifampin/i, drugLabel: "rifampicin", action: "MONITOR", severity: "SEVERE", minImpairment: "moderate", rationale: "Rifampicin: hepatotoxic, raises bilirubin via OATP inhibition; avoid combination with isoniazid in moderate-severe impairment.", alternatives: ["specialist-led regimen with LFT monitoring"] },
  // Macrolides
  { drugPattern: /erythromycin/i, drugLabel: "erythromycin", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Erythromycin estolate: cholestatic jaundice; avoid in cholestatic liver disease.", alternatives: ["azithromycin (lower hepatotoxicity)", "clarithromycin (avoid in severe)"] },
  // Antifungals (oral azoles)
  { drugPattern: /ketoconazole/i, drugLabel: "ketoconazole (oral)", action: "AVOID", severity: "CONTRAINDICATED", minImpairment: "mild", rationale: "Oral ketoconazole: contraindicated due to fatal idiosyncratic hepatitis (FDA/EMA black box).", alternatives: ["topical ketoconazole", "fluconazole (with caution)", "terbinafine"] },
  { drugPattern: /itraconazole/i, drugLabel: "itraconazole", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Oral itraconazole: hepatotoxic, avoid in active liver disease; if essential, use lowest dose with weekly LFTs.", alternatives: ["fluconazole (with caution)", "voriconazole (specialist)"] },
  { drugPattern: /fluconazole/i, drugLabel: "fluconazole", action: "DOSE_REDUCE", severity: "MODERATE", minImpairment: "moderate", rationale: "Fluconazole: dose-related hepatotoxicity; halve dose and monitor LFTs in moderate impairment.", alternatives: ["topical antifungal where feasible"] },
  // Antipsychotics
  { drugPattern: /chlorpromazine/i, drugLabel: "chlorpromazine", action: "AVOID", severity: "SEVERE", minImpairment: "moderate", rationale: "Chlorpromazine: cholestatic hepatitis in 1–2% of users; avoid in pre-existing liver disease.", alternatives: ["haloperidol (dose-reduced)", "risperidone"] },
  { drugPattern: /haloperidol/i, drugLabel: "haloperidol", action: "DOSE_REDUCE", severity: "MODERATE", minImpairment: "moderate", rationale: "Haloperidol: hepatic clearance reduced; halve initial dose and titrate to effect in moderate-severe impairment.", alternatives: ["lower starting dose with slow titration"] },
  // Antibiotics / antiprotozoal
  { drugPattern: /metronidazole/i, drugLabel: "metronidazole", action: "DOSE_REDUCE", severity: "MODERATE", minImpairment: "severe", rationale: "Metronidazole: extensive hepatic metabolism; reduce dose by 50% and extend interval in severe impairment.", alternatives: ["tinidazole (with same caution)"] },
  // Opioids
  { drugPattern: /tramadol/i, drugLabel: "tramadol", action: "DOSE_REDUCE", severity: "MODERATE", minImpairment: "moderate", rationale: "Tramadol: extensive CYP3A4/CYP2D6 metabolism; max 50 mg every 12 hours in cirrhosis. Lowered seizure threshold.", alternatives: ["paracetamol (dose-reduced) ± low-dose morphine immediate release"] },
];

// Severity ordering for hepatic impairment comparison
const HEPATIC_SEVERITY_ORDER: Record<"mild" | "moderate" | "severe", number> = {
  mild: 1,
  moderate: 2,
  severe: 3,
};

// ─── Pediatric weight-based dosing rules ─────────────────────────────────────
// Curated against the Indian Academy of Pediatrics (IAP) Standard Treatment
// Guidelines, WHO Pocket Book of Hospital Care for Children, and the BNF for
// Children. Doses are per-administration unless otherwise noted; `frequency`
// uses standard prescription notation (Q6H = every 6 hours). `maxDailyMg` is
// the absolute ceiling regardless of weight (small adult dose cap).

interface PediatricDoseRule {
  drugPattern: RegExp;
  drugLabel: string;
  ageBandMonths?: { min: number; max: number };
  weightBandKg?: { min: number; max: number };
  doseMgPerKg: number; // single (per-administration) dose
  frequency: "OD" | "BD" | "TDS" | "QID" | "Q4H" | "Q6H" | "Q8H" | "Q12H";
  maxDoseMg?: number; // single-dose ceiling (mg)
  maxDailyMg: number; // total daily ceiling (mg)
  durationDaysMax?: number;
  notes?: string;
  // Tolerance applied to the per-kg dose when comparing the prescribed dose to
  // the rule. Default is ±25% — covers normal rounding to commercial strengths.
  toleranceFraction?: number;
}

const PEDIATRIC_DOSING: PediatricDoseRule[] = [
  // Paracetamol — 15 mg/kg Q6H, max 60 mg/kg/day, infants ≥3 mo
  { drugPattern: /paracetamol|acetaminophen/i, drugLabel: "paracetamol", ageBandMonths: { min: 3, max: 12 * 18 }, doseMgPerKg: 15, frequency: "Q6H", maxDoseMg: 1000, maxDailyMg: 4000, notes: "Max 60 mg/kg/day; not to exceed 4 g/day; minimum age 3 months." },
  // Ibuprofen — 10 mg/kg Q8H, max 30 mg/kg/day, ≥6 mo (avoid <3 mo handled by PAEDIATRIC_RESTRICTIONS-style age gate below)
  { drugPattern: /ibuprofen/i, drugLabel: "ibuprofen", ageBandMonths: { min: 6, max: 12 * 18 }, doseMgPerKg: 10, frequency: "Q8H", maxDoseMg: 400, maxDailyMg: 1200, notes: "Avoid <3 months; use with caution 3–6 months; max 30 mg/kg/day." },
  // Amoxicillin — 25 mg/kg/dose BD or 15 mg/kg/dose TDS, max 1 g/dose
  { drugPattern: /amoxicillin/i, drugLabel: "amoxicillin", ageBandMonths: { min: 1, max: 12 * 18 }, doseMgPerKg: 25, frequency: "BD", maxDoseMg: 1000, maxDailyMg: 3000, notes: "25 mg/kg BD (or 15 mg/kg TDS); max 1 g/dose. Higher doses for AOM/severe infection up to 45 mg/kg BD." },
  // Amoxiclav — same band as amoxicillin (by amox component)
  { drugPattern: /amoxiclav|amoxycillin\s*\+\s*clav|co.amoxiclav|augmentin/i, drugLabel: "amoxiclav", ageBandMonths: { min: 1, max: 12 * 18 }, doseMgPerKg: 25, frequency: "BD", maxDoseMg: 1000, maxDailyMg: 3000, notes: "Dose by amoxicillin component (25 mg/kg BD)." },
  // Azithromycin — 10 mg/kg OD day 1 then 5 mg/kg OD × 4d, max 500 mg/dose
  { drugPattern: /azithromycin/i, drugLabel: "azithromycin", ageBandMonths: { min: 6, max: 12 * 18 }, doseMgPerKg: 10, frequency: "OD", maxDoseMg: 500, maxDailyMg: 500, durationDaysMax: 5, notes: "10 mg/kg OD on day 1 (max 500 mg), then 5 mg/kg OD × 4 days." },
  // Cefixime — 4 mg/kg BD, max 200 mg/dose
  { drugPattern: /cefixime/i, drugLabel: "cefixime", ageBandMonths: { min: 6, max: 12 * 18 }, doseMgPerKg: 4, frequency: "BD", maxDoseMg: 200, maxDailyMg: 400, notes: "4 mg/kg BD; total daily 8 mg/kg up to 400 mg." },
  // Ondansetron — 0.15 mg/kg, max 4 mg/dose
  { drugPattern: /ondansetron/i, drugLabel: "ondansetron", ageBandMonths: { min: 6, max: 12 * 18 }, doseMgPerKg: 0.15, frequency: "Q8H", maxDoseMg: 4, maxDailyMg: 16, notes: "0.15 mg/kg per dose; absolute ceiling 4 mg/dose regardless of weight (QT prolongation)." },
  // Albendazole — 200 mg <2 y, 400 mg ≥2 y; modelled as fixed-by-age. Use weightBandKg as a no-op gate.
  { drugPattern: /albendazole/i, drugLabel: "albendazole", ageBandMonths: { min: 12, max: 24 }, doseMgPerKg: 0, frequency: "OD", maxDoseMg: 200, maxDailyMg: 200, durationDaysMax: 1, notes: "Fixed dose: 200 mg single dose for age 12–24 months. Not weight-based." },
  { drugPattern: /albendazole/i, drugLabel: "albendazole", ageBandMonths: { min: 24, max: 12 * 18 }, doseMgPerKg: 0, frequency: "OD", maxDoseMg: 400, maxDailyMg: 400, durationDaysMax: 1, notes: "Fixed dose: 400 mg single dose for ≥2 years. Not weight-based." },
  // Co-trimoxazole — 4 mg/kg/dose TMP component BD
  { drugPattern: /co.trimoxazole|cotrimoxazole|septran|bactrim|sulfamethoxazole.*trimethoprim|trimethoprim.*sulfamethoxazole/i, drugLabel: "co-trimoxazole", ageBandMonths: { min: 2, max: 12 * 18 }, doseMgPerKg: 4, frequency: "BD", maxDoseMg: 160, maxDailyMg: 320, notes: "Dose by trimethoprim component: 4 mg TMP/kg BD (8 mg/kg/day); max 160 mg TMP per dose." },
];

// Per-administration -> doses-per-day multiplier for total daily dose checks.
const FREQUENCY_DOSES_PER_DAY: Record<PediatricDoseRule["frequency"], number> = {
  OD: 1,
  BD: 2,
  TDS: 3,
  QID: 4,
  Q4H: 6,
  Q6H: 4,
  Q8H: 3,
  Q12H: 2,
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
  for (const rule of HEPATIC_RESTRICTIONS) {
    if (patientSeverityLevel >= HEPATIC_SEVERITY_ORDER[rule.minImpairment]) {
      for (const med of proposedMeds) {
        if (rule.drugPattern.test(med)) {
          alerts.push({
            drug1: med,
            drug2: `[HEPATIC: ${hepaticImpairment} impairment]`,
            severity: rule.severity,
            description: rule.rationale,
          });
        }
      }
    }
  }
  return alerts;
}

// ─── New per-drug hepatic risk lookup ────────────────────────────────────────

/** Structured hepatic-risk result for a single drug. */
export interface HepaticRiskResult {
  drugName: string;
  matchedRule: string; // canonical drug label from rule table
  action: "AVOID" | "DOSE_REDUCE" | "MONITOR";
  severity: DrugInteractionAlert["severity"];
  rationale: string;
  alternatives: string[];
  patientImpairment: "MILD" | "MODERATE" | "SEVERE";
}

/**
 * Look up the hepatic-impairment safety profile for a single drug. Returns
 * `null` when there is no matching rule for the drug, or when the patient has
 * `NONE` impairment, or when the patient's impairment is below the rule's
 * threshold (e.g. a "moderate"-only rule for a patient with "mild" disease).
 */
export function checkHepaticRisk(
  drugName: string,
  hepaticImpairment: "NONE" | "MILD" | "MODERATE" | "SEVERE"
): HepaticRiskResult | null {
  if (hepaticImpairment === "NONE") return null;
  const internal = hepaticImpairment.toLowerCase() as "mild" | "moderate" | "severe";
  const patientLevel = HEPATIC_SEVERITY_ORDER[internal];

  for (const rule of HEPATIC_RESTRICTIONS) {
    if (!rule.drugPattern.test(drugName)) continue;
    if (patientLevel < HEPATIC_SEVERITY_ORDER[rule.minImpairment]) continue;
    return {
      drugName,
      matchedRule: rule.drugLabel,
      action: rule.action,
      severity: rule.severity,
      rationale: rule.rationale,
      alternatives: rule.alternatives ?? [],
      patientImpairment: hepaticImpairment,
    };
  }
  return null;
}

// ─── Pediatric weight-based dosing checker ───────────────────────────────────

/** Outcome of a single pediatric dose check. */
export interface PediatricDoseResult {
  drugName: string;
  matchedRule: string; // canonical drug label from rule table
  weightKg: number;
  ageMonths: number;
  prescribedDoseMg: number;
  prescribedFrequency: string;
  expectedDoseMg: number; // dose * weight (capped at rule.maxDoseMg)
  expectedDailyMg: number;
  prescribedDailyMg: number;
  status: "OK" | "UNDER_DOSE" | "OVER_DOSE_SINGLE" | "OVER_DAILY_CAP" | "AGE_OUT_OF_BAND";
  severity: DrugInteractionAlert["severity"];
  rationale: string;
  notes?: string;
}

const FREQUENCY_NORMALISE_MAP: Record<string, PediatricDoseRule["frequency"]> = {
  OD: "OD", QD: "OD", DAILY: "OD", "ONCE DAILY": "OD",
  BD: "BD", BID: "BD", "TWICE DAILY": "BD", Q12H: "Q12H",
  TDS: "TDS", TID: "TDS", "THRICE DAILY": "TDS", Q8H: "Q8H",
  QID: "QID", QDS: "QID", "FOUR TIMES DAILY": "QID", Q6H: "Q6H",
  Q4H: "Q4H",
};

function normaliseFrequency(freq: string): PediatricDoseRule["frequency"] | null {
  const key = freq.trim().toUpperCase().replace(/\./g, "");
  return FREQUENCY_NORMALISE_MAP[key] ?? null;
}

/**
 * Validate a pediatric prescription against curated weight-based rules.
 *
 * Returns `null` when the drug is not in the pediatric rule set, when the
 * patient's age does not fall in any rule's age band, or when essential inputs
 * (weightKg, dosageMg) are missing/invalid. A non-null result indicates either
 * a passing check (`status: "OK"`) or a flag (under-dose, over-dose, daily-cap
 * breach, or age out of band).
 */
export function checkPediatricDose(
  drugName: string,
  dosageMg: number,
  frequency: string,
  weightKg: number,
  ageMonths: number
): PediatricDoseResult | null {
  if (!drugName || !Number.isFinite(dosageMg) || dosageMg <= 0) return null;
  if (!Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!Number.isFinite(ageMonths) || ageMonths < 0) return null;

  const candidateRules = PEDIATRIC_DOSING.filter((r) => r.drugPattern.test(drugName));
  if (candidateRules.length === 0) return null;

  // Pick the rule whose age band matches; if none, surface the closest (lowest min)
  // rule with status AGE_OUT_OF_BAND so the caller can warn.
  const inBand = candidateRules.find(
    (r) => !r.ageBandMonths || (ageMonths >= r.ageBandMonths.min && ageMonths < r.ageBandMonths.max)
  );

  if (!inBand) {
    const fallback = candidateRules[0];
    return {
      drugName,
      matchedRule: fallback.drugLabel,
      weightKg,
      ageMonths,
      prescribedDoseMg: dosageMg,
      prescribedFrequency: frequency,
      expectedDoseMg: 0,
      expectedDailyMg: 0,
      prescribedDailyMg: 0,
      status: "AGE_OUT_OF_BAND",
      severity: "MODERATE",
      rationale: `${fallback.drugLabel}: patient age ${ageMonths} months falls outside the validated dosing band (${fallback.ageBandMonths?.min}–${fallback.ageBandMonths?.max} months). Verify with current pediatric formulary before prescribing.`,
      notes: fallback.notes,
    };
  }

  const normalisedFreq = normaliseFrequency(frequency) ?? inBand.frequency;
  const dosesPerDay = FREQUENCY_DOSES_PER_DAY[normalisedFreq];
  const tolerance = inBand.toleranceFraction ?? 0.25;

  // Fixed-dose rules (e.g. albendazole) — doseMgPerKg is 0; just compare to maxDoseMg.
  if (inBand.doseMgPerKg === 0 && inBand.maxDoseMg !== undefined) {
    const target = inBand.maxDoseMg;
    if (dosageMg > target * (1 + tolerance)) {
      return {
        drugName,
        matchedRule: inBand.drugLabel,
        weightKg,
        ageMonths,
        prescribedDoseMg: dosageMg,
        prescribedFrequency: frequency,
        expectedDoseMg: target,
        expectedDailyMg: target,
        prescribedDailyMg: dosageMg * dosesPerDay,
        status: "OVER_DOSE_SINGLE",
        severity: "SEVERE",
        rationale: `${inBand.drugLabel}: prescribed ${dosageMg} mg exceeds the fixed pediatric dose of ${target} mg for this age band (${inBand.notes ?? ""}).`,
        notes: inBand.notes,
      };
    }
    if (dosageMg < target * (1 - tolerance)) {
      return {
        drugName,
        matchedRule: inBand.drugLabel,
        weightKg,
        ageMonths,
        prescribedDoseMg: dosageMg,
        prescribedFrequency: frequency,
        expectedDoseMg: target,
        expectedDailyMg: target,
        prescribedDailyMg: dosageMg * dosesPerDay,
        status: "UNDER_DOSE",
        severity: "MODERATE",
        rationale: `${inBand.drugLabel}: prescribed ${dosageMg} mg is below the fixed pediatric dose of ${target} mg for this age band — risk of treatment failure.`,
        notes: inBand.notes,
      };
    }
    return {
      drugName,
      matchedRule: inBand.drugLabel,
      weightKg,
      ageMonths,
      prescribedDoseMg: dosageMg,
      prescribedFrequency: frequency,
      expectedDoseMg: target,
      expectedDailyMg: target,
      prescribedDailyMg: dosageMg * dosesPerDay,
      status: "OK",
      severity: "MILD",
      rationale: `${inBand.drugLabel}: dose appropriate for age band.`,
      notes: inBand.notes,
    };
  }

  // Weight-based path
  const expectedSingleDose = Math.min(
    inBand.doseMgPerKg * weightKg,
    inBand.maxDoseMg ?? Number.POSITIVE_INFINITY
  );
  const expectedDailyDose = Math.min(expectedSingleDose * dosesPerDay, inBand.maxDailyMg);
  const prescribedDailyDose = dosageMg * dosesPerDay;

  // 1. Single-dose ceiling breach (always SEVERE — exceeds drug-specific cap).
  if (inBand.maxDoseMg !== undefined && dosageMg > inBand.maxDoseMg * (1 + tolerance)) {
    return {
      drugName,
      matchedRule: inBand.drugLabel,
      weightKg,
      ageMonths,
      prescribedDoseMg: dosageMg,
      prescribedFrequency: frequency,
      expectedDoseMg: expectedSingleDose,
      expectedDailyMg: expectedDailyDose,
      prescribedDailyMg: prescribedDailyDose,
      status: "OVER_DOSE_SINGLE",
      severity: "SEVERE",
      rationale: `${inBand.drugLabel}: single dose ${dosageMg} mg exceeds the absolute ceiling of ${inBand.maxDoseMg} mg/dose. Toxicity risk.`,
      notes: inBand.notes,
    };
  }

  // 2. Daily-cap breach.
  if (prescribedDailyDose > inBand.maxDailyMg * (1 + tolerance)) {
    return {
      drugName,
      matchedRule: inBand.drugLabel,
      weightKg,
      ageMonths,
      prescribedDoseMg: dosageMg,
      prescribedFrequency: frequency,
      expectedDoseMg: expectedSingleDose,
      expectedDailyMg: expectedDailyDose,
      prescribedDailyMg: prescribedDailyDose,
      status: "OVER_DAILY_CAP",
      severity: "SEVERE",
      rationale: `${inBand.drugLabel}: total daily dose ${prescribedDailyDose} mg exceeds the maximum daily ceiling of ${inBand.maxDailyMg} mg.`,
      notes: inBand.notes,
    };
  }

  // 3. Per-kg over-dose (above expected, but inside cap).
  if (dosageMg > expectedSingleDose * (1 + tolerance)) {
    return {
      drugName,
      matchedRule: inBand.drugLabel,
      weightKg,
      ageMonths,
      prescribedDoseMg: dosageMg,
      prescribedFrequency: frequency,
      expectedDoseMg: expectedSingleDose,
      expectedDailyMg: expectedDailyDose,
      prescribedDailyMg: prescribedDailyDose,
      status: "OVER_DOSE_SINGLE",
      severity: "MODERATE",
      rationale: `${inBand.drugLabel}: prescribed ${dosageMg} mg/dose exceeds the expected ${inBand.doseMgPerKg} mg/kg for ${weightKg} kg (≈ ${expectedSingleDose.toFixed(0)} mg).`,
      notes: inBand.notes,
    };
  }

  // 4. Under-dose.
  if (dosageMg < expectedSingleDose * (1 - tolerance)) {
    return {
      drugName,
      matchedRule: inBand.drugLabel,
      weightKg,
      ageMonths,
      prescribedDoseMg: dosageMg,
      prescribedFrequency: frequency,
      expectedDoseMg: expectedSingleDose,
      expectedDailyMg: expectedDailyDose,
      prescribedDailyMg: prescribedDailyDose,
      status: "UNDER_DOSE",
      severity: "MODERATE",
      rationale: `${inBand.drugLabel}: prescribed ${dosageMg} mg/dose is below the expected ${inBand.doseMgPerKg} mg/kg for ${weightKg} kg (≈ ${expectedSingleDose.toFixed(0)} mg). Risk of treatment failure.`,
      notes: inBand.notes,
    };
  }

  return {
    drugName,
    matchedRule: inBand.drugLabel,
    weightKg,
    ageMonths,
    prescribedDoseMg: dosageMg,
    prescribedFrequency: frequency,
    expectedDoseMg: expectedSingleDose,
    expectedDailyMg: expectedDailyDose,
    prescribedDailyMg: prescribedDailyDose,
    status: "OK",
    severity: "MILD",
    rationale: `${inBand.drugLabel}: dose within expected range for ${weightKg} kg / ${ageMonths} months.`,
    notes: inBand.notes,
  };
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
  /** Per-drug pediatric dosing checks (only populated when weight + age provided and patient is < 18 years). */
  pediatricDoseChecks?: PediatricDoseResult[];
  /** Per-drug hepatic risk look-ups (only populated when hepaticImpairment is non-NONE/inferred from conditions). */
  hepaticRiskChecks?: HepaticRiskResult[];
}

/**
 * Infer Child-Pugh-style hepatic impairment level from a patient's chronic
 * conditions list. Conservative — defaults to MODERATE on any liver-disease
 * keyword unless an explicit "severe"/"decompensated"/"end-stage" qualifier is
 * present. Returns "NONE" if nothing matches.
 */
export function inferHepaticImpairment(
  chronicConditions: string[]
): "NONE" | "MILD" | "MODERATE" | "SEVERE" {
  if (!chronicConditions || chronicConditions.length === 0) return "NONE";
  const blob = chronicConditions.join(" | ").toLowerCase();
  if (!/(hepatic|cirrhosis|liver disease|liver failure|hepatitis|chronic liver)/.test(blob)) {
    return "NONE";
  }
  if (/(severe|decompensated|end.?stage|child.?pugh\s*c|fulminant)/.test(blob)) return "SEVERE";
  if (/(mild|child.?pugh\s*a|compensated)/.test(blob)) return "MILD";
  return "MODERATE";
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
    ageMonths?: number;
    gender?: string;
    weightKg?: number;
    eGFR?: number;
    hepaticImpairment?: "mild" | "moderate" | "severe" | null;
    pregnancyWeeks?: number;
  } = {}
): Promise<DrugSafetyReport> {
  const medNames = proposedMeds.map((m) => m.name);

  // Auto-derive hepatic state from chronic conditions when caller didn't pass
  // an explicit value. Patients with documented cirrhosis / liver disease but
  // no Child-Pugh class default to MODERATE.
  const explicitHepatic = patientMeta.hepaticImpairment;
  let effectiveHepatic: "mild" | "moderate" | "severe" | null = explicitHepatic ?? null;
  if (!effectiveHepatic) {
    const inferred = inferHepaticImpairment(chronicConditions);
    if (inferred !== "NONE") effectiveHepatic = inferred.toLowerCase() as "mild" | "moderate" | "severe";
  }

  // Layer 1 — fast deterministic (always runs, no API key needed)
  const deterministicAlerts = [
    ...checkAllergyContraindications(medNames, allergies),
    ...checkKnownDrugInteractions(medNames, currentMeds),
    ...checkConditionContraindications(medNames, chronicConditions),
    ...checkPaediatricContraindications(medNames, patientMeta.age),
    ...checkRenalDosing(medNames, patientMeta.eGFR),
    ...checkHepaticContraindications(medNames, effectiveHepatic),
  ];

  // Per-drug hepatic risk lookups (structured results)
  const hepaticRiskChecks: HepaticRiskResult[] = [];
  if (effectiveHepatic) {
    const upper = effectiveHepatic.toUpperCase() as "MILD" | "MODERATE" | "SEVERE";
    for (const name of medNames) {
      const r = checkHepaticRisk(name, upper);
      if (r) hepaticRiskChecks.push(r);
    }
  }

  // Per-drug pediatric weight-based dose checks. Only run when patient is
  // clearly pediatric (< 18 y) AND we have a weight. Translate doctor-supplied
  // dose strings (e.g. "500mg", "10 ml of 250mg/5ml") to a numeric mg value
  // using a permissive regex; if we can't, we skip silently.
  const pediatricDoseChecks: PediatricDoseResult[] = [];
  const ageYears = patientMeta.age;
  const ageMonthsResolved =
    patientMeta.ageMonths ??
    (typeof ageYears === "number" ? Math.round(ageYears * 12) : undefined);
  const isPediatric =
    typeof ageMonthsResolved === "number" && ageMonthsResolved < 12 * 18;
  if (isPediatric && typeof patientMeta.weightKg === "number" && patientMeta.weightKg > 0) {
    for (const m of proposedMeds) {
      const dosageMg = parseDoseToMg(m.dose);
      if (dosageMg == null) continue;
      const result = checkPediatricDose(
        m.name,
        dosageMg,
        m.frequency,
        patientMeta.weightKg,
        ageMonthsResolved
      );
      if (!result) continue;
      pediatricDoseChecks.push(result);
      if (result.status !== "OK") {
        deterministicAlerts.push({
          drug1: m.name,
          drug2: `[PEDIATRIC: ${patientMeta.weightKg} kg, ${ageMonthsResolved} mo]`,
          severity: result.severity,
          description: result.rationale,
        });
      }
    }
  }

  // Layer 2 — LLM (only if API key is present; non-fatal if it fails)
  let llmAlerts: DrugInteractionAlert[] = [];
  if (process.env.SARVAM_API_KEY && proposedMeds.length > 0) {
    try {
      const raw = await checkWithAI(
        proposedMeds,
        currentMeds,
        allergies,
        chronicConditions,
        { ...patientMeta, hepaticImpairment: effectiveHepatic ?? undefined }
      );
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
    pediatricDoseChecks: pediatricDoseChecks.length > 0 ? pediatricDoseChecks : undefined,
    hepaticRiskChecks: hepaticRiskChecks.length > 0 ? hepaticRiskChecks : undefined,
  };
}

/**
 * Best-effort parse of a clinical dose string into milligrams. Handles common
 * patterns: "500mg", "0.5 g", "1 g", "250 mg", "5 ml of 250mg/5ml" (uses the
 * mg/ml ratio × ml). Returns `null` when no numeric mg dose can be inferred.
 */
function parseDoseToMg(doseStr: string): number | null {
  if (!doseStr) return null;
  const lower = doseStr.toLowerCase().trim();

  // mg per ml × ml form: "5 ml of 250mg/5ml" or "10 ml (200mg/5ml)"
  const ratio = lower.match(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)\s*ml/);
  const mlMatch = lower.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (ratio && mlMatch && !lower.includes("mg") || (ratio && mlMatch && !lower.includes(" mg "))) {
    const mgPerMl = parseFloat(ratio[1]) / parseFloat(ratio[2]);
    const ml = parseFloat(mlMatch[1]);
    if (Number.isFinite(mgPerMl) && Number.isFinite(ml)) return mgPerMl * ml;
  }

  // Direct mg form: first standalone "<num> mg"
  const mgMatch = lower.match(/(\d+(?:\.\d+)?)\s*mg(?!\s*\/\s*ml)/);
  if (mgMatch) return parseFloat(mgMatch[1]);

  // Gram form: "0.5 g", "1g"
  const gMatch = lower.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (gMatch) return parseFloat(gMatch[1]) * 1000;

  return null;
}
