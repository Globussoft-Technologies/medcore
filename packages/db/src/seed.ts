import { PrismaClient, Role, Gender } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

async function main() {
  console.log("Seeding database...");

  // Create Admin
  const admin = await prisma.user.upsert({
    where: { email: "admin@medcore.local" },
    update: {},
    create: {
      email: "admin@medcore.local",
      phone: "9999900000",
      name: "System Admin",
      passwordHash: hashPassword("admin123"),
      role: Role.ADMIN,
    },
  });
  console.log("Created admin:", admin.email);

  // Create Doctors
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
  ];

  for (const doc of doctorsData) {
    const user = await prisma.user.upsert({
      where: { email: doc.email },
      update: {},
      create: {
        email: doc.email,
        phone: doc.phone,
        name: doc.name,
        passwordHash: hashPassword("doctor123"),
        role: Role.DOCTOR,
      },
    });

    const doctor = await prisma.doctor.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        specialization: doc.specialization,
        qualification: doc.qualification,
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
    update: {},
    create: {
      email: "reception@medcore.local",
      phone: "9999900010",
      name: "Front Desk",
      passwordHash: hashPassword("reception123"),
      role: Role.RECEPTION,
    },
  });
  console.log("Created reception:", reception.email);

  // Create Nurse
  const nurse = await prisma.user.upsert({
    where: { email: "nurse@medcore.local" },
    update: {},
    create: {
      email: "nurse@medcore.local",
      phone: "9999900020",
      name: "Nurse Anita",
      passwordHash: hashPassword("nurse123"),
      role: Role.NURSE,
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
    update: {},
    create: {
      email: "labtech@medcore.local",
      phone: "9999900030",
      name: "Lab Tech Suresh",
      passwordHash: hashPassword("labtech123"),
      role: Role.LAB_TECH,
    },
  });
  console.log("Created lab tech:", labtech.email);

  const pharmacist = await prisma.user.upsert({
    where: { email: "pharmacist@medcore.local" },
    update: {},
    create: {
      email: "pharmacist@medcore.local",
      phone: "9999900040",
      name: "Pharmacist Vikram",
      passwordHash: hashPassword("pharmacist123"),
      role: Role.PHARMACIST,
    },
  });
  console.log("Created pharmacist:", pharmacist.email);

  // Create sample patient — uses patient1@medcore.local (NOT @example.com)
  // to match the @medcore.local convention used by every other seeded user
  // and (importantly) by the E2E helper at e2e/helpers.ts which expects
  // `patient1@medcore.local / patient123` for the PATIENT role.
  const patientUser = await prisma.user.upsert({
    where: { email: "patient1@medcore.local" },
    update: {},
    create: {
      email: "patient1@medcore.local",
      phone: "9876543210",
      name: "Rahul Kumar",
      passwordHash: hashPassword("patient123"),
      role: Role.PATIENT,
    },
  });

  await prisma.patient.upsert({
    where: { userId: patientUser.id },
    update: {},
    create: {
      userId: patientUser.id,
      mrNumber: "MR000001",
      gender: Gender.MALE,
      age: 35,
      address: "123 Main Street, Mumbai",
      bloodGroup: "B+",
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
    { key: "next_mr_number", value: "2" },
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
