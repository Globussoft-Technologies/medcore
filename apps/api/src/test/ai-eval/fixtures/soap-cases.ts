// Transcript→SOAP golden fixtures.
//
// 20 doctor-patient transcripts (8-15 turns each) with expected SOAP content
// at minimum-viable detail: chief complaint, key findings, primary diagnosis,
// key medications. We do NOT expect exact string match — the runner uses a
// Jaccard token-similarity threshold per field (default 0.4).
//
// All cases are synthetic. Patient names are generic ("Patient A").

export interface SoapCase {
  id: string;
  description: string;
  transcript: { speaker: "DOCTOR" | "PATIENT"; text: string; timestamp: string }[];
  patientContext: {
    allergies: string[];
    currentMedications: string[];
    chronicConditions: string[];
    age?: number;
    gender?: string;
  };
  /** Dot-notation paths that must be non-empty. */
  requiredFields: string[];
  /** Strings that MUST NOT appear in the output (hallucination check). */
  forbiddenContent?: string[];
  /** Golden expected content for similarity scoring. Each value is the human
   *  reference; the runner tokenises and computes Jaccard against the model. */
  expected: {
    chiefComplaint: string;
    keyFindings: string;
    primaryDiagnosis: string;
    keyMedications: string[];
  };
  /** Per-case similarity threshold (Jaccard 0-1). Defaults to 0.4. */
  similarityThreshold?: number;
}

const ts = (n: number) => new Date(Date.UTC(2026, 3, 22, 9, 0, n)).toISOString();

export const SOAP_CASES: SoapCase[] = [
  {
    id: "soap-htn-followup",
    description: "Hypertension follow-up",
    transcript: [
      { speaker: "DOCTOR", text: "Good morning, how is your blood pressure these days?", timestamp: ts(0) },
      { speaker: "PATIENT", text: "Doctor, my BP was 160/100 yesterday at home, and 158/96 the day before.", timestamp: ts(10) },
      { speaker: "DOCTOR", text: "Any headache, dizziness, or chest tightness?", timestamp: ts(20) },
      { speaker: "PATIENT", text: "Yes a mild headache in the morning. No chest pain.", timestamp: ts(30) },
      { speaker: "DOCTOR", text: "Are you taking the amlodipine 5 mg regularly?", timestamp: ts(40) },
      { speaker: "PATIENT", text: "Yes every morning, but BP is still high.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "Let me examine you. BP today is 162/98, pulse 78 regular, no pedal oedema.", timestamp: ts(60) },
      { speaker: "DOCTOR", text: "Your hypertension is uncontrolled on monotherapy. I will continue amlodipine 5 mg and add telmisartan 40 mg once daily.", timestamp: ts(80) },
      { speaker: "DOCTOR", text: "Get a renal profile and ECG. Recheck BP in 2 weeks. Reduce salt intake.", timestamp: ts(100) },
    ],
    patientContext: { allergies: [], currentMedications: ["Amlodipine 5mg"], chronicConditions: ["Hypertension"], age: 55, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "subjective.hpi", "assessment.impression", "plan"],
    forbiddenContent: ["insulin", "metformin", "warfarin"],
    expected: {
      chiefComplaint: "uncontrolled hypertension",
      keyFindings: "BP 162/98 home BP elevated mild morning headache",
      primaryDiagnosis: "uncontrolled hypertension",
      keyMedications: ["amlodipine", "telmisartan"],
    },
  },
  {
    id: "soap-viral-fever",
    description: "Acute viral fever — paracetamol only",
    transcript: [
      { speaker: "PATIENT", text: "I have fever for 2 days, 101 F, body ache and sore throat.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any cough, breathlessness, vomiting, or diarrhoea?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No, just fever and weakness.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Let me check. Throat is mildly congested, chest clear, no rash, no neck stiffness. Temp 100.4.", timestamp: ts(40) },
      { speaker: "DOCTOR", text: "This looks like viral fever. Take paracetamol 650 mg three times a day for 3 days, plenty of fluids and rest.", timestamp: ts(60) },
      { speaker: "DOCTOR", text: "Come back if fever crosses 102, or you develop breathlessness, severe headache or rash.", timestamp: ts(80) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 28, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "plan"],
    forbiddenContent: ["amoxicillin", "azithromycin", "warfarin", "insulin"],
    expected: {
      chiefComplaint: "fever and sore throat 2 days",
      keyFindings: "throat mildly congested chest clear no rash",
      primaryDiagnosis: "viral fever",
      keyMedications: ["paracetamol"],
    },
  },
  {
    id: "soap-t2dm-newdx",
    description: "New-onset type 2 diabetes",
    transcript: [
      { speaker: "PATIENT", text: "I am very thirsty and urinating frequently for 2 months, also losing weight.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any family history of diabetes?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "My father has diabetes.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "I see your fasting sugar report says 198 and HbA1c is 9.2.", timestamp: ts(40) },
      { speaker: "DOCTOR", text: "You have type 2 diabetes. I am starting metformin 500 mg twice daily after meals.", timestamp: ts(55) },
      { speaker: "DOCTOR", text: "You also need a fundus examination, urine microalbumin and lipid profile.", timestamp: ts(75) },
      { speaker: "DOCTOR", text: "Diet — avoid sweets, soft drinks, and refined flour. 30 minutes brisk walk daily.", timestamp: ts(95) },
      { speaker: "PATIENT", text: "Doctor I am not on any other medicines.", timestamp: ts(105) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 47, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["insulin", "warfarin"],
    expected: {
      chiefComplaint: "polyuria polydipsia weight loss 2 months",
      keyFindings: "fasting glucose 198 hba1c 9.2",
      primaryDiagnosis: "type 2 diabetes mellitus newly diagnosed",
      keyMedications: ["metformin"],
    },
  },
  {
    id: "soap-lower-uti",
    description: "Uncomplicated cystitis",
    transcript: [
      { speaker: "PATIENT", text: "Burning urination since 2 days, frequent urge, no fever.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any back pain, vomiting, or blood in urine?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No, just lower abdomen discomfort.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Are you pregnant or could you be?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "No, my last period finished last week.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination: suprapubic mild tenderness, no flank tenderness, vitals normal.", timestamp: ts(60) },
      { speaker: "DOCTOR", text: "Likely uncomplicated lower UTI. I will prescribe nitrofurantoin 100 mg twice daily for 5 days. Drink plenty of water.", timestamp: ts(80) },
      { speaker: "DOCTOR", text: "Do a urine routine and culture before starting if possible. Return if fever or back pain develops.", timestamp: ts(100) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 32, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["ciprofloxacin and warfarin", "warfarin"],
    expected: {
      chiefComplaint: "burning urination frequency 2 days",
      keyFindings: "suprapubic tenderness no flank tenderness afebrile",
      primaryDiagnosis: "uncomplicated lower urinary tract infection",
      keyMedications: ["nitrofurantoin"],
    },
  },
  {
    id: "soap-asthma-exacerbation",
    description: "Mild asthma exacerbation",
    transcript: [
      { speaker: "PATIENT", text: "Doctor my asthma is acting up, wheezing and cough since last night, especially in the morning.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Are you using your salbutamol inhaler?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Yes about 4-5 times in last 24 hours, gives partial relief.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Any fever or cold?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "Mild cold for 3 days.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination: bilateral expiratory wheeze, SpO2 96% on room air, can speak full sentences. PEFR 70% of personal best.", timestamp: ts(60) },
      { speaker: "DOCTOR", text: "This is a mild exacerbation. Continue salbutamol inhaler as needed, start budesonide-formoterol inhaler 200/6 twice daily, and a 5-day course of prednisolone 40 mg once daily.", timestamp: ts(85) },
      { speaker: "DOCTOR", text: "Come back urgently if breathlessness worsens or you cannot speak in full sentences.", timestamp: ts(105) },
    ],
    patientContext: { allergies: [], currentMedications: ["Salbutamol inhaler"], chronicConditions: ["Asthma"], age: 29, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["warfarin", "metformin"],
    expected: {
      chiefComplaint: "wheezing cough asthma exacerbation",
      keyFindings: "bilateral expiratory wheeze spo2 96% pefr 70%",
      primaryDiagnosis: "mild asthma exacerbation",
      keyMedications: ["salbutamol", "budesonide-formoterol", "prednisolone"],
    },
  },
  {
    id: "soap-migraine",
    description: "Episodic migraine without aura",
    transcript: [
      { speaker: "PATIENT", text: "I get severe one-sided throbbing headache 2-3 times a month for last 1 year.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any nausea, light or sound sensitivity?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Yes nausea and I have to lie in a dark room.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "How long does each episode last?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "Usually full day, sleep helps.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Any visual disturbances or weakness?", timestamp: ts(55) },
      { speaker: "PATIENT", text: "No.", timestamp: ts(65) },
      { speaker: "DOCTOR", text: "Examination is normal. This is migraine without aura.", timestamp: ts(80) },
      { speaker: "DOCTOR", text: "For acute attacks take naproxen 500 mg early. Avoid common triggers — fasting, late nights, strong perfumes.", timestamp: ts(100) },
      { speaker: "DOCTOR", text: "Maintain a headache diary. If frequency rises above 4 per month we will discuss prophylaxis.", timestamp: ts(120) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 26, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["sumatriptan injection", "ergotamine"],
    expected: {
      chiefComplaint: "recurrent unilateral throbbing headache",
      keyFindings: "normal neurological examination nausea photophobia",
      primaryDiagnosis: "migraine without aura",
      keyMedications: ["naproxen"],
    },
  },
  {
    id: "soap-gerd",
    description: "GERD without alarm features",
    transcript: [
      { speaker: "PATIENT", text: "I get burning chest and acidic taste at night for 2 months.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any difficulty swallowing, weight loss, vomiting blood, or melaena?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No none of that.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "How is your diet — late dinners, spicy food, smoking, alcohol?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "I eat dinner late, lot of spicy food, no smoking or alcohol.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination is unremarkable, abdomen soft, no tenderness.", timestamp: ts(60) },
      { speaker: "DOCTOR", text: "Likely GERD. Start pantoprazole 40 mg before breakfast for 4 weeks.", timestamp: ts(80) },
      { speaker: "DOCTOR", text: "Eat dinner 3 hours before bed, raise head end of bed, reduce spicy food. Review in 4 weeks.", timestamp: ts(100) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 38, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["endoscopy now", "biopsy"],
    expected: {
      chiefComplaint: "burning chest acid reflux 2 months",
      keyFindings: "no alarm features abdomen soft",
      primaryDiagnosis: "gastroesophageal reflux disease",
      keyMedications: ["pantoprazole"],
    },
  },
  {
    id: "soap-anc-routine",
    description: "Routine antenatal visit at 24 weeks",
    transcript: [
      { speaker: "PATIENT", text: "I am 24 weeks pregnant, first pregnancy, here for routine check.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any bleeding, fluid leak, severe headache, or visual problems?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No nothing like that. Baby's movements are good.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Are you taking iron, calcium, and folic acid?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "Yes daily.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination: BP 118/76, weight gain appropriate, fundal height matches dates, fetal heart 144 bpm.", timestamp: ts(65) },
      { speaker: "DOCTOR", text: "Pregnancy is progressing normally. Continue iron, calcium, folic acid. Get OGTT in next 2 weeks.", timestamp: ts(85) },
      { speaker: "DOCTOR", text: "Tdap booster is due now. Watch for danger signs — bleeding, severe headache, decreased fetal movements.", timestamp: ts(105) },
    ],
    patientContext: { allergies: [], currentMedications: ["Iron", "Calcium", "Folic Acid"], chronicConditions: [], age: 27, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "objective.vitals", "plan"],
    forbiddenContent: ["misoprostol", "methotrexate"],
    expected: {
      chiefComplaint: "routine antenatal visit 24 weeks",
      keyFindings: "bp 118/76 fundal height matches dates fetal heart 144",
      primaryDiagnosis: "normal singleton pregnancy 24 weeks",
      keyMedications: ["iron", "calcium", "folic acid"],
    },
  },
  {
    id: "soap-paediatric-uri",
    description: "Paediatric upper respiratory infection",
    transcript: [
      { speaker: "PATIENT", text: "My 4-year-old has runny nose, cough and mild fever for 3 days.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Is she eating, drinking, and active?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Yes, eating less but drinking and playing.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Any fast breathing, wheezing, or ear pain?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "No.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination: alert, playful, temp 99.6, throat mildly congested, chest clear, ears normal, no rash.", timestamp: ts(65) },
      { speaker: "DOCTOR", text: "This is a viral URI. Paracetamol syrup 250 mg per dose if fever crosses 100, plenty of fluids, saline nasal drops.", timestamp: ts(90) },
      { speaker: "DOCTOR", text: "Return if fast breathing, refusal to feed, ear pulling, fever beyond 5 days, or seizure.", timestamp: ts(110) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 4, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "plan"],
    forbiddenContent: ["amoxicillin", "azithromycin", "aspirin"],
    expected: {
      chiefComplaint: "runny nose cough fever 3 days child",
      keyFindings: "alert playful throat mildly congested chest clear",
      primaryDiagnosis: "viral upper respiratory infection",
      keyMedications: ["paracetamol", "saline nasal drops"],
    },
  },
  {
    id: "soap-tonsillitis-strep",
    description: "Bacterial tonsillitis",
    transcript: [
      { speaker: "PATIENT", text: "My 8-year-old has high fever, very painful throat, and cannot swallow for 2 days.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any cough or runny nose?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No cough at all, only throat pain and fever.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: temp 102, both tonsils enlarged with white exudate, tender cervical lymph nodes, no cough.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "Centor score is high. Likely streptococcal pharyngitis.", timestamp: ts(70) },
      { speaker: "DOCTOR", text: "Start amoxicillin 500 mg three times a day for 10 days, paracetamol for fever and pain. Plenty of fluids.", timestamp: ts(90) },
      { speaker: "DOCTOR", text: "Complete the full course to prevent rheumatic fever. Return if rash develops or breathing difficulty.", timestamp: ts(110) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 8, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["warfarin", "insulin"],
    expected: {
      chiefComplaint: "high fever painful throat 2 days child",
      keyFindings: "tonsils enlarged white exudate tender cervical lymph nodes no cough",
      primaryDiagnosis: "streptococcal pharyngitis",
      keyMedications: ["amoxicillin", "paracetamol"],
    },
  },
  {
    id: "soap-cap-pneumonia",
    description: "Community-acquired pneumonia",
    transcript: [
      { speaker: "PATIENT", text: "I have fever, productive cough with greenish sputum and chest pain on right side for 4 days.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any breathlessness or blood in sputum?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Some breathlessness on walking. No blood.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: temp 101.6, RR 22, SpO2 95%, right lower zone crepitations and bronchial breath sounds.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "Chest X-ray shows right lower lobe consolidation. CURB-65 is 1.", timestamp: ts(70) },
      { speaker: "DOCTOR", text: "This is community-acquired pneumonia. Start amoxicillin-clavulanate 625 mg three times a day plus azithromycin 500 mg once daily for 5 days.", timestamp: ts(95) },
      { speaker: "DOCTOR", text: "Paracetamol for fever, plenty of fluids, review in 48-72 hours. Return earlier if breathlessness worsens.", timestamp: ts(115) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 52, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "objective.examinationFindings", "assessment.impression", "plan"],
    forbiddenContent: ["warfarin", "insulin"],
    expected: {
      chiefComplaint: "fever productive cough chest pain 4 days",
      keyFindings: "right lower zone crepitations consolidation x-ray",
      primaryDiagnosis: "community-acquired pneumonia",
      keyMedications: ["amoxicillin-clavulanate", "azithromycin", "paracetamol"],
    },
  },
  {
    id: "soap-hypothyroid-newdx",
    description: "Newly diagnosed hypothyroidism",
    transcript: [
      { speaker: "PATIENT", text: "Since 4 months I am gaining weight, feeling cold, hair fall, and constipation.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any periods irregularity or low mood?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Periods are heavier than before. Mood is also low.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Your TSH report is 18.4 with low free T4. This confirms primary hypothyroidism.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "Start levothyroxine 50 mcg once daily on empty stomach, 30 minutes before breakfast.", timestamp: ts(75) },
      { speaker: "DOCTOR", text: "Do not take it with calcium or iron. Recheck TSH in 8 weeks for dose adjustment.", timestamp: ts(95) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 34, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["methimazole", "carbimazole"],
    expected: {
      chiefComplaint: "weight gain cold intolerance hair fall 4 months",
      keyFindings: "tsh 18.4 free t4 low",
      primaryDiagnosis: "primary hypothyroidism",
      keyMedications: ["levothyroxine"],
    },
  },
  {
    id: "soap-osteoarthritis-knee",
    description: "Knee osteoarthritis",
    transcript: [
      { speaker: "PATIENT", text: "Both my knees pain when I climb stairs and walk long distance for 1 year.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any morning stiffness?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Yes about 15 minutes only.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Any swelling or redness?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "Occasional swelling, no redness.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination: bilateral knee crepitus, mild medial joint line tenderness, no effusion, full range slightly painful.", timestamp: ts(65) },
      { speaker: "DOCTOR", text: "X-ray showed medial joint space narrowing, consistent with osteoarthritis.", timestamp: ts(85) },
      { speaker: "DOCTOR", text: "Start paracetamol 1 g three times a day as needed and topical diclofenac. Quadriceps strengthening exercises and weight reduction are very important.", timestamp: ts(110) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 64, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["methotrexate", "warfarin"],
    expected: {
      chiefComplaint: "bilateral knee pain stairs walking 1 year",
      keyFindings: "knee crepitus medial joint line tenderness joint space narrowing",
      primaryDiagnosis: "bilateral knee osteoarthritis",
      keyMedications: ["paracetamol", "topical diclofenac"],
    },
  },
  {
    id: "soap-anxiety-gad",
    description: "Generalised anxiety disorder",
    transcript: [
      { speaker: "PATIENT", text: "For last 8 months I keep worrying about everything, sleep is poor, restless, muscle tension.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any thoughts of harming yourself?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No, never.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Are you able to work and manage daily life?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "Working with difficulty, very tired all the time.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Any panic attacks, palpitations, or specific triggers?", timestamp: ts(55) },
      { speaker: "PATIENT", text: "Occasional palpitations, no clear trigger.", timestamp: ts(65) },
      { speaker: "DOCTOR", text: "This sounds like generalised anxiety disorder. We will start escitalopram 10 mg once daily and refer for cognitive behavioural therapy.", timestamp: ts(95) },
      { speaker: "DOCTOR", text: "Effects take 2-4 weeks. Avoid alcohol and excess caffeine. Review in 2 weeks.", timestamp: ts(115) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 31, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["alprazolam long-term", "diazepam long-term"],
    expected: {
      chiefComplaint: "chronic worry poor sleep restlessness 8 months",
      keyFindings: "no suicidal ideation occasional palpitations",
      primaryDiagnosis: "generalised anxiety disorder",
      keyMedications: ["escitalopram"],
    },
  },
  {
    id: "soap-iron-deficiency",
    description: "Iron deficiency anaemia",
    transcript: [
      { speaker: "PATIENT", text: "I feel very tired for 3 months, breathless on climbing stairs, my periods are heavy.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any pica or pagophagia — eating ice or non-food items?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Yes I crave ice a lot.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: pallor of conjunctivae, koilonychia present, no lymphadenopathy or organomegaly.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "Your reports show haemoglobin 8.4, MCV 68, ferritin 6. This is iron-deficiency anaemia.", timestamp: ts(75) },
      { speaker: "DOCTOR", text: "Start ferrous sulphate 200 mg twice daily with vitamin C. Avoid taking with milk or tea.", timestamp: ts(95) },
      { speaker: "DOCTOR", text: "Investigate cause — gynaecology referral for menorrhagia. Recheck Hb in 4 weeks.", timestamp: ts(115) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 29, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["blood transfusion", "warfarin"],
    expected: {
      chiefComplaint: "fatigue breathlessness heavy periods 3 months",
      keyFindings: "pallor koilonychia hb 8.4 mcv 68 ferritin 6",
      primaryDiagnosis: "iron deficiency anaemia",
      keyMedications: ["ferrous sulphate"],
    },
  },
  {
    id: "soap-allergic-rhinitis",
    description: "Seasonal allergic rhinitis",
    transcript: [
      { speaker: "PATIENT", text: "Every spring I get severe sneezing, watery eyes, runny nose, itchy throat for 2 months.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any breathing difficulty or wheezing?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "Sometimes mild chest tightness during episodes.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: pale boggy nasal mucosa, clear discharge, conjunctival injection, chest clear.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "This is allergic rhinitis, possibly with mild allergic asthma component.", timestamp: ts(70) },
      { speaker: "DOCTOR", text: "Start cetirizine 10 mg once daily and fluticasone nasal spray 2 puffs each nostril once daily.", timestamp: ts(90) },
      { speaker: "DOCTOR", text: "Avoid known triggers, keep windows closed during high pollen days. Monitor for breathing issues.", timestamp: ts(110) },
    ],
    patientContext: { allergies: ["pollen"], currentMedications: [], chronicConditions: [], age: 26, gender: "F" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["epinephrine injection", "warfarin"],
    expected: {
      chiefComplaint: "seasonal sneezing watery eyes runny nose 2 months",
      keyFindings: "pale boggy nasal mucosa conjunctival injection chest clear",
      primaryDiagnosis: "allergic rhinitis",
      keyMedications: ["cetirizine", "fluticasone nasal spray"],
    },
  },
  {
    id: "soap-acute-gastroenteritis",
    description: "Acute viral gastroenteritis",
    transcript: [
      { speaker: "PATIENT", text: "Loose stools 6-7 times since yesterday, vomiting twice, mild abdominal cramps.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any blood in stools, high fever, or recent travel?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No blood, no fever, ate from a roadside place day before.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Are you able to drink fluids and pass urine normally?", timestamp: ts(35) },
      { speaker: "PATIENT", text: "Drinking water but urine is less.", timestamp: ts(45) },
      { speaker: "DOCTOR", text: "Examination: mild dehydration, dry mucosa, BP 110/70, abdomen soft, mild tenderness, no guarding.", timestamp: ts(65) },
      { speaker: "DOCTOR", text: "This is acute gastroenteritis with mild dehydration. ORS frequently after each loose stool, and oral rehydration solution sachets.", timestamp: ts(90) },
      { speaker: "DOCTOR", text: "Add ondansetron 4 mg if vomiting persists. Avoid antibiotics — likely viral. Bland diet. Return if blood in stools, persistent vomiting, or no urine for 8 hours.", timestamp: ts(115) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 30, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["ciprofloxacin", "metronidazole", "warfarin"],
    expected: {
      chiefComplaint: "loose stools vomiting 1 day",
      keyFindings: "mild dehydration dry mucosa abdomen soft mild tenderness",
      primaryDiagnosis: "acute viral gastroenteritis with mild dehydration",
      keyMedications: ["oral rehydration solution", "ondansetron"],
    },
  },
  {
    id: "soap-eczema-atopic",
    description: "Atopic eczema in child",
    transcript: [
      { speaker: "PATIENT", text: "My 3-year-old has itchy red patches on the elbow and knee folds for 2 months, gets worse at night.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any history of asthma or allergies in the family?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "I have allergic rhinitis.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: dry skin, lichenified erythematous patches in flexures of elbows and knees, no impetigo.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "This is atopic eczema. Apply moisturiser thickly twice daily, hydrocortisone 1% to inflamed areas twice daily for up to 7 days at a time.", timestamp: ts(80) },
      { speaker: "DOCTOR", text: "Use mild soap-free cleanser, avoid hot water and woollen clothing on skin. Cetirizine syrup at bedtime if itching disturbs sleep.", timestamp: ts(105) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 3, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["oral steroids", "methotrexate"],
    expected: {
      chiefComplaint: "itchy red patches flexures 2 months child",
      keyFindings: "dry skin lichenified erythematous patches flexures",
      primaryDiagnosis: "atopic eczema",
      keyMedications: ["moisturiser", "hydrocortisone 1%", "cetirizine syrup"],
    },
  },
  {
    id: "soap-dengue-suspected",
    description: "Suspected dengue without warning signs",
    transcript: [
      { speaker: "PATIENT", text: "High fever 103, body ache, headache, retro-orbital pain since 3 days. Many people in our area have dengue.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any bleeding, severe abdominal pain, persistent vomiting, or breathlessness?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No, just fever and weakness.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: temp 102.4, no rash, no bleeding, abdomen soft, BP 116/74, capillary refill normal.", timestamp: ts(50) },
      { speaker: "DOCTOR", text: "I will send dengue NS1, IgM, and CBC.", timestamp: ts(70) },
      { speaker: "DOCTOR", text: "Likely dengue without warning signs. Take paracetamol only — avoid ibuprofen, aspirin, or any NSAID. Drink plenty of fluids and ORS.", timestamp: ts(95) },
      { speaker: "DOCTOR", text: "Return urgently for any warning signs — severe abdominal pain, persistent vomiting, bleeding, lethargy. Daily CBC for next 3-4 days.", timestamp: ts(120) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 35, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["ibuprofen", "aspirin", "diclofenac", "warfarin"],
    expected: {
      chiefComplaint: "high fever body ache retro-orbital pain 3 days",
      keyFindings: "no warning signs no bleeding no rash bp normal",
      primaryDiagnosis: "suspected dengue without warning signs",
      keyMedications: ["paracetamol", "oral rehydration solution"],
    },
  },
  {
    id: "soap-low-back-mechanical",
    description: "Mechanical low back pain",
    transcript: [
      { speaker: "PATIENT", text: "Lower back pain for 10 days after lifting heavy boxes, eases with rest.", timestamp: ts(0) },
      { speaker: "DOCTOR", text: "Any pain radiating down the leg, weakness, numbness, or loss of bladder or bowel control?", timestamp: ts(15) },
      { speaker: "PATIENT", text: "No, just localised back pain.", timestamp: ts(25) },
      { speaker: "DOCTOR", text: "Examination: paraspinal muscle spasm in lumbar area, normal SLR, normal power and sensation in legs, no saddle anaesthesia.", timestamp: ts(55) },
      { speaker: "DOCTOR", text: "This is mechanical low back pain — no red flags. Imaging is not indicated now.", timestamp: ts(80) },
      { speaker: "DOCTOR", text: "Paracetamol 1 g three times a day for 5 days. Stay active as tolerated, hot fomentation, core strengthening exercises after pain settles.", timestamp: ts(105) },
      { speaker: "DOCTOR", text: "Return if you develop leg pain, weakness, numbness, or any bowel/bladder change.", timestamp: ts(125) },
    ],
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [], age: 41, gender: "M" },
    requiredFields: ["subjective.chiefComplaint", "assessment.impression", "plan"],
    forbiddenContent: ["mri now", "tramadol long-term", "warfarin"],
    expected: {
      chiefComplaint: "low back pain 10 days post lifting",
      keyFindings: "paraspinal spasm normal slr normal neurology",
      primaryDiagnosis: "mechanical low back pain",
      keyMedications: ["paracetamol"],
    },
  },
];
