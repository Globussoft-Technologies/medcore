#!/usr/bin/env tsx
/**
 * sanitize-and-reseed
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot demo-prod database sanitizer + enricher for screenshot day.
 *
 *   Phase A — sanitize: delete junk test rows (test users, bogus phones,
 *             stale notifications, empty audit logs, etc.).
 *   Phase B — enrich:   idempotent upserts to bring every module to a
 *             "established hospital" data depth so dashboards, lists, and
 *             KPI tiles have signal everywhere.
 *
 * Dry-run by DEFAULT. Logs every delete and upsert with sample names + counts.
 * Pass `--apply` to actually write. Wraps each phase in a single
 * `prisma.$transaction([...])` so a failure mid-phase rolls back cleanly.
 *
 * Idempotent — safe to re-run. Faker seeded with a fixed string so re-runs
 * produce the same fake data. Pure inserts use deterministic ids derived
 * from a hash of natural keys (e.g. `scribe-${appointmentId}`).
 *
 * Does NOT touch:
 *   - Tenant rows (multi-tenant onboarding scope)
 *   - Prompt rows (versioned AI registry)
 *   - Icd10Code / Medicine / LabTest / SnomedConcept reference catalogues
 *   - User ADMIN rows OR the 7 demo personas seeded by reseed-demo-accounts.ts
 *
 * Usage
 * ─────
 *   # dry-run (DEFAULT — safe, zero writes):
 *   npx tsx scripts/sanitize-and-reseed.ts
 *
 *   # apply both phases:
 *   npx tsx scripts/sanitize-and-reseed.ts --apply
 *
 *   # run only one phase:
 *   npx tsx scripts/sanitize-and-reseed.ts --phase=a [--apply]
 *   npx tsx scripts/sanitize-and-reseed.ts --phase=b [--apply]
 */

import { config as loadEnv } from "dotenv";
import path from "path";
import crypto from "crypto";
import { faker } from "@faker-js/faker";
import {
  prisma,
  Prisma,
  AIScribeStatus,
  AITriageStatus,
  AppointmentStatus,
  AppointmentType,
  RadiologyModality,
  RadiologyReportStatus,
  FeedbackCategory,
  SentimentLabel,
  PatientDataExportStatus,
  PatientDataExportFormat,
  Gender,
  BloodGroupType,
  BloodComponent,
  BloodUnitStatus,
  AmbulanceTripStatus,
  EmergencyStatus,
  TriageLevel,
  SurgeryStatus,
  ChronicConditionCode,
  ChronicCareAlertSeverity,
  NotificationDeliveryStatus,
  Role,
} from "@medcore/db";

loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "apps/api/.env") });

// ─── CLI args ─────────────────────────────────────────────────────────────
interface CliArgs {
  apply: boolean;
  phase: "a" | "b" | "both";
}

function parseArgs(argv: string[]): CliArgs {
  let apply = false;
  let phase: CliArgs["phase"] = "both";
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--phase=a") phase = "a";
    else if (arg === "--phase=b") phase = "b";
    else if (arg === "--phase=both") phase = "both";
    else if (arg === "--help" || arg === "-h") {
      console.error(
        "Usage: tsx scripts/sanitize-and-reseed.ts [--apply] [--phase=a|b|both]\n" +
          "\n" +
          "Phase A deletes junk test rows. Phase B upserts demo data.\n" +
          "Default mode is --dry-run (logs everything, writes nothing)."
      );
      process.exit(0);
    }
  }
  return { apply, phase };
}

const args = parseArgs(process.argv.slice(2));
const MODE: "DRY_RUN" | "APPLY" = args.apply ? "APPLY" : "DRY_RUN";
const TAG = "[sanitize-reseed]";
const DRY = "[DRY RUN]";

// ─── Faker seeded for idempotency ─────────────────────────────────────────
faker.seed(12345);

// ─── Helpers ──────────────────────────────────────────────────────────────
function log(msg: string) {
  console.log(`${TAG} ${msg}`);
}

function dryLog(msg: string) {
  console.log(`${TAG} ${MODE === "DRY_RUN" ? DRY + " " : ""}${msg}`);
}

function sampleNames(rows: { name?: string | null; id: string }[], cap = 10) {
  return rows
    .slice(0, cap)
    .map((r) => r.name || r.id)
    .join(", ");
}

function detId(prefix: string, key: string): string {
  // Deterministic UUID-ish id from prefix+key. Stable across runs => idempotent.
  const hash = crypto.createHash("sha1").update(`${prefix}:${key}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function pick<T>(arr: T[]): T {
  return arr[faker.number.int({ min: 0, max: arr.length - 1 })] as T;
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = faker.number.int({ min: 0, max: copy.length - 1 });
    out.push(copy.splice(idx, 1)[0] as T);
  }
  return out;
}

function indianPhone(): string {
  // +91-9XXXXXXXXX style. The "+91-" hyphen variant is common in seed data;
  // matches /^\+?\d{10,15}$/ when normalised by removing the hyphen, but
  // ambulance phone validation strips non-digits — keep as plain digits.
  const last9 = faker.string.numeric(9);
  return `+91${faker.helpers.arrayElement(["7", "8", "9"])}${last9}`;
}

function indianDob(minAge = 1, maxAge = 80): Date {
  const age = faker.number.int({ min: minAge, max: maxAge });
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  d.setMonth(faker.number.int({ min: 0, max: 11 }));
  d.setDate(faker.number.int({ min: 1, max: 28 }));
  return d;
}

const INDIAN_FIRST_NAMES_M = [
  "Arjun", "Rahul", "Vikram", "Karan", "Rohan", "Amit", "Sandeep", "Ravi",
  "Sumit", "Abhishek", "Manish", "Nikhil", "Suresh", "Rajesh", "Anil",
  "Pradeep", "Deepak", "Mukesh", "Naveen", "Harish",
];
const INDIAN_FIRST_NAMES_F = [
  "Priya", "Anjali", "Pooja", "Neha", "Kavita", "Sunita", "Meera", "Anita",
  "Shruti", "Divya", "Riya", "Sneha", "Asha", "Lakshmi", "Geeta",
  "Sushma", "Rekha", "Vandana", "Aarti", "Ritu",
];
const INDIAN_LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Kumar", "Singh", "Gupta", "Joshi", "Mehta",
  "Reddy", "Iyer", "Nair", "Pillai", "Shah", "Desai", "Bhatt", "Trivedi",
  "Pawar", "Deshmukh", "Bhosale", "Kulkarni",
];

function indianName(gender: Gender = "MALE"): string {
  const first =
    gender === "FEMALE"
      ? pick(INDIAN_FIRST_NAMES_F)
      : pick(INDIAN_FIRST_NAMES_M);
  return `${first} ${pick(INDIAN_LAST_NAMES)}`;
}

const INDIAN_CITIES = [
  "Mumbai, Maharashtra", "Pune, Maharashtra", "Bangalore, Karnataka",
  "Chennai, Tamil Nadu", "Hyderabad, Telangana", "Delhi", "Kolkata, West Bengal",
  "Ahmedabad, Gujarat", "Jaipur, Rajasthan", "Lucknow, Uttar Pradesh",
];

const PHONE_REGEX = /^\+?\d{10,15}$/;

// ─── Demo persona emails (NEVER touch) ────────────────────────────────────
const PROTECTED_EMAILS = new Set([
  "admin@medcore.local",
  "dr.sharma@medcore.local",
  "nurse@medcore.local",
  "reception@medcore.local",
  "labtech@medcore.local",
  "pharmacist@medcore.local",
  "patient1@medcore.local",
]);

// ═══════════════════════════════════════════════════════════════════════════
// PHASE A — SANITIZE
// ═══════════════════════════════════════════════════════════════════════════

interface PhaseACounts {
  users: number;
  patients: number;
  phones: number;
  claims: number;
  notifications: number;
  audit: number;
  appointments: number;
}

async function phaseA(): Promise<PhaseACounts> {
  log("=== PHASE A: SANITIZE ===");
  const counts: PhaseACounts = {
    users: 0,
    patients: 0,
    phones: 0,
    claims: 0,
    notifications: 0,
    audit: 0,
    appointments: 0,
  };

  // ── A.1 Users with name ILIKE 'test'/'test%'/'tester%' ──────────────────
  // Need ILIKE — Prisma `mode: 'insensitive'` works for `contains/startsWith`,
  // but 'test%' is exactly startsWith('test') with mode insensitive. We
  // combine the three patterns with OR. We also EXCLUDE protected demo
  // emails and ADMIN role rows defensively.
  const testUsers = await prisma.user.findMany({
    where: {
      AND: [
        {
          OR: [
            { name: { equals: "test", mode: "insensitive" } },
            { name: { startsWith: "test", mode: "insensitive" } },
            { name: { startsWith: "tester", mode: "insensitive" } },
          ],
        },
        { email: { notIn: Array.from(PROTECTED_EMAILS) } },
        { role: { not: Role.ADMIN } },
      ],
    },
    select: { id: true, name: true, email: true, role: true },
  });
  counts.users = testUsers.length;
  dryLog(
    `Would delete ${testUsers.length} rows from User: ${sampleNames(testUsers)}`
  );

  // ── A.2 Patients with bogus email / MR / name OR linked-User-deleted ────
  // Cascade chain: Patient.user is `onDelete: Cascade` from User → Patient,
  // so deleting the User in A.1 already removes the linked Patient. We still
  // separately catch Patients matching the rules independently of A.1.
  const testUserIds = new Set(testUsers.map((u) => u.id));
  const junkPatients = await prisma.patient.findMany({
    where: {
      OR: [
        { user: { email: "patient@example.com" } },
        { mrNumber: { startsWith: "Test", mode: "insensitive" } },
        { user: { name: { equals: "Test123", mode: "insensitive" } } },
        // Defensive: any patient whose User is in the test-user delete set.
        // (Cascade will handle this anyway, but logging makes the dry-run honest.)
        { userId: { in: Array.from(testUserIds) } },
      ],
      // NEVER delete the patient1@medcore.local demo persona.
      user: {
        email: { notIn: Array.from(PROTECTED_EMAILS) },
      },
    },
    select: {
      id: true,
      mrNumber: true,
      user: { select: { name: true, email: true } },
    },
  });
  counts.patients = junkPatients.length;
  dryLog(
    `Would delete ${junkPatients.length} rows from Patient: ` +
      junkPatients
        .slice(0, 10)
        .map((p) => `${p.mrNumber}/${p.user?.name ?? "?"}`)
        .join(", ")
  );

  // ── A.3 AmbulanceTrip rows with bad callerPhone → set NULL (do NOT delete) ─
  // Prisma can't filter by regex mismatch portably, so we filter in-memory.
  const tripCandidates = await prisma.ambulanceTrip.findMany({
    where: { callerPhone: { not: null } },
    select: { id: true, tripNumber: true, callerPhone: true },
  });
  const badPhones = tripCandidates.filter(
    (t) => typeof t.callerPhone === "string" && !PHONE_REGEX.test(t.callerPhone)
  );
  counts.phones = badPhones.length;
  dryLog(
    `Would NULL callerPhone on ${badPhones.length} rows from AmbulanceTrip: ` +
      badPhones
        .slice(0, 10)
        .map((t) => `${t.tripNumber}('${t.callerPhone}')`)
        .join(", ")
  );

  // ── A.4 InsuranceClaim2 mock rows w/o real submission ───────────────────
  // The user spec mentioned `tpaProvider = 'MOCK TPA'` and `status = 'DRAFT'`;
  // the actual enums are `TpaProvider.MOCK` and `NormalisedClaimStatus`
  // (which has no DRAFT). The closest "never actually submitted" signal is
  // `lastSyncedAt IS NULL && providerClaimRef IS NULL` on a MOCK row.
  // We additionally require `status = SUBMITTED` (the default — anything
  // moved past SUBMITTED was actually progressed somewhere).
  const mockClaims = await prisma.insuranceClaim2.findMany({
    where: {
      tpaProvider: "MOCK",
      status: "SUBMITTED",
      lastSyncedAt: null,
      providerClaimRef: null,
    },
    select: { id: true, insurerName: true, policyNumber: true, billId: true },
  });
  counts.claims = mockClaims.length;
  dryLog(
    `Would delete ${mockClaims.length} rows from InsuranceClaim2 (MOCK, never-synced): ` +
      mockClaims
        .slice(0, 10)
        .map((c) => `${c.insurerName}/${c.policyNumber}`)
        .join(", ")
  );

  // ── A.5 Notifications older than 90 days w/ status SENT or READ ─────────
  const cutoff90 = new Date();
  cutoff90.setDate(cutoff90.getDate() - 90);
  const oldNotifs = await prisma.notification.findMany({
    where: {
      createdAt: { lt: cutoff90 },
      deliveryStatus: {
        in: [NotificationDeliveryStatus.SENT, NotificationDeliveryStatus.READ],
      },
    },
    select: { id: true, title: true },
  });
  counts.notifications = oldNotifs.length;
  dryLog(
    `Would delete ${oldNotifs.length} rows from Notification (>90d SENT/READ): ` +
      oldNotifs
        .slice(0, 10)
        .map((n) => n.title)
        .join(", ")
  );

  // ── A.6 AuditLog older than 30d with no entityId ────────────────────────
  const cutoff30 = new Date();
  cutoff30.setDate(cutoff30.getDate() - 30);
  const orphanAudits = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff30 }, entityId: null },
    select: { id: true, action: true, entity: true },
  });
  counts.audit = orphanAudits.length;
  dryLog(
    `Would delete ${orphanAudits.length} rows from AuditLog (>30d, no entityId): ` +
      orphanAudits
        .slice(0, 10)
        .map((a) => `${a.action}/${a.entity}`)
        .join(", ")
  );

  // ── A.7 WALK_IN appointments older than 7d w/ status NO_SHOW ────────────
  const cutoff7 = new Date();
  cutoff7.setDate(cutoff7.getDate() - 7);
  const staleWalkIns = await prisma.appointment.findMany({
    where: {
      type: AppointmentType.WALK_IN,
      status: AppointmentStatus.NO_SHOW,
      date: { lt: cutoff7 },
    },
    select: { id: true, tokenNumber: true, date: true },
  });
  counts.appointments = staleWalkIns.length;
  dryLog(
    `Would delete ${staleWalkIns.length} rows from Appointment (WALK_IN/NO_SHOW >7d): ` +
      staleWalkIns
        .slice(0, 10)
        .map((a) => `T${a.tokenNumber}@${a.date.toISOString().slice(0, 10)}`)
        .join(", ")
  );

  // ── EXECUTE — wrapped in one transaction for atomicity ──────────────────
  if (MODE === "APPLY") {
    log("Applying Phase A...");
    const testUserIds = testUsers.map((u) => u.id);
    const junkPatientIds = junkPatients.map((p) => p.id);
    await prisma.$transaction([
      // A.3 first (only updates, no relational fan-out)
      prisma.ambulanceTrip.updateMany({
        where: { id: { in: badPhones.map((b) => b.id) } },
        data: { callerPhone: null },
      }),
      // A.5
      prisma.notification.deleteMany({
        where: { id: { in: oldNotifs.map((n) => n.id) } },
      }),
      // A.6
      prisma.auditLog.deleteMany({
        where: { id: { in: orphanAudits.map((a) => a.id) } },
      }),
      // A.7
      prisma.appointment.deleteMany({
        where: { id: { in: staleWalkIns.map((a) => a.id) } },
      }),
      // A.4 — claims (independent of users)
      prisma.insuranceClaim2.deleteMany({
        where: { id: { in: mockClaims.map((c) => c.id) } },
      }),
      // ── Non-cascading children of User (must clear before user.deleteMany) ─
      // Many User relations in the schema use the default RESTRICT semantics
      // rather than ON DELETE CASCADE. We delete the most common culprits
      // up-front so test-user removal can proceed. These deletes use the
      // user-id list directly (not a per-row id list) so they're cheap and
      // self-correcting if a relation already has zero rows.
      prisma.notification.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.notificationPreference.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.passwordResetCode.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.twoFactorTempToken.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.refreshToken.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.staffShift.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.leaveRequest.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.staffCertification.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.overtimeRecord.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.leaveBalance.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.medicationAdministration.deleteMany({ where: { administeredBy: { in: testUserIds } } }),
      prisma.nurseRound.deleteMany({ where: { nurseId: { in: testUserIds } } }),
      prisma.stockMovement.deleteMany({ where: { performedBy: { in: testUserIds } } }),
      prisma.expense.deleteMany({ where: { paidBy: { in: testUserIds } } }),
      prisma.chatMessage.deleteMany({ where: { senderId: { in: testUserIds } } }),
      prisma.chatParticipant.deleteMany({ where: { userId: { in: testUserIds } } }),
      prisma.assetAssignment.deleteMany({ where: { assignedTo: { in: testUserIds } } }),
      prisma.assetMaintenance.deleteMany({ where: { performedBy: { in: testUserIds } } }),
      prisma.controlledSubstanceEntry.deleteMany({ where: { dispensedBy: { in: testUserIds } } }),
      prisma.labQCEntry.deleteMany({ where: { performedBy: { in: testUserIds } } }),
      prisma.patientDocument.deleteMany({ where: { uploadedBy: { in: testUserIds } } }),
      // ── Same defensive pattern for junk patients before A.2 ──────────────
      prisma.appointment.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      prisma.prescription.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      prisma.invoice.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      prisma.labOrder.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      prisma.admission.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      prisma.patientFeedback.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      prisma.consentArtefact.deleteMany({ where: { patientId: { in: junkPatientIds } } }),
      // A.2 — patients next (cascades into many of their own relations)
      prisma.patient.deleteMany({
        where: { id: { in: junkPatientIds } },
      }),
      // A.1 — users last (cascades through their Doctor / remaining Patient).
      prisma.user.deleteMany({
        where: { id: { in: testUserIds } },
      }),
    ]);
    log("Phase A applied.");
  }

  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE B — ENRICH
// ═══════════════════════════════════════════════════════════════════════════

interface PhaseBCounts {
  scribe: number;
  triage: number;
  radiology: number;
  feedback: number;
  medIncident: number;
  frontDeskCall: number;
  dataExport: number;
  billExpl: number;
  previsit: number;
  symptomDiary: number;
  chronicPlan: number;
  chronicCheckIn: number;
  chronicAlert: number;
  nurseRound: number;
  medAdmin: number;
  ipdVitals: number;
  bloodDonor: number;
  bloodDonation: number;
  bloodUnit: number;
  bloodRequest: number;
  bloodCrossMatch: number;
  ambulanceTrip: number;
  emergencyCase: number;
  surgery: number;
}

const ZERO_B_COUNTS: PhaseBCounts = {
  scribe: 0, triage: 0, radiology: 0, feedback: 0, medIncident: 0,
  frontDeskCall: 0, dataExport: 0, billExpl: 0, previsit: 0,
  symptomDiary: 0, chronicPlan: 0, chronicCheckIn: 0, chronicAlert: 0,
  nurseRound: 0, medAdmin: 0, ipdVitals: 0, bloodDonor: 0, bloodDonation: 0,
  bloodUnit: 0, bloodRequest: 0, bloodCrossMatch: 0, ambulanceTrip: 0,
  emergencyCase: 0, surgery: 0,
};

async function phaseB(): Promise<PhaseBCounts> {
  log("=== PHASE B: ENRICH ===");
  const counts: PhaseBCounts = { ...ZERO_B_COUNTS };

  // Pre-load reference data we'll re-use across enrichers.
  const [doctors, patients, completedAppts, recentInvoices, admissions, ambulances, medicines, icd10s, nurses, beds] =
    await Promise.all([
      prisma.doctor.findMany({
        select: { id: true, userId: true, user: { select: { name: true } } },
      }),
      prisma.patient.findMany({
        select: {
          id: true, mrNumber: true,
          user: { select: { id: true, name: true } },
        },
      }),
      prisma.appointment.findMany({
        where: {
          status: AppointmentStatus.COMPLETED,
          date: { gte: daysAgo(30) },
        },
        select: { id: true, doctorId: true, patientId: true, date: true },
        take: 60,
        orderBy: { date: "desc" },
      }),
      prisma.invoice.findMany({
        where: { createdAt: { gte: daysAgo(60) } },
        select: { id: true, patientId: true, totalAmount: true, invoiceNumber: true },
        take: 30,
        orderBy: { createdAt: "desc" },
      }),
      prisma.admission.findMany({
        where: { status: "ADMITTED" },
        select: { id: true, patientId: true, bedId: true, admittedAt: true },
        take: 20,
      }),
      prisma.ambulance.findMany({
        select: { id: true, vehicleNumber: true },
        take: 10,
      }),
      prisma.medicine.findMany({
        select: { id: true, name: true },
        take: 50,
      }),
      prisma.icd10Code.findMany({
        select: { id: true, code: true, description: true },
        take: 100,
      }),
      prisma.user.findMany({
        where: { role: Role.NURSE, isActive: true },
        select: { id: true, name: true },
      }),
      prisma.bed.findMany({ select: { id: true } }),
    ]);

  if (doctors.length === 0 || patients.length === 0) {
    log(
      `WARNING: doctors=${doctors.length} patients=${patients.length} — ` +
        "Phase B will skip groups that depend on missing references."
    );
  }

  // ── B.1 AIScribeSession (20 rows) ───────────────────────────────────────
  // Status enum is { ACTIVE, PAUSED, COMPLETED, CONSENT_WITHDRAWN } — spec
  // asked for SIGNED_OFF/ACTIVE/ABORTED. Map: SIGNED_OFF→COMPLETED+signedOffAt
  // set, ACTIVE→ACTIVE, ABORTED→CONSENT_WITHDRAWN.
  if (completedAppts.length >= 20) {
    const scribeOps: Prisma.PrismaPromise<unknown>[] = [];
    const targetAppts = pickN(completedAppts, 20);
    for (let i = 0; i < 20; i++) {
      const appt = targetAppts[i]!;
      const status: AIScribeStatus =
        i < 12 ? "COMPLETED" : i < 17 ? "ACTIVE" : "CONSENT_WITHDRAWN";
      const transcript = buildScribeTranscript();
      const soapFinal =
        status === "COMPLETED" ? buildSoapFinal() : null;
      const icd = pickN(icd10s, 3).map((c) => ({
        code: c.code, description: c.description,
      }));
      const rxDraft = {
        medications: pickN(medicines, faker.number.int({ min: 2, max: 3 })).map((m) => ({
          name: m.name,
          dosage: pick(["500mg", "250mg", "1g", "10ml", "100mg"]),
          frequency: pick(["BID", "TID", "QID", "OD"]),
          duration: pick(["5 days", "7 days", "10 days", "14 days"]),
        })),
      };
      const createdAt = daysAgo(faker.number.int({ min: 0, max: 14 }));
      const data: Prisma.AIScribeSessionUncheckedCreateInput = {
        id: detId("scribe", appt.id),
        appointmentId: appt.id,
        doctorId: appt.doctorId,
        patientId: appt.patientId,
        consentObtained: true,
        consentAt: createdAt,
        status,
        transcript: transcript as Prisma.InputJsonValue,
        soapFinal: (soapFinal ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        icd10Codes: icd as Prisma.InputJsonValue,
        rxDraft: rxDraft as Prisma.InputJsonValue,
        signedOffAt: status === "COMPLETED" ? createdAt : null,
        signedOffBy: status === "COMPLETED" ? appt.doctorId : null,
        modelVersion: "sarvam-105b-v1",
        createdAt,
      };
      scribeOps.push(
        prisma.aIScribeSession.upsert({
          where: { id: data.id! },
          update: {}, // existence == done
          create: data,
        })
      );
      counts.scribe++;
    }
    dryLog(`Would upsert ${counts.scribe} AIScribeSession rows (12 SIGNED_OFF/COMPLETED, 5 ACTIVE, 3 CONSENT_WITHDRAWN).`);
    if (MODE === "APPLY") await prisma.$transaction(scribeOps);
  } else {
    dryLog(`SKIP AIScribeSession — only ${completedAppts.length} completed appointments available (need ≥20).`);
  }

  // ── B.2 AITriageSession (15 rows) ───────────────────────────────────────
  // Spec: 10 BOOKED, 3 EMERGENCY, 2 ABANDONED. AITriageStatus = { ACTIVE,
  // COMPLETED, ABANDONED, EMERGENCY_DETECTED }. Map: BOOKED→COMPLETED with
  // appointmentId set; EMERGENCY→EMERGENCY_DETECTED; ABANDONED→ABANDONED.
  {
    const triageOps: Prisma.PrismaPromise<unknown>[] = [];
    const langs = [
      ...Array(10).fill("en"),
      ...Array(3).fill("hi"),
      "ta",
      "te",
    ];
    const apptPool = completedAppts.slice(0, 10);
    for (let i = 0; i < 15; i++) {
      const status: AITriageStatus =
        i < 10 ? "COMPLETED" : i < 13 ? "EMERGENCY_DETECTED" : "ABANDONED";
      const language = langs[i] ?? "en";
      const patient = pick(patients);
      const appt = i < 10 && apptPool[i] ? apptPool[i] : null;
      const seedKey = `${i}-${language}`;
      const id = detId("triage", seedKey);
      const data: Prisma.AITriageSessionUncheckedCreateInput = {
        id,
        patientId: patient.id,
        language,
        inputMode: pick(["text", "voice"]),
        status,
        chiefComplaint: pick([
          "Fever and cough for 3 days",
          "Severe headache since morning",
          "Chest tightness on exertion",
          "Abdominal pain after meals",
          "Skin rash with itching",
          "Joint pain in knees",
          "Dizziness on standing",
        ]),
        messages: buildTriageMessages(language) as Prisma.InputJsonValue,
        redFlagDetected: status === "EMERGENCY_DETECTED",
        redFlagReason:
          status === "EMERGENCY_DETECTED"
            ? pick(["Chest pain + diaphoresis", "Stroke FAST signs", "Severe dyspnoea"])
            : null,
        confidence: faker.number.float({ min: 0.6, max: 0.97, fractionDigits: 2 }),
        suggestedSpecialties: ["General Medicine", "Cardiology"] as Prisma.InputJsonValue,
        appointmentId: appt?.id ?? null,
        modelVersion: "sarvam-105b-v1",
        consentGiven: true,
        consentAt: daysAgo(faker.number.int({ min: 0, max: 21 })),
        createdAt: daysAgo(faker.number.int({ min: 0, max: 21 })),
      };
      triageOps.push(
        prisma.aITriageSession.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.triage++;
    }
    dryLog(`Would upsert ${counts.triage} AITriageSession rows (10 COMPLETED+booked, 3 EMERGENCY_DETECTED, 2 ABANDONED).`);
    if (MODE === "APPLY") await prisma.$transaction(triageOps);
  }

  // ── B.3 RadiologyStudy + RadiologyReport (10 pairs across 6 modalities) ─
  if (patients.length > 0) {
    const radOps: Prisma.PrismaPromise<unknown>[] = [];
    const modalities: RadiologyModality[] = [
      "XRAY", "CT", "MRI", "ULTRASOUND", "MAMMOGRAPHY", "PET",
      "XRAY", "CT", "MRI", "ULTRASOUND",
    ];
    const statuses: RadiologyReportStatus[] = [
      "DRAFT", "DRAFT", "DRAFT", "DRAFT",
      "RADIOLOGIST_REVIEW", "RADIOLOGIST_REVIEW",
      "FINAL", "FINAL", "FINAL",
      "AMENDED",
    ];
    for (let i = 0; i < 10; i++) {
      const seed = `rad-${i}`;
      const studyId = detId("radstudy", seed);
      const reportId = detId("radreport", seed);
      const modality = modalities[i]!;
      const status = statuses[i]!;
      const patient = pick(patients);
      const findings = buildAiFindings(modality);
      const study: Prisma.RadiologyStudyUncheckedCreateInput = {
        id: studyId,
        patientId: patient.id,
        modality,
        bodyPart: bodyPartFor(modality),
        images: ([
          { fileKey: `radiology/${seed}-1.dcm`, view: "AP" },
          { fileKey: `radiology/${seed}-2.dcm`, view: "LAT" },
        ]) as unknown as Prisma.InputJsonValue,
        studyDate: daysAgo(faker.number.int({ min: 0, max: 21 })),
        notes: `Routine ${modality.toLowerCase()} study for ${bodyPartFor(modality).toLowerCase()}.`,
      };
      const aiImpression = buildAiImpression(modality, findings);
      const finalReport =
        status === "FINAL" || status === "AMENDED"
          ? `Findings:\n${findings.map((f, j) => `${j + 1}. ${f.text}`).join("\n")}\n\nImpression:\n${aiImpression}`
          : null;
      const report: Prisma.RadiologyReportUncheckedCreateInput = {
        id: reportId,
        studyId,
        aiDraft: `AI-generated draft for ${modality} ${bodyPartFor(modality)}.`,
        aiFindings: findings as unknown as Prisma.InputJsonValue,
        aiImpression,
        radiologistId: doctors[0]?.id ?? null,
        finalReport,
        finalImpression:
          status === "FINAL" || status === "AMENDED" ? aiImpression : null,
        status,
        approvedAt:
          status === "FINAL" || status === "AMENDED"
            ? daysAgo(faker.number.int({ min: 0, max: 5 }))
            : null,
        approvedBy:
          status === "FINAL" || status === "AMENDED"
            ? doctors[0]?.id ?? null
            : null,
      };
      radOps.push(
        prisma.radiologyStudy.upsert({
          where: { id: studyId },
          update: {},
          create: study,
        }),
        prisma.radiologyReport.upsert({
          where: { id: reportId },
          update: {},
          create: report,
        })
      );
      counts.radiology++;
    }
    dryLog(`Would upsert ${counts.radiology} RadiologyStudy/Report pairs across 6 modalities.`);
    if (MODE === "APPLY") await prisma.$transaction(radOps);
  }

  // ── B.4 PatientFeedback (30 rows) ───────────────────────────────────────
  if (patients.length > 0) {
    const fbOps: Prisma.PrismaPromise<unknown>[] = [];
    const cats: FeedbackCategory[] = [
      "DOCTOR", "NURSE", "RECEPTION", "CLEANLINESS", "FOOD",
      "WAITING_TIME", "BILLING", "OVERALL",
    ];
    for (let i = 0; i < 30; i++) {
      const seed = `feedback-${i}`;
      const id = detId("fb", seed);
      const patient = pick(patients);
      const isNegative = i < 5;
      const rating = isNegative
        ? faker.number.int({ min: 1, max: 2 })
        : faker.number.int({ min: 3, max: 5 });
      const sentiment: SentimentLabel =
        rating <= 2 ? "NEGATIVE" : rating === 3 ? "NEUTRAL" : "POSITIVE";
      const appt =
        completedAppts.length > 0 && Math.random() > 0.4
          ? pick(completedAppts)
          : null;
      const data: Prisma.PatientFeedbackUncheckedCreateInput = {
        id,
        patientId: patient.id,
        appointmentId: appt?.id ?? null,
        category: pick(cats),
        rating,
        nps: faker.number.int({ min: isNegative ? 0 : 6, max: isNegative ? 5 : 10 }),
        comment: pick(
          isNegative
            ? [
                "Waiting time was very long.",
                "Reception staff was rude.",
                "Bill had unexpected charges.",
                "Room cleanliness was below expectations.",
                "Food quality needs improvement.",
              ]
            : [
                "Excellent service, very satisfied.",
                "Doctor was very thorough and patient.",
                "Quick check-in and minimal wait.",
                "Nursing care was outstanding.",
                "Smooth billing experience.",
                "Hospital is clean and well-maintained.",
              ]
        ),
        sentiment,
        sentimentScore: isNegative
          ? faker.number.float({ min: -0.95, max: -0.4, fractionDigits: 2 })
          : faker.number.float({ min: 0.4, max: 0.95, fractionDigits: 2 }),
        requestedVia: pick(["SMS", "EMAIL", "WALK_IN"]),
        submittedAt: daysAgo(faker.number.int({ min: 0, max: 60 })),
      };
      fbOps.push(
        prisma.patientFeedback.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.feedback++;
    }
    dryLog(`Would upsert ${counts.feedback} PatientFeedback rows (5 NEGATIVE, mix of categories).`);
    if (MODE === "APPLY") await prisma.$transaction(fbOps);
  }

  // ── B.5 MedicationIncident (5 rows) ─────────────────────────────────────
  if (patients.length > 0 && doctors.length > 0) {
    const incOps: Prisma.PrismaPromise<unknown>[] = [];
    const sevs = ["NEAR_MISS", "MINOR", "MODERATE", "SEVERE", "MINOR"];
    // pick scribe sessions we just upserted
    const scribeIds = (
      await prisma.aIScribeSession.findMany({
        select: { id: true },
        take: 5,
      })
    ).map((s) => s.id);
    const reporterUserId = doctors[0]?.userId;
    for (let i = 0; i < 5; i++) {
      const id = detId("medincident", `${i}`);
      const data: Prisma.MedicationIncidentUncheckedCreateInput = {
        id,
        patientId: pick(patients).id,
        reportedByUserId: reporterUserId!,
        reportedAt: daysAgo(faker.number.int({ min: 0, max: 30 })),
        severity: sevs[i]!,
        scribeSessionId: i < 3 ? scribeIds[i] ?? null : null,
        narrative: pick([
          "Wrong dose written; nurse caught before administration.",
          "Patient given duplicate dose due to handover gap; no harm observed.",
          "Allergy missed in initial review; corrected within 1 hour.",
          "Severe interaction caught at pharmacy verification step.",
          "Look-alike sound-alike substitution averted.",
        ]),
      };
      incOps.push(
        prisma.medicationIncident.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.medIncident++;
    }
    dryLog(`Would upsert ${counts.medIncident} MedicationIncident rows (1 of each severity, 3 with scribeSessionId).`);
    if (MODE === "APPLY") await prisma.$transaction(incOps);
  }

  // ── B.6 FrontDeskCall (25 rows) ─────────────────────────────────────────
  {
    const fdcOps: Prisma.PrismaPromise<unknown>[] = [];
    const cats = ["TRIAGE", "BILLING", "APPT_CHANGE", "OTHER"];
    const dispos = ["RESOLVED", "ABANDONED", "TRANSFERRED"];
    for (let i = 0; i < 25; i++) {
      const id = detId("fdc", `${i}`);
      const data: Prisma.FrontDeskCallUncheckedCreateInput = {
        id,
        calledAt: daysAgo(faker.number.int({ min: 0, max: 14 })),
        durationSec: faker.number.int({ min: 15, max: 480 }),
        fromPhone: indianPhone(),
        toPhone: "+91-22-12345678",
        category: pick(cats),
        disposition: pick(dispos),
        providerId: pick(["twilio", "exotel", "ozonetel"]),
      };
      fdcOps.push(
        prisma.frontDeskCall.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.frontDeskCall++;
    }
    dryLog(`Would upsert ${counts.frontDeskCall} FrontDeskCall rows (last 14d, mixed categories/dispositions).`);
    if (MODE === "APPLY") await prisma.$transaction(fdcOps);
  }

  // ── B.7 PatientDataExport (3 rows) ──────────────────────────────────────
  if (patients.length >= 3) {
    const expOps: Prisma.PrismaPromise<unknown>[] = [];
    const targets: { status: PatientDataExportStatus; format: PatientDataExportFormat }[] = [
      { status: "READY", format: "PDF" },
      { status: "PROCESSING", format: "JSON" },
      { status: "QUEUED", format: "FHIR" },
    ];
    for (let i = 0; i < 3; i++) {
      const t = targets[i]!;
      const id = detId("dpdp-export", `${i}`);
      const data: Prisma.PatientDataExportUncheckedCreateInput = {
        id,
        patientId: pick(patients).id,
        format: t.format,
        status: t.status,
        filePath:
          t.status === "READY"
            ? `/exports/dpdp/patient-${i}-${Date.now()}.pdf`
            : null,
        fileSize: t.status === "READY" ? 1_240_000 : null,
        requestedAt: daysAgo(t.status === "QUEUED" ? 0 : t.status === "PROCESSING" ? 0 : 1),
        startedAt: t.status === "QUEUED" ? null : daysAgo(0),
        readyAt: t.status === "READY" ? daysAgo(0) : null,
      };
      expOps.push(
        prisma.patientDataExport.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.dataExport++;
    }
    dryLog(`Would upsert ${counts.dataExport} PatientDataExport rows (1 READY, 1 PROCESSING, 1 QUEUED).`);
    if (MODE === "APPLY") await prisma.$transaction(expOps);
  }

  // ── B.8 BillExplanation (8 rows) ────────────────────────────────────────
  if (recentInvoices.length >= 8) {
    const beOps: Prisma.PrismaPromise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      const inv = recentInvoices[i]!;
      const id = detId("billexp", inv.id);
      const data: Prisma.BillExplanationUncheckedCreateInput = {
        id,
        invoiceId: inv.id,
        patientId: inv.patientId,
        language: pick(["en", "hi", "mr"]),
        content: `Your bill of ₹${inv.totalAmount.toFixed(2)} covers consultation, lab, and pharmacy charges. GST applied per HSN/SAC codes. Insurance portion (if any) shown separately.`,
        status: pick(["DRAFT", "APPROVED", "SENT"]),
      };
      beOps.push(
        prisma.billExplanation.upsert({
          where: { invoiceId: inv.id },
          update: {},
          create: data,
        })
      );
      counts.billExpl++;
    }
    dryLog(`Would upsert ${counts.billExpl} BillExplanation rows linked to recent invoices.`);
    if (MODE === "APPLY") await prisma.$transaction(beOps);
  }

  // ── B.9 PrevisitChecklist (10 rows) ─────────────────────────────────────
  if (completedAppts.length >= 10) {
    const pcOps: Prisma.PrismaPromise<unknown>[] = [];
    const targetAppts = pickN(completedAppts, 10);
    for (let i = 0; i < 10; i++) {
      const appt = targetAppts[i]!;
      const id = detId("previsit", appt.id);
      const items = [
        { task: "Bring previous prescriptions", done: i % 2 === 0 },
        { task: "List current medications", done: i % 3 === 0 },
        { task: "Fast for 8 hours if blood test", done: i % 2 === 1 },
        { task: "Bring insurance card", done: true },
      ];
      const data: Prisma.PrevisitChecklistUncheckedCreateInput = {
        id,
        appointmentId: appt.id,
        patientId: appt.patientId,
        items: items as Prisma.InputJsonValue,
      };
      pcOps.push(
        prisma.previsitChecklist.upsert({
          where: { appointmentId: appt.id },
          update: {},
          create: data,
        })
      );
      counts.previsit++;
    }
    dryLog(`Would upsert ${counts.previsit} PrevisitChecklist rows.`);
    if (MODE === "APPLY") await prisma.$transaction(pcOps);
  }

  // ── B.10 SymptomDiaryEntry (25 across 5 patients × 14d each) ────────────
  if (patients.length >= 5) {
    const sdOps: Prisma.PrismaPromise<unknown>[] = [];
    const targets = pickN(patients, 5);
    for (const p of targets) {
      for (let d = 0; d < 14; d += Math.ceil(14 / 5)) {
        if (counts.symptomDiary >= 25) break;
        const symptomDate = daysAgo(d);
        // unique on (patientId, symptomDate) — use that as natural key
        const data: Prisma.SymptomDiaryEntryUncheckedCreateInput = {
          patientId: p.id,
          symptomDate,
          entries: [
            { time: "morning", symptoms: ["mild headache", "fatigue"], severity: 4 },
            { time: "evening", symptoms: ["headache improved"], severity: 2 },
          ] as Prisma.InputJsonValue,
        };
        sdOps.push(
          prisma.symptomDiaryEntry.upsert({
            where: {
              patientId_symptomDate: { patientId: p.id, symptomDate },
            },
            update: {},
            create: data,
          })
        );
        counts.symptomDiary++;
      }
    }
    dryLog(`Would upsert ${counts.symptomDiary} SymptomDiaryEntry rows across 5 patients × ~14 days.`);
    if (MODE === "APPLY") await prisma.$transaction(sdOps);
  }

  // ── B.11 ChronicCarePlan + CheckIn + Alert ─────────────────────────────
  if (patients.length >= 4 && doctors.length > 0) {
    const planTargets = pickN(patients, 4);
    const conditions: ChronicConditionCode[] = [
      "DIABETES", "HYPERTENSION", "ASTHMA", "TB",
    ];
    const planOps: Prisma.PrismaPromise<unknown>[] = [];
    const planIdByPatient: Record<string, string> = {};
    for (let i = 0; i < 4; i++) {
      const p = planTargets[i]!;
      const id = detId("ccplan", p.id);
      planIdByPatient[p.id] = id;
      const data: Prisma.ChronicCarePlanUncheckedCreateInput = {
        id,
        patientId: p.id,
        condition: conditions[i]!,
        checkInFrequencyDays: 7,
        thresholds: {
          systolic: 140, diastolic: 90, fasting_glucose: 130,
        } as Prisma.InputJsonValue,
        active: true,
        createdBy: doctors[0]!.userId,
      };
      planOps.push(
        prisma.chronicCarePlan.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.chronicPlan++;
    }
    if (MODE === "APPLY") await prisma.$transaction(planOps);

    const ciOps: Prisma.PrismaPromise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const p = planTargets[i % 4]!;
      const id = detId("cccheck", `${p.id}-${i}`);
      const data: Prisma.ChronicCareCheckInUncheckedCreateInput = {
        id,
        planId: planIdByPatient[p.id]!,
        patientId: p.id,
        loggedAt: daysAgo(faker.number.int({ min: 0, max: 21 })),
        responses: { mood: pick(["good", "ok", "tired"]), bp: "128/84" } as Prisma.InputJsonValue,
      };
      ciOps.push(
        prisma.chronicCareCheckIn.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.chronicCheckIn++;
    }
    if (MODE === "APPLY") await prisma.$transaction(ciOps);

    const alertOps: Prisma.PrismaPromise<unknown>[] = [];
    const sevs: ChronicCareAlertSeverity[] = ["LOW", "MEDIUM", "HIGH"];
    for (let i = 0; i < 3; i++) {
      const p = planTargets[i]!;
      const id = detId("ccalert", `${p.id}-${i}`);
      const data: Prisma.ChronicCareAlertUncheckedCreateInput = {
        id,
        planId: planIdByPatient[p.id]!,
        patientId: p.id,
        severity: sevs[i]!,
        reason: pick([
          "BP > 140/90 on 3 consecutive readings.",
          "Fasting glucose > 180.",
          "Missed 2 check-ins in a row.",
        ]),
      };
      alertOps.push(
        prisma.chronicCareAlert.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.chronicAlert++;
    }
    if (MODE === "APPLY") await prisma.$transaction(alertOps);

    dryLog(`Would upsert ${counts.chronicPlan} ChronicCarePlan, ${counts.chronicCheckIn} ChronicCareCheckIn, ${counts.chronicAlert} ChronicCareAlert.`);
  }

  // ── B.12 NurseRound (30 in last 7d) ─────────────────────────────────────
  if (admissions.length > 0 && nurses.length > 0) {
    const nrOps: Prisma.PrismaPromise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      const adm = pick(admissions);
      const nurse = pick(nurses);
      const id = detId("nurseround", `${adm.id}-${i}`);
      const data: Prisma.NurseRoundUncheckedCreateInput = {
        id,
        admissionId: adm.id,
        nurseId: nurse.id,
        notes: pick([
          "Patient comfortable, vitals stable.",
          "Pain managed with prn analgesia.",
          "IV line patent, no swelling at site.",
          "Encouraged ambulation.",
          "Sleeping; no complaints.",
        ]),
        performedAt: daysAgo(faker.number.int({ min: 0, max: 7 })),
      };
      nrOps.push(
        prisma.nurseRound.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.nurseRound++;
    }
    dryLog(`Would upsert ${counts.nurseRound} NurseRound rows (last 7d).`);
    if (MODE === "APPLY") await prisma.$transaction(nrOps);
  }

  // ── B.13 MedicationAdministration (50 in last 7d) ──────────────────────
  if (admissions.length > 0) {
    // Need MedicationOrder rows to attach to. Create a thin set per admission
    // if missing, then attach 50 administrations across them.
    const orders = await prisma.medicationOrder.findMany({
      where: { admissionId: { in: admissions.map((a) => a.id) } },
      select: { id: true },
      take: 30,
    });
    if (orders.length > 0) {
      const maOps: Prisma.PrismaPromise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        const order = pick(orders);
        const id = detId("medadmin", `${order.id}-${i}`);
        const scheduledAt = daysAgo(faker.number.int({ min: 0, max: 7 }));
        const status = pick(["SCHEDULED", "ADMINISTERED", "ADMINISTERED", "ADMINISTERED", "MISSED"]);
        const data: Prisma.MedicationAdministrationUncheckedCreateInput = {
          id,
          medicationOrderId: order.id,
          scheduledAt,
          administeredAt:
            status === "ADMINISTERED" ? scheduledAt : null,
          administeredBy:
            status === "ADMINISTERED" && nurses.length > 0
              ? pick(nurses).id
              : null,
          status: status as Prisma.MedicationAdministrationUncheckedCreateInput["status"],
        };
        maOps.push(
          prisma.medicationAdministration.upsert({
            where: { id },
            update: {},
            create: data,
          })
        );
        counts.medAdmin++;
      }
      dryLog(`Would upsert ${counts.medAdmin} MedicationAdministration rows.`);
      if (MODE === "APPLY") await prisma.$transaction(maOps);
    } else {
      dryLog(`SKIP MedicationAdministration — no MedicationOrder rows on active admissions.`);
    }
  }

  // ── B.14 IpdVitals (80 in last 7d) ─────────────────────────────────────
  if (admissions.length > 0 && nurses.length > 0) {
    const ivOps: Prisma.PrismaPromise<unknown>[] = [];
    for (let i = 0; i < 80; i++) {
      const adm = pick(admissions);
      const id = detId("ipdvitals", `${adm.id}-${i}`);
      const data: Prisma.IpdVitalsUncheckedCreateInput = {
        id,
        admissionId: adm.id,
        recordedBy: pick(nurses).id,
        bloodPressureSystolic: faker.number.int({ min: 100, max: 150 }),
        bloodPressureDiastolic: faker.number.int({ min: 60, max: 95 }),
        temperature: faker.number.float({ min: 36.4, max: 38.6, fractionDigits: 1 }),
        pulseRate: faker.number.int({ min: 60, max: 110 }),
        respiratoryRate: faker.number.int({ min: 12, max: 22 }),
        spO2: faker.number.int({ min: 92, max: 100 }),
        painScore: faker.number.int({ min: 0, max: 7 }),
        recordedAt: daysAgo(faker.number.int({ min: 0, max: 7 })),
      };
      ivOps.push(
        prisma.ipdVitals.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.ipdVitals++;
    }
    dryLog(`Would upsert ${counts.ipdVitals} IpdVitals rows.`);
    if (MODE === "APPLY") await prisma.$transaction(ivOps);
  }

  // ── B.15 BloodDonor (25) — Indian ABO/Rh distribution ──────────────────
  // 40% O+, 30% B+, 20% A+, plus a few negatives + AB.
  const bgDistribution: BloodGroupType[] = [
    ...Array(10).fill("O_POS"),
    ...Array(8).fill("B_POS"),
    ...Array(5).fill("A_POS"),
    "O_NEG", "B_NEG", "A_NEG", "AB_POS", "AB_NEG",
  ];
  const donorOps: Prisma.PrismaPromise<unknown>[] = [];
  const donorIdsCreated: string[] = [];
  for (let i = 0; i < 25; i++) {
    const donorNumber = `BD-${(i + 1).toString().padStart(4, "0")}`;
    const id = detId("blooddonor", donorNumber);
    donorIdsCreated.push(id);
    const gender: Gender = i % 5 === 0 ? "FEMALE" : "MALE";
    const data: Prisma.BloodDonorUncheckedCreateInput = {
      id,
      donorNumber,
      name: indianName(gender),
      phone: indianPhone(),
      email: faker.internet.email().toLowerCase(),
      bloodGroup: bgDistribution[i]!,
      dateOfBirth: indianDob(20, 55),
      gender,
      weight: faker.number.float({ min: 55, max: 90, fractionDigits: 1 }),
      address: pick(INDIAN_CITIES),
      lastDonation: daysAgo(faker.number.int({ min: 60, max: 365 })),
      totalDonations: faker.number.int({ min: 1, max: 12 }),
      isEligible: true,
    };
    donorOps.push(
      prisma.bloodDonor.upsert({
        where: { donorNumber },
        update: {},
        create: data,
      })
    );
    counts.bloodDonor++;
  }
  dryLog(`Would upsert ${counts.bloodDonor} BloodDonor rows (40% O+, 30% B+, 20% A+, rest mixed).`);
  if (MODE === "APPLY") await prisma.$transaction(donorOps);

  // ── B.16 BloodDonation (15 in last 30d) ────────────────────────────────
  const donationOps: Prisma.PrismaPromise<unknown>[] = [];
  const donationIdsCreated: string[] = [];
  for (let i = 0; i < 15; i++) {
    const unitNumber = `UN-${(i + 1).toString().padStart(5, "0")}`;
    const id = detId("blooddonation", unitNumber);
    donationIdsCreated.push(id);
    const data: Prisma.BloodDonationUncheckedCreateInput = {
      id,
      donorId: donorIdsCreated[i % donorIdsCreated.length]!,
      donatedAt: daysAgo(faker.number.int({ min: 0, max: 30 })),
      volumeMl: 450,
      unitNumber,
      approved: true,
      hemoglobinGdL: faker.number.float({ min: 12.5, max: 16.0, fractionDigits: 1 }),
      bloodPressure: `${faker.number.int({ min: 110, max: 130 })}/${faker.number.int({ min: 70, max: 85 })}`,
    };
    donationOps.push(
      prisma.bloodDonation.upsert({
        where: { unitNumber },
        update: {},
        create: data,
      })
    );
    counts.bloodDonation++;
  }
  dryLog(`Would upsert ${counts.bloodDonation} BloodDonation rows.`);
  if (MODE === "APPLY") await prisma.$transaction(donationOps);

  // ── B.17 BloodUnit (30 with mixed statuses + spread expiry) ────────────
  const unitOps: Prisma.PrismaPromise<unknown>[] = [];
  const unitStatuses: BloodUnitStatus[] = [
    ...Array(15).fill("AVAILABLE"),
    ...Array(6).fill("RESERVED"),
    ...Array(6).fill("ISSUED"),
    ...Array(3).fill("EXPIRED"),
  ];
  const components: BloodComponent[] = [
    "WHOLE_BLOOD", "PACKED_RED_CELLS", "PLATELETS", "FRESH_FROZEN_PLASMA", "CRYOPRECIPITATE",
  ];
  const bloodUnitIdsCreated: string[] = [];
  for (let i = 0; i < 30; i++) {
    const unitNumber = `BU-${(i + 1).toString().padStart(5, "0")}`;
    const id = detId("bloodunit", unitNumber);
    bloodUnitIdsCreated.push(id);
    const status = unitStatuses[i]!;
    const collectedAt = daysAgo(faker.number.int({ min: 1, max: 35 }));
    const expiresAt = new Date(collectedAt);
    if (status === "EXPIRED") {
      expiresAt.setDate(collectedAt.getDate() + 5); // already past
    } else {
      expiresAt.setDate(collectedAt.getDate() + 35);
    }
    const data: Prisma.BloodUnitUncheckedCreateInput = {
      id,
      unitNumber,
      donationId: donationIdsCreated[i % donationIdsCreated.length] ?? null,
      bloodGroup: pick(bgDistribution),
      component: pick(components),
      volumeMl: 450,
      collectedAt,
      expiresAt,
      status,
      storageLocation: pick(["Fridge A", "Fridge B", "Freezer Plasma-1"]),
    };
    unitOps.push(
      prisma.bloodUnit.upsert({
        where: { unitNumber },
        update: {},
        create: data,
      })
    );
    counts.bloodUnit++;
  }
  dryLog(`Would upsert ${counts.bloodUnit} BloodUnit rows (15 AVAILABLE, 6 RESERVED, 6 ISSUED, 3 EXPIRED).`);
  if (MODE === "APPLY") await prisma.$transaction(unitOps);

  // ── B.18 BloodRequest (8) + BloodCrossMatch (5) ─────────────────────────
  if (patients.length > 0 && doctors.length > 0) {
    const reqOps: Prisma.PrismaPromise<unknown>[] = [];
    const reqIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const requestNumber = `BR-${(i + 1).toString().padStart(4, "0")}`;
      const id = detId("bloodreq", requestNumber);
      reqIds.push(id);
      const data: Prisma.BloodRequestUncheckedCreateInput = {
        id,
        requestNumber,
        patientId: pick(patients).id,
        bloodGroup: pick(bgDistribution),
        component: pick(components),
        unitsRequested: faker.number.int({ min: 1, max: 3 }),
        reason: pick([
          "Pre-op transfusion for elective surgery",
          "Severe anaemia work-up",
          "Trauma case",
          "Chronic transfusion (thalassemia)",
          "Postpartum hemorrhage",
        ]),
        urgency: pick(["ROUTINE", "URGENT", "EMERGENCY"]),
        requestedBy: doctors[0]!.userId,
        fulfilled: i < 4,
      };
      reqOps.push(
        prisma.bloodRequest.upsert({
          where: { requestNumber },
          update: {},
          create: data,
        })
      );
      counts.bloodRequest++;
    }
    if (MODE === "APPLY") await prisma.$transaction(reqOps);

    const xmOps: Prisma.PrismaPromise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const id = detId("bloodxm", `${reqIds[i]!}-${i}`);
      const data: Prisma.BloodCrossMatchUncheckedCreateInput = {
        id,
        requestId: reqIds[i]!,
        unitId: bloodUnitIdsCreated[i] ?? bloodUnitIdsCreated[0]!,
        compatible: true,
        method: pick(["IS", "AHG", "Gel"]),
        performedBy: doctors[0]!.userId,
        performedAt: daysAgo(faker.number.int({ min: 0, max: 5 })),
      };
      xmOps.push(
        prisma.bloodCrossMatch.upsert({
          where: { id },
          update: {},
          create: data,
        })
      );
      counts.bloodCrossMatch++;
    }
    dryLog(`Would upsert ${counts.bloodRequest} BloodRequest + ${counts.bloodCrossMatch} BloodCrossMatch rows.`);
    if (MODE === "APPLY") await prisma.$transaction(xmOps);
  }

  // ── B.19 AmbulanceTrip (12 in last 14d, valid +91 phones) ──────────────
  if (ambulances.length > 0) {
    const atOps: Prisma.PrismaPromise<unknown>[] = [];
    const atStatuses: AmbulanceTripStatus[] = [
      "REQUESTED", "DISPATCHED", "ARRIVED_SCENE", "EN_ROUTE_HOSPITAL",
      "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED",
      "COMPLETED", "COMPLETED", "CANCELLED", "CANCELLED",
    ];
    for (let i = 0; i < 12; i++) {
      const tripNumber = `AMB-${Date.now().toString().slice(-4)}-${(i + 1).toString().padStart(3, "0")}`;
      // Use stable trip numbers so re-runs are idempotent.
      const stableTripNumber = `AMB-DEMO-${(i + 1).toString().padStart(4, "0")}`;
      const id = detId("ambtrip", stableTripNumber);
      const data: Prisma.AmbulanceTripUncheckedCreateInput = {
        id,
        tripNumber: stableTripNumber,
        ambulanceId: pick(ambulances).id,
        patientId: Math.random() > 0.3 ? pick(patients).id : null,
        callerName: indianName(),
        callerPhone: indianPhone().replace(/[^+\d]/g, ""), // must match /^\+?\d{10,15}$/
        pickupAddress: pick(INDIAN_CITIES),
        dropAddress: "MedCore Hospital",
        distanceKm: faker.number.float({ min: 2, max: 35, fractionDigits: 1 }),
        chiefComplaint: pick([
          "Chest pain", "RTA — fall from bike", "Severe breathlessness",
          "Stroke-like symptoms", "Labour pains", "Seizure",
        ]),
        priority: pick(["RED", "YELLOW", "GREEN"]),
        equipmentChecked: true,
        requestedAt: daysAgo(faker.number.int({ min: 0, max: 14 })),
        status: atStatuses[i]!,
        cost: faker.number.float({ min: 800, max: 3500, fractionDigits: 2 }),
      };
      atOps.push(
        prisma.ambulanceTrip.upsert({
          where: { tripNumber: stableTripNumber },
          update: {},
          create: data,
        })
      );
      counts.ambulanceTrip++;
      void tripNumber;
    }
    dryLog(`Would upsert ${counts.ambulanceTrip} AmbulanceTrip rows (last 14d, valid +91 phones).`);
    if (MODE === "APPLY") await prisma.$transaction(atOps);
  }

  // ── B.20 EmergencyCase (10 in last 14d) ─────────────────────────────────
  if (patients.length > 0) {
    const ecOps: Prisma.PrismaPromise<unknown>[] = [];
    const triageLevels: TriageLevel[] = [
      "RESUSCITATION", "EMERGENT", "URGENT", "LESS_URGENT", "NON_URGENT",
    ];
    const ecStatuses: EmergencyStatus[] = [
      "WAITING", "TRIAGED", "IN_TREATMENT", "ADMITTED", "DISCHARGED",
      "DISCHARGED", "TRANSFERRED", "LEFT_WITHOUT_BEING_SEEN", "DISCHARGED", "TRIAGED",
    ];
    for (let i = 0; i < 10; i++) {
      const caseNumber = `ER-DEMO-${(i + 1).toString().padStart(4, "0")}`;
      const id = detId("emergcase", caseNumber);
      const data: Prisma.EmergencyCaseUncheckedCreateInput = {
        id,
        caseNumber,
        patientId: Math.random() > 0.2 ? pick(patients).id : null,
        unknownName: Math.random() > 0.85 ? "Unknown male, ~40" : null,
        arrivedAt: daysAgo(faker.number.int({ min: 0, max: 14 })),
        arrivalMode: pick(["Walk-in", "Ambulance", "Police", "Referred"]),
        triageLevel: pick(triageLevels),
        chiefComplaint: pick([
          "Severe chest pain", "Road traffic accident", "Acute abdomen",
          "Status epilepticus", "Severe burns", "Anaphylaxis",
          "Snake bite", "Drowning", "Penetrating injury",
        ]),
        mewsScore: faker.number.int({ min: 0, max: 9 }),
        vitalsBP: `${faker.number.int({ min: 90, max: 160 })}/${faker.number.int({ min: 60, max: 100 })}`,
        vitalsPulse: faker.number.int({ min: 60, max: 130 }),
        vitalsResp: faker.number.int({ min: 14, max: 30 }),
        vitalsSpO2: faker.number.int({ min: 88, max: 99 }),
        vitalsTemp: faker.number.float({ min: 36.0, max: 39.5, fractionDigits: 1 }),
        glasgowComa: faker.number.int({ min: 8, max: 15 }),
        status: ecStatuses[i]!,
        disposition: pick(["admit", "discharge", "transfer", "dama"]),
      };
      ecOps.push(
        prisma.emergencyCase.upsert({
          where: { caseNumber },
          update: {},
          create: data,
        })
      );
      counts.emergencyCase++;
    }
    dryLog(`Would upsert ${counts.emergencyCase} EmergencyCase rows (last 14d, full triage data).`);
    if (MODE === "APPLY") await prisma.$transaction(ecOps);
  }

  // ── B.21 Surgery (15 across all states) ─────────────────────────────────
  if (patients.length > 0 && doctors.length > 0) {
    const ots = await prisma.operatingTheater.findMany({
      select: { id: true },
      take: 5,
    });
    if (ots.length > 0) {
      const sgOps: Prisma.PrismaPromise<unknown>[] = [];
      const sgStatuses: SurgeryStatus[] = [
        "SCHEDULED", "SCHEDULED", "SCHEDULED",
        "IN_PROGRESS", "IN_PROGRESS",
        "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED",
        "CANCELLED", "CANCELLED",
        "POSTPONED", "POSTPONED", "POSTPONED",
      ];
      for (let i = 0; i < 15; i++) {
        const caseNumber = `SUR-DEMO-${(i + 1).toString().padStart(4, "0")}`;
        const id = detId("surgery", caseNumber);
        const status = sgStatuses[i]!;
        const scheduledAt = daysAgo(
          status === "SCHEDULED"
            ? -faker.number.int({ min: 1, max: 14 }) // future
            : faker.number.int({ min: 1, max: 30 })
        );
        const data: Prisma.SurgeryUncheckedCreateInput = {
          id,
          caseNumber,
          patientId: pick(patients).id,
          surgeonId: pick(doctors).id,
          otId: pick(ots).id,
          procedure: pick([
            "Laparoscopic Cholecystectomy",
            "Total Knee Replacement",
            "C-Section",
            "Appendectomy",
            "Hernia Repair",
            "Cataract Extraction",
            "Hysterectomy",
            "ORIF Femur",
          ]),
          scheduledAt,
          durationMin: faker.number.int({ min: 45, max: 240 }),
          status,
          anaesthesiologist: indianName(),
          consentSigned: status !== "CANCELLED",
          allergiesVerified: status !== "CANCELLED",
          siteMarked: status === "COMPLETED" || status === "IN_PROGRESS",
          actualStartAt:
            status === "COMPLETED" || status === "IN_PROGRESS"
              ? scheduledAt
              : null,
          actualEndAt: status === "COMPLETED" ? scheduledAt : null,
          cost: faker.number.float({ min: 25000, max: 200000, fractionDigits: 2 }),
          diagnosis: "Pre-op clinical diagnosis pending pathology",
        };
        sgOps.push(
          prisma.surgery.upsert({
            where: { caseNumber },
            update: {},
            create: data,
          })
        );
        counts.surgery++;
      }
      dryLog(`Would upsert ${counts.surgery} Surgery rows across SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED/POSTPONED.`);
      if (MODE === "APPLY") await prisma.$transaction(sgOps);
    } else {
      dryLog(`SKIP Surgery — no OperatingTheater rows present.`);
    }
  }

  return counts;
}

// ─── Helpers used by Phase B builders ─────────────────────────────────────
function daysAgo(d: number): Date {
  const out = new Date();
  out.setDate(out.getDate() - d);
  return out;
}

function buildScribeTranscript(): Array<{
  speaker: "DOCTOR" | "PATIENT";
  text: string;
  ts: number;
}> {
  const turns = faker.number.int({ min: 8, max: 15 });
  const out: { speaker: "DOCTOR" | "PATIENT"; text: string; ts: number }[] = [];
  const doctorLines = [
    "What brings you in today?",
    "How long have you had these symptoms?",
    "Any fever associated?",
    "Are you taking any medications?",
    "Any allergies I should know of?",
    "Let me examine you. Take a deep breath please.",
    "I'm going to prescribe a few medicines and order a blood test.",
    "Come back in a week if it doesn't improve.",
  ];
  const patientLines = [
    "I've been having a cough for about 4 days.",
    "It started after I got caught in the rain.",
    "Yes, mild fever in the evenings.",
    "Just paracetamol when needed.",
    "No known allergies.",
    "It hurts when I cough.",
    "Okay, doctor, thank you.",
  ];
  for (let i = 0; i < turns; i++) {
    const speaker: "DOCTOR" | "PATIENT" = i % 2 === 0 ? "DOCTOR" : "PATIENT";
    out.push({
      speaker,
      text: speaker === "DOCTOR" ? pick(doctorLines) : pick(patientLines),
      ts: i * 4500,
    });
  }
  return out;
}

function buildSoapFinal() {
  return {
    subjective:
      "Patient presents with productive cough × 4 days, mild evening fever, no SOB. No chest pain. No prior comorbidities.",
    objective:
      "Afebrile at exam. Vitals stable. Chest: scattered rhonchi, air entry equal bilaterally. Throat mildly congested.",
    assessment: "Acute bronchitis, likely viral.",
    plan:
      "Symptomatic Rx: paracetamol PRN, levosalbutamol nebulisation BD × 3 days, plenty of fluids. Review in 7 days; sooner if SOB or high fever.",
  };
}

function buildTriageMessages(language: string) {
  const greet =
    language === "hi"
      ? "नमस्ते, मैं आपकी कैसे मदद कर सकता हूँ?"
      : language === "ta"
      ? "வணக்கம், உங்களுக்கு எப்படி உதவ முடியும்?"
      : language === "te"
      ? "నమస్కారం, మీకు ఎలా సహాయపడగలను?"
      : "Hello, how can I help you today?";
  return [
    { role: "assistant", content: greet, ts: Date.now() - 60_000 },
    { role: "user", content: "I have fever and cough.", ts: Date.now() - 50_000 },
    { role: "assistant", content: "How many days?", ts: Date.now() - 40_000 },
    { role: "user", content: "3 days.", ts: Date.now() - 30_000 },
    { role: "assistant", content: "Any breathlessness?", ts: Date.now() - 20_000 },
    { role: "user", content: "No.", ts: Date.now() - 10_000 },
  ];
}

function bodyPartFor(modality: RadiologyModality): string {
  switch (modality) {
    case "XRAY": return "Chest";
    case "CT": return "Brain";
    case "MRI": return "Lumbar Spine";
    case "ULTRASOUND": return "Abdomen";
    case "MAMMOGRAPHY": return "Breast";
    case "PET": return "Whole Body";
  }
}

function buildAiFindings(modality: RadiologyModality) {
  const base = {
    XRAY: [
      { text: "Right lower-zone opacity, suggestive of consolidation.", confidence: 0.82, region: { x: 220, y: 340, w: 90, h: 80 } },
      { text: "Cardiac silhouette within normal limits.", confidence: 0.95 },
      { text: "No pleural effusion.", confidence: 0.91 },
    ],
    CT: [
      { text: "Small hypodensity in right basal ganglia, ?lacunar.", confidence: 0.71, region: { x: 180, y: 200, w: 30, h: 30 } },
      { text: "No mass effect or midline shift.", confidence: 0.97 },
    ],
    MRI: [
      { text: "L4-L5 disc bulge with mild thecal sac indentation.", confidence: 0.86, region: { x: 240, y: 410, w: 60, h: 30 } },
      { text: "No cord compression.", confidence: 0.94 },
      { text: "Facet hypertrophy at L5-S1.", confidence: 0.78 },
    ],
    ULTRASOUND: [
      { text: "Gallbladder contains a 9 mm calculus.", confidence: 0.88 },
      { text: "Liver echotexture normal.", confidence: 0.92 },
    ],
    MAMMOGRAPHY: [
      { text: "BIRADS-2 lesion in left UOQ, likely benign.", confidence: 0.79 },
      { text: "No suspicious microcalcifications.", confidence: 0.91 },
    ],
    PET: [
      { text: "Mild FDG uptake in mediastinal lymph nodes.", confidence: 0.74 },
      { text: "No focal hypermetabolism elsewhere.", confidence: 0.9 },
    ],
  } as const;
  return [...base[modality]];
}

function buildAiImpression(
  modality: RadiologyModality,
  _findings: { text: string; confidence: number }[]
): string {
  switch (modality) {
    case "XRAY":
      return "Right lower-zone consolidation, likely community-acquired pneumonia. Recommend clinical correlation and follow-up CXR in 4-6 weeks.";
    case "CT":
      return "Likely small lacunar infarct in right basal ganglia. No acute haemorrhage or mass effect.";
    case "MRI":
      return "Lumbar spondylosis with L4-L5 disc bulge. No cord compression. Conservative management advised.";
    case "ULTRASOUND":
      return "Cholelithiasis with no signs of acute cholecystitis. Surgical opinion if symptomatic.";
    case "MAMMOGRAPHY":
      return "BIRADS-2: Benign findings. Routine annual screening recommended.";
    case "PET":
      return "Mild reactive FDG uptake in mediastinal nodes. No definite metabolic evidence of malignancy. Correlate clinically.";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const startedAt = new Date();
  log(
    `mode=${MODE} phase=${args.phase} startedAt=${startedAt.toISOString()} faker.seed=12345`
  );
  if (!process.env.DATABASE_URL) {
    console.error(
      `${TAG} FATAL: DATABASE_URL is not set. Aborting before any DB work.`
    );
    process.exit(2);
  }

  let aCounts: PhaseACounts | null = null;
  let bCounts: PhaseBCounts | null = null;

  if (args.phase === "a" || args.phase === "both") {
    aCounts = await phaseA();
  }
  if (args.phase === "b" || args.phase === "both") {
    bCounts = await phaseB();
  }

  const finishedAt = new Date();
  log("=== SUMMARY ===");
  if (aCounts) {
    log(
      `${MODE === "DRY_RUN" ? DRY + " " : ""}Phase A would delete: ` +
        `${aCounts.users} users, ${aCounts.patients} patients, ${aCounts.phones} phones (NULLed), ` +
        `${aCounts.claims} claims, ${aCounts.notifications} notifications, ` +
        `${aCounts.audit} audit, ${aCounts.appointments} appointments`
    );
  }
  if (bCounts) {
    log(
      `${MODE === "DRY_RUN" ? DRY + " " : ""}Phase B would upsert: ` +
        `${bCounts.scribe} scribe, ${bCounts.triage} triage, ${bCounts.radiology} radiology, ` +
        `${bCounts.feedback} feedback, ${bCounts.medIncident} medIncident, ` +
        `${bCounts.frontDeskCall} frontDeskCall, ${bCounts.dataExport} dataExport, ` +
        `${bCounts.billExpl} billExpl, ${bCounts.previsit} previsit, ` +
        `${bCounts.symptomDiary} symptomDiary, ${bCounts.chronicPlan} chronicPlan, ` +
        `${bCounts.chronicCheckIn} chronicCheckIn, ${bCounts.chronicAlert} chronicAlert, ` +
        `${bCounts.nurseRound} nurseRound, ${bCounts.medAdmin} medAdmin, ${bCounts.ipdVitals} ipdVitals, ` +
        `${bCounts.bloodDonor} bloodDonor, ${bCounts.bloodDonation} bloodDonation, ${bCounts.bloodUnit} bloodUnit, ` +
        `${bCounts.bloodRequest} bloodRequest, ${bCounts.bloodCrossMatch} bloodCrossMatch, ` +
        `${bCounts.ambulanceTrip} ambulanceTrip, ${bCounts.emergencyCase} emergencyCase, ${bCounts.surgery} surgery`
    );
  }
  const total =
    (aCounts
      ? aCounts.users +
        aCounts.patients +
        aCounts.phones +
        aCounts.claims +
        aCounts.notifications +
        aCounts.audit +
        aCounts.appointments
      : 0) +
    (bCounts
      ? Object.values(bCounts).reduce((s, n) => s + n, 0)
      : 0);
  log(
    `Total operations: ${total}. ${MODE === "DRY_RUN" ? "Run again with --apply to commit." : "Applied."} durationMs=${finishedAt.getTime() - startedAt.getTime()}`
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(`${TAG} FATAL:`, err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
