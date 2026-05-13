import { PrismaClient, Role, Gender } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

async function main() {
  console.log("Seeding database...");

  // Create the default tenant first. Multi-tenancy is plumbed through
  // every authed request: User.tenantId becomes the JWT 'tenantId'
  // claim, which tenantScopedPrisma uses to filter every read+write.
  // Without this seed row, all seeded users would land with
  // tenantId=null and several E2E specs fail (cross-tenant-isolation
  // wire-level beacon, /auth/me tenantId surfacing, any test that
  // asserts cross-tenant isolation behaviours).
  const defaultTenant = await prisma.tenant.upsert({
    where: { subdomain: "default" },
    update: {},
    create: {
      name: "MedCore Default",
      subdomain: "default",
      active: true,
    },
  });
  console.log("Created tenant:", defaultTenant.subdomain);
  const tenantId = defaultTenant.id;

  // Create Admin
  const admin = await prisma.user.upsert({
    where: { email: "admin@medcore.local" },
    update: { tenantId },
    create: {
      email: "admin@medcore.local",
      phone: "9999900000",
      name: "System Admin",
      passwordHash: hashPassword("admin123"),
      role: Role.ADMIN,
      tenantId,
    },
  });
  console.log("Created admin:", admin.email);

  // Create Doctors
  // Specialization strings here MUST match what the AI triage prompt returns
  // (apps/api/src/services/ai/prompts.ts → TRIAGE_SYSTEM). The triage route's
  // /:sessionId GET handler does `Doctor.findMany({ specialization: { in:
  // suggestedSpecialties } })` (exact match), so any mismatch yields an empty
  // "Recommended Doctors" panel for that complaint.
  const doctorsData = [
    {
      email: "dr.sharma@medcore.local",
      phone: "9999900001",
      name: "Dr. Rajesh Sharma",
      specialization: "General Medicine",
      qualification: "MBBS, MD",
    },
    {
      email: "dr.patel@medcore.local",
      phone: "9999900002",
      name: "Dr. Priya Patel",
      specialization: "Pediatrics",
      qualification: "MBBS, DCH",
    },
    {
      email: "dr.khan@medcore.local",
      phone: "9999900003",
      name: "Dr. Amir Khan",
      specialization: "Orthopedics",
      qualification: "MBBS, MS Ortho",
    },
    {
      email: "dr.iyer@medcore.local",
      phone: "9999900004",
      name: "Dr. Anjali Iyer",
      specialization: "Pulmonologist",
      qualification: "MBBS, MD (Pulmonary Medicine)",
    },
    {
      email: "dr.menon@medcore.local",
      phone: "9999900005",
      name: "Dr. Vikram Menon",
      specialization: "Cardiologist",
      qualification: "MBBS, MD, DM (Cardiology)",
    },
    {
      email: "dr.rao@medcore.local",
      phone: "9999900006",
      name: "Dr. Kavita Rao",
      specialization: "Dermatologist",
      qualification: "MBBS, MD (Dermatology)",
    },
    {
      email: "dr.singh@medcore.local",
      phone: "9999900007",
      name: "Dr. Harpreet Singh",
      specialization: "ENT",
      qualification: "MBBS, MS (ENT)",
    },
    {
      email: "dr.banerjee@medcore.local",
      phone: "9999900008",
      name: "Dr. Sourav Banerjee",
      specialization: "Neurologist",
      qualification: "MBBS, MD, DM (Neurology)",
    },
    {
      email: "dr.gupta@medcore.local",
      phone: "9999900009",
      name: "Dr. Neha Gupta",
      specialization: "Gastroenterologist",
      qualification: "MBBS, MD, DM (Gastroenterology)",
    },
    {
      email: "dr.fernandes@medcore.local",
      phone: "9999900012",
      name: "Dr. Maria Fernandes",
      specialization: "Gynecologist",
      qualification: "MBBS, MS (Obstetrics & Gynecology)",
    },
    {
      email: "dr.nair@medcore.local",
      phone: "9999900013",
      name: "Dr. Arjun Nair",
      specialization: "Psychiatrist",
      qualification: "MBBS, MD (Psychiatry)",
    },
    {
      email: "dr.bose@medcore.local",
      phone: "9999900014",
      name: "Dr. Ritu Bose",
      specialization: "Ophthalmologist",
      qualification: "MBBS, MS (Ophthalmology)",
    },
    {
      email: "dr.joshi@medcore.local",
      phone: "9999900015",
      name: "Dr. Sameer Joshi",
      specialization: "Urologist",
      qualification: "MBBS, MS, MCh (Urology)",
    },
    {
      email: "dr.reddy@medcore.local",
      phone: "9999900016",
      name: "Dr. Lakshmi Reddy",
      specialization: "Endocrinologist",
      qualification: "MBBS, MD, DM (Endocrinology)",
    },
    {
      email: "dr.dsouza@medcore.local",
      phone: "9999900017",
      name: "Dr. Rohan D'Souza",
      specialization: "General Physician",
      qualification: "MBBS, MD (General Medicine)",
    },
  ];

  for (const doc of doctorsData) {
    const user = await prisma.user.upsert({
      where: { email: doc.email },
      update: { tenantId },
      create: {
        email: doc.email,
        phone: doc.phone,
        name: doc.name,
        passwordHash: hashPassword("doctor123"),
        role: Role.DOCTOR,
        tenantId,
      },
    });

    const doctor = await prisma.doctor.upsert({
      where: { userId: user.id },
      update: { tenantId },
      create: {
        userId: user.id,
        specialization: doc.specialization,
        qualification: doc.qualification,
        tenantId,
      },
    });

    // Create default schedule: Mon-Fri, 10:00-13:00 and 16:00-19:00
    for (let day = 1; day <= 5; day++) {
      for (const shift of [
        { start: "10:00", end: "13:00" },
        { start: "16:00", end: "19:00" },
      ]) {
        await prisma.doctorSchedule.upsert({
          where: {
            doctorId_dayOfWeek_startTime: {
              doctorId: doctor.id,
              dayOfWeek: day,
              startTime: shift.start,
            },
          },
          update: {},
          create: {
            doctorId: doctor.id,
            dayOfWeek: day,
            startTime: shift.start,
            endTime: shift.end,
            slotDurationMinutes: 15,
          },
        });
      }
    }

    console.log("Created doctor:", doc.name);
  }

  // Create Reception
  const reception = await prisma.user.upsert({
    where: { email: "reception@medcore.local" },
    update: { tenantId },
    create: {
      email: "reception@medcore.local",
      phone: "9999900010",
      name: "Front Desk",
      passwordHash: hashPassword("reception123"),
      role: Role.RECEPTION,
      tenantId,
    },
  });
  console.log("Created reception:", reception.email);

  // Create Nurse
  const nurse = await prisma.user.upsert({
    where: { email: "nurse@medcore.local" },
    update: { tenantId },
    create: {
      email: "nurse@medcore.local",
      phone: "9999900020",
      name: "Nurse Anita",
      passwordHash: hashPassword("nurse123"),
      role: Role.NURSE,
      tenantId,
    },
  });
  console.log("Created nurse:", nurse.email);

  // Create LAB_TECH and PHARMACIST so all 7 roles in `e2e/helpers.ts CREDS`
  // exist after `db:seed`. Without these, the RBAC matrix spec
  // (e2e/rbac-matrix.spec.ts) hits 401 on every loginAs("LAB_TECH" /
  // "PHARMACIST") and cascades into apiLogin failures across both ALL_ROLES
  // smoke groups (/dashboard/profile and /dashboard/account).
  const labtech = await prisma.user.upsert({
    where: { email: "labtech@medcore.local" },
    update: { tenantId },
    create: {
      email: "labtech@medcore.local",
      phone: "9999900030",
      name: "Lab Tech Suresh",
      passwordHash: hashPassword("labtech123"),
      role: Role.LAB_TECH,
      tenantId,
    },
  });
  console.log("Created lab tech:", labtech.email);

  const pharmacist = await prisma.user.upsert({
    where: { email: "pharmacist@medcore.local" },
    update: { tenantId },
    create: {
      email: "pharmacist@medcore.local",
      phone: "9999900040",
      name: "Pharmacist Vikram",
      passwordHash: hashPassword("pharmacist123"),
      role: Role.PHARMACIST,
      tenantId,
    },
  });
  console.log("Created pharmacist:", pharmacist.email);

  // Create sample patient — uses patient1@medcore.local (NOT @example.com)
  // to match the @medcore.local convention used by every other seeded user
  // and (importantly) by the E2E helper at e2e/helpers.ts which expects
  // `patient1@medcore.local / patient123` for the PATIENT role.
  const patientUser = await prisma.user.upsert({
    where: { email: "patient1@medcore.local" },
    update: { tenantId },
    create: {
      email: "patient1@medcore.local",
      phone: "9876543210",
      name: "Rahul Kumar",
      passwordHash: hashPassword("patient123"),
      role: Role.PATIENT,
      tenantId,
    },
  });

  await prisma.patient.upsert({
    where: { userId: patientUser.id },
    update: { tenantId },
    create: {
      userId: patientUser.id,
      mrNumber: "MR000001",
      gender: Gender.MALE,
      age: 35,
      address: "123 Main Street, Mumbai",
      bloodGroup: "B+",
      tenantId,
    },
  });
  console.log("Created patient:", patientUser.name);

  // Initialize system config
  const configs = [
    { key: "hospital_name", value: "MedCore Hospital" },
    { key: "hospital_address", value: "Mumbai, Maharashtra, India" },
    { key: "hospital_phone", value: "+91 22 1234 5678" },
    { key: "consultation_fee", value: "500" },
    { key: "gst_percentage", value: "0" },
    // next_mr_number must stay above every MR allocated by the seed bundle.
    // seed.ts seeds MR000001 (Rahul Kumar). After the 2026-05-09 idempotency
    // pass, seed-realistic.ts now namespaces its 35 patients as
    // MRSEED000001..MRSEED000035 (so it can be re-run on every deploy
    // without colliding with the live MR counter). seed-pediatric-patients.ts
    // still seeds MR000036..MR000043 (8 patients) under the live counter.
    // The first free MR available to real-tenant `patients.ts` registration
    // is therefore 44 — Rahul Kumar (MR000001) + pediatric (8) = 9 used.
    // Bug #499 regression — must keep this aligned when pediatric mrSeqBase
    // changes; seed-realistic.ts no longer participates in the live counter.
    { key: "next_mr_number", value: "44" },
    { key: "next_invoice_number", value: "1" },
  ];

  for (const config of configs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: config,
    });
  }
  console.log("System config initialized");

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
