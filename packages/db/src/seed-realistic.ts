/**
 * Realistic hospital data seed — STAFF + PATIENTS + 14 days of OPD flow
 * (appointments, vitals, consultations, prescriptions, invoices, payments,
 * insurance claims, schedule overrides, notification preferences, system
 * config).
 *
 * Idempotency contract (2026-05-09): this script is safe to re-run on a
 * populated demo without creating duplicates.
 *
 *   - All randomness is driven by a deterministic mulberry32 PRNG seeded
 *     from a fixed constant. Re-runs produce byte-identical decisions
 *     (which patients on which day, which diagnosis, which billing items,
 *     which payment status).
 *   - Users / Doctors / Reception / Nurses / Pharmacists / Lab Techs:
 *     `prisma.user.upsert({ where: { email } })` — already idempotent
 *     pre-2026-05-09.
 *   - Patients: `upsert({ where: { userId } })`. mrNumbers are namespaced
 *     as `MRSEED${i}` so they never collide with the production MR
 *     counter (`MR000001` etc.) on a populated DB.
 *   - Appointments: `upsert({ where: { doctorId_date_tokenNumber } })` —
 *     leverages the existing `@@unique([doctorId, date, tokenNumber])`.
 *     Same (doctor, date, slot) re-run finds the existing row.
 *   - Vitals / Consultations / Prescriptions / Invoices: keyed off
 *     `appointmentId` (each is `@unique` on appointmentId). Pattern is
 *     `findUnique → if found, skip; else create`.
 *   - Invoices: `invoiceNumber: \`INV-SEED-${seq}\`` namespaces the seed
 *     numbers so they never collide with billing.ts's live
 *     `INV000001..` counter on a populated DB.
 *   - Payments: stable `transactionId: \`TXN-SEED-${seq}\`` for ALL
 *     payment modes (including CASH — production CASH rows have null
 *     transactionId, but the seed assigns one to drive idempotency).
 *     Skip-or-create on `findUnique({ where: { transactionId } })`.
 *   - InsuranceClaim (legacy): no unique — `findFirst({where:{invoiceId}})`
 *     skip. Each invoice gets at most one claim, so the per-invoice guard
 *     is sufficient.
 *   - InsuranceClaim2: `providerClaimRef: \`${tpa}-SEED-${seq}\`` — keyed
 *     on the existing `@@unique` on providerClaimRef.
 *   - System config: removed `next_invoice_number` and `next_mr_number`
 *     from the upsert list. Those are LIVE production counters consumed
 *     by `apps/api/src/routes/billing.ts` and `apps/api/src/routes/patients.ts`
 *     — overwriting them on every deploy would corrupt real-tenant
 *     numbering. The seed-namespaced INV-SEED / MRSEED ids no longer
 *     interact with those counters.
 *
 * Wired into `scripts/deploy.sh` step 8k. Failures are non-fatal (matches
 * the policy of every other deploy-time fixture seed).
 */
import { PrismaClient, Role, Gender, AppointmentType, AppointmentStatus, Priority, PaymentStatus, PaymentMode } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ─── DETERMINISTIC RNG ──────────────────────────────────
// mulberry32: tiny, dependency-free PRNG with a 32-bit state. Re-seeding
// from the same SEED constant guarantees the exact same number sequence
// across runs, so the seed produces byte-identical decisions every time.
// Replaces every `Math.random()` in this file — without this, re-runs on
// a populated DB would still create duplicate rows because the previous
// run's "this slot was a walk-in" would diverge from the next run's "this
// slot was scheduled", breaking the `(doctorId, date, tokenNumber)`
// natural key alignment.
const SEED = 0xc0ffee_42; // arbitrary fixed constant
let _rngState = SEED;
function rng(): number {
  _rngState |= 0;
  _rngState = (_rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function resetRng(): void { _rngState = SEED; }

function hash(pw: string) {
  return bcrypt.hashSync(pw, 10);
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function dateStr(d: Date) {
  return d.toISOString().split("T")[0];
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// ─── REALISTIC DATA ────────────────────────────────────

const PATIENT_DATA = [
  { name: "Rahul Sharma", phone: "9876543210", gender: "MALE" as Gender, age: 35, bloodGroup: "B+", address: "A-12 Andheri West, Mumbai 400058" },
  { name: "Priya Mehta", phone: "9876543211", gender: "FEMALE" as Gender, age: 28, bloodGroup: "O+", address: "15 MG Road, Juhu, Mumbai 400049" },
  { name: "Amit Patel", phone: "9876543212", gender: "MALE" as Gender, age: 52, bloodGroup: "A+", address: "302 Sunrise Apts, Bandra East, Mumbai 400051" },
  { name: "Sunita Desai", phone: "9876543213", gender: "FEMALE" as Gender, age: 67, bloodGroup: "AB+", address: "7B Shanti Nagar, Dadar, Mumbai 400014" },
  { name: "Vikram Singh", phone: "9876543214", gender: "MALE" as Gender, age: 44, bloodGroup: "O-", address: "18 Palm Beach Road, Navi Mumbai 400706" },
  { name: "Anjali Gupta", phone: "9876543215", gender: "FEMALE" as Gender, age: 31, bloodGroup: "B+", address: "Flat 9, Rose Garden, Powai, Mumbai 400076" },
  { name: "Rajesh Kumar", phone: "9876543216", gender: "MALE" as Gender, age: 58, bloodGroup: "A-", address: "Plot 22, Sector 5, Vashi, Navi Mumbai 400703" },
  { name: "Meena Iyer", phone: "9876543217", gender: "FEMALE" as Gender, age: 42, bloodGroup: "O+", address: "3rd Floor, Sagar Complex, Thane 400601" },
  { name: "Sanjay Joshi", phone: "9876543218", gender: "MALE" as Gender, age: 73, bloodGroup: "B-", address: "401 Heritage Tower, Worli, Mumbai 400018" },
  { name: "Kavita Reddy", phone: "9876543219", gender: "FEMALE" as Gender, age: 25, bloodGroup: "A+", address: "C-6 Nehru Nagar, Kurla, Mumbai 400024" },
  { name: "Deepak Verma", phone: "9876543220", gender: "MALE" as Gender, age: 39, bloodGroup: "AB-", address: "12 Hill Road, Bandra West, Mumbai 400050" },
  { name: "Lakshmi Nair", phone: "9876543221", gender: "FEMALE" as Gender, age: 55, bloodGroup: "O+", address: "B-8 Patel Chowk, Malad West, Mumbai 400064" },
  { name: "Arun Mishra", phone: "9876543222", gender: "MALE" as Gender, age: 48, bloodGroup: "B+", address: "701 Sky Villa, Goregaon East, Mumbai 400063" },
  { name: "Neha Kapoor", phone: "9876543223", gender: "FEMALE" as Gender, age: 33, bloodGroup: "A+", address: "19 Marine Drive, Churchgate, Mumbai 400020" },
  { name: "Suresh Yadav", phone: "9876543224", gender: "MALE" as Gender, age: 61, bloodGroup: "O+", address: "Flat 5A, Ganga Sagar, Borivali, Mumbai 400066" },
  { name: "Pooja Agarwal", phone: "9876543225", gender: "FEMALE" as Gender, age: 29, bloodGroup: "AB+", address: "23 Linking Road, Santacruz, Mumbai 400054" },
  { name: "Mohan Das", phone: "9876543226", gender: "MALE" as Gender, age: 70, bloodGroup: "B+", address: "14 Gandhi Nagar, Chembur, Mumbai 400071" },
  { name: "Rekha Pillai", phone: "9876543227", gender: "FEMALE" as Gender, age: 46, bloodGroup: "O-", address: "D-11 Laxmi Niwas, Dombivli 421201" },
  { name: "Ashok Tiwari", phone: "9876543228", gender: "MALE" as Gender, age: 56, bloodGroup: "A+", address: "88 Station Road, Kalyan 421301" },
  { name: "Fatima Sheikh", phone: "9876543229", gender: "FEMALE" as Gender, age: 38, bloodGroup: "B-", address: "5 Crescent Heights, Versova, Mumbai 400061" },
  { name: "Ramesh Pandey", phone: "9876543230", gender: "MALE" as Gender, age: 63, bloodGroup: "O+", address: "12A Saket Colony, Kandivali, Mumbai 400067" },
  { name: "Savita Bhatt", phone: "9876543231", gender: "FEMALE" as Gender, age: 50, bloodGroup: "AB+", address: "Plot 7, CIDCO, Aurangabad 431001" },
  { name: "Kiran Kulkarni", phone: "9876543232", gender: "FEMALE" as Gender, age: 36, bloodGroup: "A-", address: "Flat 3C, Mangal Apts, Mulund, Mumbai 400080" },
  { name: "Nitin Chavan", phone: "9876543233", gender: "MALE" as Gender, age: 41, bloodGroup: "B+", address: "22 Tilak Road, Ghatkopar, Mumbai 400077" },
  { name: "Geeta Saxena", phone: "9876543234", gender: "FEMALE" as Gender, age: 59, bloodGroup: "O+", address: "B-14 Siddhi Vinayak, Andheri East, Mumbai 400069" },
  { name: "Prakash Shetty", phone: "9876543235", gender: "MALE" as Gender, age: 47, bloodGroup: "A+", address: "9 Sea View, Colaba, Mumbai 400005" },
  { name: "Anita Deshpande", phone: "9876543236", gender: "FEMALE" as Gender, age: 34, bloodGroup: "B+", address: "Flat 6, Om Sai, Vikhroli, Mumbai 400083" },
  { name: "Manoj Gaikwad", phone: "9876543237", gender: "MALE" as Gender, age: 54, bloodGroup: "AB+", address: "301 Lotus Tower, Mira Road 401107" },
  { name: "Swati Jain", phone: "9876543238", gender: "FEMALE" as Gender, age: 27, bloodGroup: "O+", address: "16 Commerce House, Fort, Mumbai 400001" },
  { name: "Harish Menon", phone: "9876543239", gender: "MALE" as Gender, age: 66, bloodGroup: "B-", address: "A-4 Vrindavan, Vasai 401202" },
  { name: "Divya Chauhan", phone: "9876543240", gender: "FEMALE" as Gender, age: 22, bloodGroup: "A+", address: "Flat 8, Shreeji Tower, Dahisar, Mumbai 400068" },
  { name: "Bharat Sawant", phone: "9876543241", gender: "MALE" as Gender, age: 43, bloodGroup: "O-", address: "Plot 33, Airoli, Navi Mumbai 400708" },
  { name: "Ritu Malhotra", phone: "9876543242", gender: "FEMALE" as Gender, age: 37, bloodGroup: "B+", address: "112 Juhu Tara Road, Mumbai 400049" },
  { name: "Vijay Patil", phone: "9876543243", gender: "MALE" as Gender, age: 51, bloodGroup: "AB-", address: "C-19 Yashoda Nagar, Panvel 410206" },
  { name: "Seema Rawat", phone: "9876543244", gender: "FEMALE" as Gender, age: 45, bloodGroup: "O+", address: "7 Shivaji Park, Dadar, Mumbai 400028" },
];

const DIAGNOSES = [
  { diagnosis: "Acute Upper Respiratory Infection", medicines: [{ name: "Azithromycin 500mg", dosage: "500mg", freq: "1-0-0 (Morning)", dur: "3 days", instr: "After food" }, { name: "Cetirizine 10mg", dosage: "10mg", freq: "0-0-1 (Night)", dur: "5 days", instr: "Before bed" }, { name: "Paracetamol 650mg", dosage: "650mg", freq: "1-1-1 (Three times)", dur: "3 days", instr: "After food, if fever" }] },
  { diagnosis: "Viral Fever with Body Ache", medicines: [{ name: "Paracetamol 500mg", dosage: "500mg", freq: "1-1-1 (Three times)", dur: "5 days", instr: "After food" }, { name: "Vitamin C 500mg", dosage: "500mg", freq: "1-0-1 (Morning-Night)", dur: "7 days", instr: "After food" }] },
  { diagnosis: "Acute Gastroenteritis", medicines: [{ name: "ORS Sachets", dosage: "1 sachet in 1L water", freq: "SOS (As needed)", dur: "3 days", instr: "Sip frequently" }, { name: "Ondansetron 4mg", dosage: "4mg", freq: "1-1-0 (Morning-Afternoon)", dur: "2 days", instr: "Before food" }, { name: "Racecadotril 100mg", dosage: "100mg", freq: "1-1-1 (Three times)", dur: "3 days", instr: "Before food" }] },
  { diagnosis: "Hypertension - Routine Checkup", medicines: [{ name: "Amlodipine 5mg", dosage: "5mg", freq: "1-0-0 (Morning)", dur: "30 days", instr: "Empty stomach, morning" }, { name: "Telmisartan 40mg", dosage: "40mg", freq: "0-0-1 (Night)", dur: "30 days", instr: "After dinner" }] },
  { diagnosis: "Type 2 Diabetes Mellitus - Follow Up", medicines: [{ name: "Metformin 500mg", dosage: "500mg", freq: "1-0-1 (Morning-Night)", dur: "30 days", instr: "After food" }, { name: "Glimepiride 1mg", dosage: "1mg", freq: "1-0-0 (Morning)", dur: "30 days", instr: "Before breakfast" }] },
  { diagnosis: "Allergic Rhinitis", medicines: [{ name: "Levocetirizine 5mg", dosage: "5mg", freq: "0-0-1 (Night)", dur: "10 days", instr: "Before bed" }, { name: "Fluticasone Nasal Spray", dosage: "2 sprays each nostril", freq: "1-0-0 (Morning)", dur: "14 days", instr: "Morning, shake before use" }] },
  { diagnosis: "Acute Pharyngitis", medicines: [{ name: "Amoxicillin 500mg", dosage: "500mg", freq: "1-1-1 (Three times)", dur: "5 days", instr: "After food" }, { name: "Ibuprofen 400mg", dosage: "400mg", freq: "1-0-1 (Morning-Night)", dur: "3 days", instr: "After food" }, { name: "Betadine Gargle", dosage: "15ml", freq: "1-1-1 (Three times)", dur: "5 days", instr: "Gargle and spit, do not swallow" }] },
  { diagnosis: "Migraine without Aura", medicines: [{ name: "Sumatriptan 50mg", dosage: "50mg", freq: "SOS (As needed)", dur: "As needed", instr: "At onset of headache, max 2/day" }, { name: "Propranolol 20mg", dosage: "20mg", freq: "1-0-1 (Morning-Night)", dur: "30 days", instr: "Prevention, do not stop suddenly" }] },
  { diagnosis: "Lower Back Pain - Musculoskeletal", medicines: [{ name: "Diclofenac 50mg", dosage: "50mg", freq: "1-0-1 (Morning-Night)", dur: "5 days", instr: "After food" }, { name: "Thiocolchicoside 4mg", dosage: "4mg", freq: "1-0-1 (Morning-Night)", dur: "5 days", instr: "After food" }, { name: "Pantoprazole 40mg", dosage: "40mg", freq: "1-0-0 (Morning)", dur: "5 days", instr: "Before breakfast" }] },
  { diagnosis: "Urinary Tract Infection", medicines: [{ name: "Nitrofurantoin 100mg", dosage: "100mg", freq: "1-0-1 (Morning-Night)", dur: "5 days", instr: "After food, with plenty of water" }, { name: "Cranberry Extract 500mg", dosage: "500mg", freq: "1-0-0 (Morning)", dur: "14 days", instr: "After food" }] },
  { diagnosis: "Iron Deficiency Anaemia", medicines: [{ name: "Ferrous Sulphate 200mg", dosage: "200mg", freq: "1-0-0 (Morning)", dur: "90 days", instr: "Empty stomach with vitamin C" }, { name: "Folic Acid 5mg", dosage: "5mg", freq: "1-0-0 (Morning)", dur: "90 days", instr: "After food" }] },
  { diagnosis: "Knee Osteoarthritis", medicines: [{ name: "Aceclofenac 100mg", dosage: "100mg", freq: "1-0-1 (Morning-Night)", dur: "7 days", instr: "After food" }, { name: "Glucosamine 1500mg", dosage: "1500mg", freq: "1-0-0 (Morning)", dur: "90 days", instr: "After food" }, { name: "Calcium + Vitamin D3", dosage: "1 tab", freq: "0-0-1 (Night)", dur: "90 days", instr: "After dinner" }] },
  { diagnosis: "Anxiety Disorder", medicines: [{ name: "Escitalopram 10mg", dosage: "10mg", freq: "1-0-0 (Morning)", dur: "30 days", instr: "After breakfast, do not skip" }] },
  { diagnosis: "Acid Reflux / GERD", medicines: [{ name: "Pantoprazole 40mg", dosage: "40mg", freq: "1-0-0 (Morning)", dur: "14 days", instr: "Before breakfast" }, { name: "Domperidone 10mg", dosage: "10mg", freq: "1-1-1 (Three times)", dur: "7 days", instr: "Before food" }] },
  { diagnosis: "Skin Infection - Cellulitis", medicines: [{ name: "Cephalexin 500mg", dosage: "500mg", freq: "1-1-1 (Three times)", dur: "7 days", instr: "After food" }, { name: "Fusidic Acid Cream", dosage: "Apply thin layer", freq: "1-0-1 (Morning-Night)", dur: "7 days", instr: "Clean area first, apply topically" }] },
];

const CONSULTATION_NOTES = [
  "Patient reports symptoms for 3 days. No history of travel. Vitals stable.",
  "Follow-up visit. Patient reports improvement. Continuing current medication.",
  "New complaint. Advised lab tests. Will review in 1 week.",
  "Chronic condition management. BP well controlled. Continue same medication.",
  "Patient complains of persistent symptoms. Adjusted medication dosage.",
  "Routine health checkup. All parameters within normal limits.",
  "Post-recovery visit. Patient feeling much better. Discharged from active care.",
  "Referred to specialist for further evaluation. Interim treatment prescribed.",
];

const ADVICE = [
  "Rest well, drink plenty of fluids. Avoid cold foods. Follow up in 3 days if no improvement.",
  "Continue medication as prescribed. Do not skip doses. Follow up in 1 week.",
  "Avoid oily and spicy food. Eat light meals. Stay hydrated.",
  "Regular exercise 30 minutes daily. Low salt diet. Monitor BP at home.",
  "Walk 30 minutes daily. Follow diabetic diet. Check sugar levels weekly.",
  "Avoid allergens and dust. Use nasal spray regularly. Follow up in 2 weeks.",
  "Apply hot/cold compress. Avoid heavy lifting. Physiotherapy recommended.",
  "Complete the antibiotic course. Do not stop early even if feeling better.",
];

const BILLING_ITEMS = [
  { desc: "Consultation Fee", cat: "Consultation Fee", price: 500 },
  { desc: "Follow-up Consultation", cat: "Consultation Fee", price: 300 },
  { desc: "Blood Test - CBC", cat: "Lab Test", price: 350 },
  { desc: "Blood Sugar - Fasting", cat: "Lab Test", price: 150 },
  { desc: "Lipid Profile", cat: "Lab Test", price: 600 },
  { desc: "Thyroid Profile (T3, T4, TSH)", cat: "Lab Test", price: 800 },
  { desc: "Urine Routine Examination", cat: "Lab Test", price: 200 },
  { desc: "X-Ray Chest PA", cat: "Procedure", price: 400 },
  { desc: "ECG", cat: "Procedure", price: 300 },
  { desc: "Wound Dressing", cat: "Procedure", price: 250 },
  { desc: "Nebulization", cat: "Procedure", price: 200 },
  { desc: "BP Monitoring", cat: "Procedure", price: 100 },
];

const INSURANCE_PROVIDERS = [
  "Star Health Insurance",
  "ICICI Lombard",
  "HDFC Ergo",
  "Bajaj Allianz",
  "Max Bupa Health",
  "New India Assurance",
];

async function main() {
  console.log("=== Populating realistic hospital data (idempotent) ===\n");
  resetRng();

  // ─── 1. STAFF ─────────────────────────────────────────
  console.log("Creating staff accounts...");

  const admin = await prisma.user.upsert({
    where: { email: "admin@medcore.local" },
    update: {},
    create: { email: "admin@medcore.local", phone: "9999900000", name: "System Admin", passwordHash: hash("admin123"), role: Role.ADMIN },
  });

  // Specialization strings must match what the AI triage prompt produces
  // (see apps/api/src/services/ai/prompts.ts). The /:sessionId GET handler
  // does an exact `Doctor.findMany({ specialization: { in: [...] } })` —
  // any mismatch yields an empty "Recommended Doctors" panel for that
  // complaint, so add new specialties here when AI starts recommending them.
  const doctorsInput = [
    { email: "dr.sharma@medcore.local", phone: "9999900001", name: "Dr. Rajesh Sharma", spec: "General Medicine", qual: "MBBS, MD (Medicine)" },
    { email: "dr.patel@medcore.local", phone: "9999900002", name: "Dr. Priya Patel", spec: "Pediatrics & General Practice", qual: "MBBS, DCH" },
    { email: "dr.khan@medcore.local", phone: "9999900003", name: "Dr. Amir Khan", spec: "Orthopedics & Sports Medicine", qual: "MBBS, MS (Ortho)" },
    { email: "dr.iyer@medcore.local", phone: "9999900004", name: "Dr. Anjali Iyer", spec: "Pulmonologist", qual: "MBBS, MD (Pulmonary Medicine)" },
    { email: "dr.menon@medcore.local", phone: "9999900005", name: "Dr. Vikram Menon", spec: "Cardiologist", qual: "MBBS, MD, DM (Cardiology)" },
    { email: "dr.rao@medcore.local", phone: "9999900006", name: "Dr. Kavita Rao", spec: "Dermatologist", qual: "MBBS, MD (Dermatology)" },
    { email: "dr.singh@medcore.local", phone: "9999900007", name: "Dr. Harpreet Singh", spec: "ENT", qual: "MBBS, MS (ENT)" },
    { email: "dr.banerjee@medcore.local", phone: "9999900008", name: "Dr. Sourav Banerjee", spec: "Neurologist", qual: "MBBS, MD, DM (Neurology)" },
    { email: "dr.gupta@medcore.local", phone: "9999900009", name: "Dr. Neha Gupta", spec: "Gastroenterologist", qual: "MBBS, MD, DM (Gastroenterology)" },
    { email: "dr.fernandes@medcore.local", phone: "9999900012", name: "Dr. Maria Fernandes", spec: "Gynecologist", qual: "MBBS, MS (Obstetrics & Gynecology)" },
    { email: "dr.nair@medcore.local", phone: "9999900013", name: "Dr. Arjun Nair", spec: "Psychiatrist", qual: "MBBS, MD (Psychiatry)" },
    { email: "dr.bose@medcore.local", phone: "9999900014", name: "Dr. Ritu Bose", spec: "Ophthalmologist", qual: "MBBS, MS (Ophthalmology)" },
    { email: "dr.joshi@medcore.local", phone: "9999900015", name: "Dr. Sameer Joshi", spec: "Urologist", qual: "MBBS, MS, MCh (Urology)" },
    { email: "dr.reddy@medcore.local", phone: "9999900016", name: "Dr. Lakshmi Reddy", spec: "Endocrinologist", qual: "MBBS, MD, DM (Endocrinology)" },
    { email: "dr.dsouza@medcore.local", phone: "9999900017", name: "Dr. Rohan D'Souza", spec: "General Physician", qual: "MBBS, MD (General Medicine)" },
  ];

  const doctors: Array<{ userId: string; doctorId: string; name: string }> = [];

  for (const doc of doctorsInput) {
    const user = await prisma.user.upsert({
      where: { email: doc.email },
      update: {},
      create: { email: doc.email, phone: doc.phone, name: doc.name, passwordHash: hash("doctor123"), role: Role.DOCTOR },
    });
    const doctor = await prisma.doctor.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, specialization: doc.spec, qualification: doc.qual },
    });

    // Schedules: Mon-Sat with varying hours
    const schedules = doc.email.includes("sharma")
      ? [{ days: [1,2,3,4,5,6], start: "09:00", end: "13:00" }, { days: [1,2,3,4,5], start: "17:00", end: "20:00" }]
      : doc.email.includes("patel")
      ? [{ days: [1,2,3,4,5,6], start: "10:00", end: "14:00" }, { days: [1,3,5], start: "16:00", end: "19:00" }]
      : [{ days: [1,2,3,4,5], start: "09:30", end: "13:30" }, { days: [2,4,6], start: "15:00", end: "18:00" }];

    for (const sched of schedules) {
      for (const day of sched.days) {
        await prisma.doctorSchedule.upsert({
          where: { doctorId_dayOfWeek_startTime: { doctorId: doctor.id, dayOfWeek: day, startTime: sched.start } },
          update: {},
          create: { doctorId: doctor.id, dayOfWeek: day, startTime: sched.start, endTime: sched.end, slotDurationMinutes: 15 },
        });
      }
    }

    doctors.push({ userId: user.id, doctorId: doctor.id, name: doc.name });
    console.log(`  Created/Found: ${doc.name} (${doc.spec})`);
  }

  // Reception staff
  const receptionists = [
    { email: "reception@medcore.local", phone: "9999900010", name: "Sneha Deshmukh" },
    { email: "reception2@medcore.local", phone: "9999900011", name: "Manoj Kumar" },
  ];
  for (const r of receptionists) {
    await prisma.user.upsert({
      where: { email: r.email },
      update: {},
      create: { ...r, passwordHash: hash("reception123"), role: Role.RECEPTION },
    });
    console.log(`  Created/Found Reception: ${r.name}`);
  }

  // Nurses
  const nurses = [
    { email: "nurse@medcore.local", phone: "9999900020", name: "Anita Pawar" },
    { email: "nurse2@medcore.local", phone: "9999900021", name: "Rekha Sawant" },
  ];
  const nurseUsers: string[] = [];
  for (const n of nurses) {
    const u = await prisma.user.upsert({
      where: { email: n.email },
      update: {},
      create: { ...n, passwordHash: hash("nurse123"), role: Role.NURSE },
    });
    nurseUsers.push(u.id);
    console.log(`  Created/Found Nurse: ${n.name}`);
  }

  // Pharmacists (dispense + inventory ops)
  const pharmacists = [
    { email: "pharmacist@medcore.local", phone: "9999900030", name: "Vikas Joshi" },
  ];
  for (const p of pharmacists) {
    await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: { ...p, passwordHash: hash("pharmacist123"), role: Role.PHARMACIST },
    });
    console.log(`  Created/Found Pharmacist: ${p.name}`);
  }

  // Lab technicians (sample collection + result entry)
  const labTechs = [
    { email: "labtech@medcore.local", phone: "9999900040", name: "Sunita Bhosale" },
  ];
  for (const t of labTechs) {
    await prisma.user.upsert({
      where: { email: t.email },
      update: {},
      create: { ...t, passwordHash: hash("labtech123"), role: Role.LAB_TECH },
    });
    console.log(`  Created/Found Lab Tech: ${t.name}`);
  }

  // ─── 2. PATIENTS ──────────────────────────────────────
  console.log("\nRegistering patients...");

  const patientRecords: Array<{ patientId: string; userId: string; name: string }> = [];
  let mrSeq = 1;

  for (const p of PATIENT_DATA) {
    const email = `patient${mrSeq}@medcore.local`;
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, phone: p.phone, name: p.name, passwordHash: hash("patient123"), role: Role.PATIENT },
    });

    // mrNumber namespaced as `MRSEED${i}` so it never collides with the
    // production patients-route counter (which mints `MR000001..`). Keying
    // the upsert on userId means re-runs hit the existing row.
    const mrNumber = `MRSEED${String(mrSeq).padStart(6, "0")}`;
    const patient = await prisma.patient.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        mrNumber,
        gender: p.gender,
        age: p.age,
        address: p.address,
        bloodGroup: p.bloodGroup,
        emergencyContactName: randomItem(["Spouse", "Son", "Daughter", "Parent", "Sibling"]),
        emergencyContactPhone: `98765${randomInt(10000, 99999)}`,
        insuranceProvider: rng() > 0.6 ? randomItem(INSURANCE_PROVIDERS) : undefined,
        insurancePolicyNumber: rng() > 0.6 ? `POL${randomInt(100000, 999999)}` : undefined,
      },
    });

    patientRecords.push({ patientId: patient.id, userId: user.id, name: p.name });
    mrSeq++;
  }
  console.log(`  Registered/Found ${patientRecords.length} patients`);

  // ─── 3. APPOINTMENTS & FULL OPD FLOW ─────────────────
  console.log("\nCreating appointments, vitals, consultations, prescriptions & bills...");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let invoiceSeq = 1;
  let totalAppointments = 0;
  let createdAppointments = 0;
  let skippedAppointments = 0;

  // Generate data for the past 14 days + today + 3 days ahead
  for (let dayOffset = -14; dayOffset <= 3; dayOffset++) {
    const date = addDays(today, dayOffset);
    const dow = date.getDay();
    if (dow === 0) continue; // Skip Sundays

    const isFuture = dayOffset > 0;
    const isToday = dayOffset === 0;

    for (const doc of doctors) {
      let tokenNum = 0;
      // 8-18 patients per doctor per day (past), 5-12 for today, 3-8 for future
      const patientCount = isFuture ? randomInt(3, 8) : isToday ? randomInt(8, 15) : randomInt(8, 18);

      // Deterministic shuffle: Fisher-Yates driven by the seeded PRNG so
      // the same patients land on the same (doctor, date) across re-runs —
      // critical for the `(doctorId, date, tokenNumber)` upsert to keep
      // hitting the same Patient on re-run.
      const shuffledPatients = [...patientRecords];
      for (let k = shuffledPatients.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [shuffledPatients[k], shuffledPatients[j]] = [shuffledPatients[j], shuffledPatients[k]];
      }
      const dayPatients = shuffledPatients.slice(0, patientCount);

      const slots = ["09:00","09:15","09:30","09:45","10:00","10:15","10:30","10:45","11:00","11:15","11:30","11:45","12:00","12:15","12:30","12:45","17:00","17:15","17:30","17:45","18:00","18:15","18:30"];

      for (let i = 0; i < dayPatients.length; i++) {
        const p = dayPatients[i];
        tokenNum++;
        const isWalkIn = rng() > 0.6;
        const slotStart = isWalkIn ? null : slots[i % slots.length];

        let status: AppointmentStatus;
        if (isFuture) {
          status = AppointmentStatus.BOOKED;
        } else if (isToday) {
          if (i < 3) status = AppointmentStatus.COMPLETED;
          else if (i === 3) status = AppointmentStatus.IN_CONSULTATION;
          else if (i < 7) status = AppointmentStatus.CHECKED_IN;
          else status = AppointmentStatus.BOOKED;
        } else {
          // Past days
          const r = rng();
          if (r < 0.8) status = AppointmentStatus.COMPLETED;
          else if (r < 0.9) status = AppointmentStatus.CANCELLED;
          else status = AppointmentStatus.NO_SHOW;
        }

        const priorityRoll1 = rng();
        const priorityRoll2 = rng();
        const priority = priorityRoll1 > 0.92 ? Priority.URGENT : priorityRoll2 > 0.98 ? Priority.EMERGENCY : Priority.NORMAL;

        // Idempotency: upsert keyed on the existing
        // `@@unique([doctorId, date, tokenNumber])`. On re-run this finds
        // the same row that the previous run created (because RNG +
        // shuffle are deterministic, the same (doctorId, date, tokenNum)
        // tuple maps back to the same logical appointment).
        const notesRoll = rng();
        const notes = notesRoll > 0.7 ? randomItem(["First visit", "Follow-up", "Referred by Dr. Verma", "Insurance patient", "Annual checkup"]) : null;

        const existingAppt = await prisma.appointment.findUnique({
          where: { doctorId_date_tokenNumber: { doctorId: doc.doctorId, date, tokenNumber: tokenNum } },
        });
        let appointment;
        if (existingAppt) {
          appointment = existingAppt;
          skippedAppointments++;
        } else {
          appointment = await prisma.appointment.create({
            data: {
              patientId: p.patientId,
              doctorId: doc.doctorId,
              date,
              slotStart,
              slotEnd: slotStart ? `${parseInt(slotStart.split(":")[0])}:${(parseInt(slotStart.split(":")[1]) + 15).toString().padStart(2, "0")}` : null,
              tokenNumber: tokenNum,
              type: isWalkIn ? AppointmentType.WALK_IN : AppointmentType.SCHEDULED,
              status,
              priority,
              notes,
            },
          });
          createdAppointments++;
        }
        totalAppointments++;

        // ─── Vitals (for checked-in, in-consultation, completed) ───
        if (
          ([
            AppointmentStatus.CHECKED_IN,
            AppointmentStatus.IN_CONSULTATION,
            AppointmentStatus.COMPLETED,
          ] as AppointmentStatus[]).includes(status)
        ) {
          // Idempotency: Vitals.appointmentId is `@unique`. Skip if a
          // row already exists for this appointment.
          const existingVitals = await prisma.vitals.findUnique({ where: { appointmentId: appointment.id } });
          const patAge = PATIENT_DATA.find(pd => pd.name === p.name)?.age ?? 40;
          // Always advance the RNG to keep determinism across runs
          // (whether or not we end up creating Vitals).
          const vitalsData = {
            bloodPressureSystolic: randomInt(patAge > 55 ? 130 : 110, patAge > 55 ? 160 : 135),
            bloodPressureDiastolic: randomInt(patAge > 55 ? 80 : 70, patAge > 55 ? 100 : 88),
            temperature: parseFloat((randomInt(976, 1002) / 10).toFixed(1)),
            weight: parseFloat((randomInt(450, 950) / 10).toFixed(1)),
            height: parseFloat((randomInt(1500, 1850) / 10).toFixed(1)),
            pulseRate: randomInt(60, 100),
            spO2: randomInt(95, 100),
            nurseId: randomItem(nurseUsers),
            notesRoll: rng(),
          };
          if (!existingVitals) {
            await prisma.vitals.create({
              data: {
                appointmentId: appointment.id,
                patientId: p.patientId,
                nurseId: vitalsData.nurseId,
                bloodPressureSystolic: vitalsData.bloodPressureSystolic,
                bloodPressureDiastolic: vitalsData.bloodPressureDiastolic,
                temperature: vitalsData.temperature,
                weight: vitalsData.weight,
                height: vitalsData.height,
                pulseRate: vitalsData.pulseRate,
                spO2: vitalsData.spO2,
                notes: vitalsData.notesRoll > 0.8 ? randomItem(["Patient appears anxious", "Mild dehydration noted", "Pain in lower back on palpation", "Throat appears inflamed"]) : null,
              },
            });
          } else if (vitalsData.notesRoll > 0.8) {
            // Even when we skip, we must consume the same number of RNG
            // calls to keep downstream determinism. The randomItem call
            // for the notes message is conditionally invoked above; mirror
            // it here.
            randomItem(["Patient appears anxious", "Mild dehydration noted", "Pain in lower back on palpation", "Throat appears inflamed"]);
          }
        }

        // ─── Consultation & Prescription (for completed & in-consultation) ───
        if (
          ([
            AppointmentStatus.COMPLETED,
            AppointmentStatus.IN_CONSULTATION,
          ] as AppointmentStatus[]).includes(status)
        ) {
          const diagData = randomItem(DIAGNOSES);
          const consultNotes = randomItem(CONSULTATION_NOTES);

          // Idempotency: Consultation.appointmentId is `@unique`.
          const existingConsult = await prisma.consultation.findUnique({ where: { appointmentId: appointment.id } });
          if (!existingConsult) {
            await prisma.consultation.create({
              data: {
                appointmentId: appointment.id,
                doctorId: doc.doctorId,
                notes: consultNotes,
                findings: diagData.diagnosis,
              },
            });
          }

          if (status === AppointmentStatus.COMPLETED) {
            // Mirror RNG consumption from the original code path.
            const followUpRoll = rng();
            const followUp = followUpRoll > 0.5 ? addDays(date, randomItem([7, 14, 30])) : null;
            const adviceText = randomItem(ADVICE);
            // Idempotency: Prescription.appointmentId is `@unique`.
            const existingRx = await prisma.prescription.findUnique({ where: { appointmentId: appointment.id } });
            if (!existingRx) {
              await prisma.prescription.create({
                data: {
                  appointmentId: appointment.id,
                  patientId: p.patientId,
                  doctorId: doc.doctorId,
                  diagnosis: diagData.diagnosis,
                  advice: adviceText,
                  followUpDate: followUp,
                  items: {
                    create: diagData.medicines.map(m => ({
                      medicineName: m.name,
                      dosage: m.dosage,
                      frequency: m.freq,
                      duration: m.dur,
                      instructions: m.instr,
                    })),
                  },
                },
              });
            }
          }
        }

        // ─── Billing (for completed and checked-in appointments) ───
        const billCheckInRoll = rng();
        const shouldBill = status === AppointmentStatus.COMPLETED ||
          (status === AppointmentStatus.CHECKED_IN && billCheckInRoll > 0.5) ||
          (status === AppointmentStatus.IN_CONSULTATION);

        if (shouldBill) {
          // Namespaced: `INV-SEED-` prefix never collides with the live
          // billing.ts counter (`INV000001..`) on a populated DB.
          const invoiceNumber = `INV-SEED-${String(invoiceSeq).padStart(6, "0")}`;
          const isFirstVisit = rng() > 0.4;
          const items = [isFirstVisit ? BILLING_ITEMS[0] : BILLING_ITEMS[1]];
          if (rng() > 0.6) items.push(randomItem(BILLING_ITEMS.slice(2)));
          if (rng() > 0.8) items.push(randomItem(BILLING_ITEMS.slice(2)));

          const subtotal = items.reduce((s, it) => s + it.price, 0);
          const discount = rng() > 0.85 ? Math.round(subtotal * 0.1) : 0;
          const totalAmount = subtotal - discount;

          // Determine payment status
          let paymentStatus: PaymentStatus;
          if (status === AppointmentStatus.COMPLETED) {
            paymentStatus = dayOffset >= -2 && rng() > 0.7
              ? PaymentStatus.PENDING
              : PaymentStatus.PAID;
          } else if (status === AppointmentStatus.IN_CONSULTATION) {
            paymentStatus = rng() > 0.5 ? PaymentStatus.PENDING : PaymentStatus.PARTIAL;
          } else {
            // CHECKED_IN
            paymentStatus = PaymentStatus.PENDING;
          }

          // Idempotency: Invoice.appointmentId is `@unique`. Skip if a
          // row already exists; otherwise create with the namespaced
          // invoiceNumber. (invoiceNumber is also @unique so this is
          // belt-and-suspenders.)
          const existingInvoice = await prisma.invoice.findUnique({ where: { appointmentId: appointment.id } });
          let invoice = existingInvoice;
          if (!existingInvoice) {
            invoice = await prisma.invoice.create({
              data: {
                invoiceNumber,
                appointmentId: appointment.id,
                patientId: p.patientId,
                subtotal,
                taxAmount: 0,
                discountAmount: discount,
                totalAmount,
                paymentStatus,
                // Issue #572: anchor to appointment date so the patient
                // bills page's "Age" gradient matches the visit timeline.
                createdAt: date,
                items: {
                  create: items.map(it => ({
                    description: it.desc,
                    category: it.cat,
                    quantity: 1,
                    unitPrice: it.price,
                    amount: it.price,
                  })),
                },
              },
            });
          }

          // Create payment records based on status. Idempotency:
          // transactionId is `@unique`. Stable `TXN-SEED-${seq}` for ALL
          // modes (production CASH rows have null transactionId; the seed
          // intentionally diverges from production by stamping a
          // transactionId on seeded CASH rows to keep idempotency).
          if (paymentStatus === PaymentStatus.PAID) {
            const mode = randomItem([PaymentMode.CASH, PaymentMode.CASH, PaymentMode.UPI, PaymentMode.CARD, PaymentMode.ONLINE]);
            const txnId = `TXN-SEED-${String(invoiceSeq).padStart(6, "0")}`;
            const existingPayment = await prisma.payment.findUnique({ where: { transactionId: txnId } });
            if (!existingPayment && invoice) {
              await prisma.payment.create({
                data: {
                  invoiceId: invoice.id,
                  amount: totalAmount,
                  mode,
                  transactionId: txnId,
                  paidAt: date,
                },
              });
            }
          } else if (paymentStatus === PaymentStatus.PARTIAL) {
            const partialAmount = Math.round(totalAmount * 0.4);
            const mode = randomItem([PaymentMode.CASH, PaymentMode.UPI]);
            const txnId = `TXN-SEED-${String(invoiceSeq).padStart(6, "0")}-PARTIAL`;
            const existingPayment = await prisma.payment.findUnique({ where: { transactionId: txnId } });
            if (!existingPayment && invoice) {
              await prisma.payment.create({
                data: {
                  invoiceId: invoice.id,
                  amount: partialAmount,
                  mode,
                  transactionId: txnId,
                  paidAt: date,
                },
              });
            }
          }
          // PENDING: no payment record

          // Insurance claim for some
          const patientData = await prisma.patient.findUnique({ where: { id: p.patientId } });
          const claimRoll = rng();
          if (patientData?.insuranceProvider && claimRoll > 0.5 && invoice) {
            // Idempotency (legacy InsuranceClaim has no unique key on
            // invoiceId, but each invoice gets at most one seeded claim):
            // findFirst on invoiceId; skip if present.
            const existingClaim = await prisma.insuranceClaim.findFirst({ where: { invoiceId: invoice.id } });
            const approvedRoll = rng();
            const settledRoll = rng();
            const approvedAmount = dayOffset < -5 ? totalAmount * (approvedRoll > 0.2 ? 1 : 0.8) : null;
            const claimStatus = dayOffset < -5 ? (settledRoll > 0.1 ? "SETTLED" : "REJECTED") : dayOffset < -2 ? "APPROVED" : "SUBMITTED";
            const resolvedDays = randomInt(2, 5); // consume RNG even if not used
            if (!existingClaim) {
              await prisma.insuranceClaim.create({
                data: {
                  invoiceId: invoice.id,
                  patientId: p.patientId,
                  insuranceProvider: patientData.insuranceProvider,
                  policyNumber: patientData.insurancePolicyNumber || `POL${randomInt(100000, 999999)}`,
                  claimAmount: totalAmount,
                  approvedAmount,
                  status: claimStatus,
                  resolvedAt: dayOffset < -5 ? addDays(date, resolvedDays) : null,
                },
              });
            } else {
              // Mirror the policyNumber RNG consumption when skipping.
              if (!patientData.insurancePolicyNumber) randomInt(100000, 999999);
            }

            // Issue #82: also seed the V2 row.
            const realInsurers = [
              { name: "Star Health and Allied Insurance", tpa: "STAR_HEALTH" as const },
              { name: "ICICI Lombard General Insurance", tpa: "ICICI_LOMBARD" as const },
              { name: "HDFC ERGO General Insurance", tpa: "MEDI_ASSIST" as const },
              { name: "Bajaj Allianz General Insurance", tpa: "PARAMOUNT" as const },
              { name: "Niva Bupa Health Insurance", tpa: "VIDAL" as const },
              { name: "Care Health Insurance", tpa: "FHPL" as const },
            ];
            const ins = realInsurers[randomInt(0, realInsurers.length - 1)];
            const diagnoses = [
              { dx: "Essential hypertension", icd: "I10" },
              { dx: "Type 2 diabetes mellitus", icd: "E11" },
              { dx: "Acute upper respiratory infection", icd: "J06.9" },
              { dx: "Asthma", icd: "J45.9" },
              { dx: "Lower back pain", icd: "M54.5" },
            ];
            const dx = diagnoses[randomInt(0, diagnoses.length - 1)];
            const v2SettledRoll = rng();
            const v2Status =
              dayOffset < -5
                ? v2SettledRoll > 0.1
                  ? ("SETTLED" as const)
                  : ("DENIED" as const)
                : dayOffset < -2
                  ? ("APPROVED" as const)
                  : ("SUBMITTED" as const);
            const v2ApprovedRoll = rng();
            const approved = ["APPROVED", "SETTLED"].includes(v2Status)
              ? Math.round(totalAmount * (v2ApprovedRoll > 0.2 ? 1 : 0.8))
              : null;

            // Idempotency: providerClaimRef is `@unique`. Stable
            // `${tpa}-SEED-${invoiceSeq}` so re-runs hit the same row.
            const providerClaimRef = `${ins.tpa}-SEED-${String(invoiceSeq).padStart(6, "0")}`;
            const existingV2 = await prisma.insuranceClaim2.findUnique({ where: { providerClaimRef } });
            const policyForV2 = patientData.insurancePolicyNumber || `POL${randomInt(100000, 999999)}`;
            const approvedDays = randomInt(2, 5);
            const settledDays = randomInt(5, 8);
            if (!existingV2) {
              try {
                await prisma.insuranceClaim2.create({
                  data: {
                    billId: invoice.id,
                    patientId: p.patientId,
                    tpaProvider: ins.tpa,
                    providerClaimRef,
                    insurerName: ins.name,
                    policyNumber: policyForV2,
                    diagnosis: dx.dx,
                    icd10Codes: [dx.icd],
                    amountClaimed: totalAmount,
                    amountApproved: approved,
                    status: v2Status,
                    submittedAt: date,
                    approvedAt:
                      v2Status === "APPROVED" || v2Status === "SETTLED"
                        ? addDays(date, approvedDays)
                        : null,
                    settledAt:
                      v2Status === "SETTLED" ? addDays(date, settledDays) : null,
                    createdBy: "SEED",
                  },
                });
              } catch {
                // Ignore unique-collision on (billId,…) — seed is best effort.
              }
            }
          }

          invoiceSeq++;
        }
      }
    }
    if (dayOffset % 3 === 0) console.log(`  Processed ${dateStr(date)}...`);
  }

  console.log(`  Total appointments: ${totalAppointments} (created ${createdAppointments}, skipped ${skippedAppointments} pre-existing)`);
  console.log(`  Total invoices through seed loop: ${invoiceSeq - 1}`);

  // ─── 4. SCHEDULE OVERRIDES ────────────────────────────
  console.log("\nAdding schedule overrides...");
  // Dr. Sharma on leave 2 days ago
  await prisma.scheduleOverride.upsert({
    where: { doctorId_date: { doctorId: doctors[0].doctorId, date: addDays(today, -2) } },
    update: {},
    create: { doctorId: doctors[0].doctorId, date: addDays(today, -2), isBlocked: true, reason: "Personal leave" },
  });
  // Dr. Khan half day tomorrow
  await prisma.scheduleOverride.upsert({
    where: { doctorId_date: { doctorId: doctors[2].doctorId, date: addDays(today, 1) } },
    update: {},
    create: { doctorId: doctors[2].doctorId, date: addDays(today, 1), isBlocked: false, startTime: "09:30", endTime: "12:00", reason: "Hospital conference in afternoon" },
  });
  console.log("  Added 2 schedule overrides");

  // ─── 5. NOTIFICATION PREFERENCES ──────────────────────
  console.log("\nSetting notification preferences...");
  for (const p of patientRecords.slice(0, 20)) {
    for (const ch of ["WHATSAPP", "SMS", "EMAIL", "PUSH"] as const) {
      await prisma.notificationPreference.upsert({
        where: { userId_channel: { userId: p.userId, channel: ch } },
        update: {},
        create: { userId: p.userId, channel: ch, enabled: ch === "WHATSAPP" || ch === "PUSH" ? true : rng() > 0.4 },
      });
    }
  }
  console.log("  Set preferences for 20 patients");

  // ─── 6. SYSTEM CONFIG ─────────────────────────────────
  console.log("\nUpdating system config...");
  // NOTE (2026-05-09 idempotency pass): `next_invoice_number` and
  // `next_mr_number` are LIVE production counters consumed by
  // apps/api/src/routes/billing.ts and apps/api/src/routes/patients.ts.
  // The pre-idempotency version of this seed overwrote both on every run,
  // which would corrupt real-tenant numbering when wired into deploy.sh.
  // They are now omitted — the seed-namespaced INV-SEED / MRSEED ids no
  // longer interact with those counters.
  const configs = [
    { key: "hospital_name", value: "MedCore Hospital & Diagnostics" },
    { key: "hospital_address", value: "42 Linking Road, Bandra West, Mumbai, Maharashtra 400050" },
    { key: "hospital_phone", value: "+91 22 2640 5678" },
    { key: "hospital_email", value: "info@medcorehospital.in" },
    { key: "hospital_registration", value: "MH/MUM/2024/HC-4521" },
    { key: "consultation_fee", value: "500" },
    { key: "followup_fee", value: "300" },
    { key: "gst_percentage", value: "0" },
    { key: "avg_consultation_minutes", value: "12" },
    { key: "cancellation_hours", value: "2" },
  ];
  for (const c of configs) {
    await prisma.systemConfig.upsert({ where: { key: c.key }, update: { value: c.value }, create: c });
  }
  console.log("  System config updated (live counters left untouched)");

  console.log("\n=== Seeding complete! ===");
  console.log(`  Staff: 1 admin, 3 doctors, 2 receptionists, 2 nurses`);
  console.log(`  Patients: ${patientRecords.length}`);
  console.log(`  Appointments: ${totalAppointments} (14 days history + today + 3 days future)`);
  console.log(`  Invoices through seed loop: ${invoiceSeq - 1}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
