// Test-data factory functions. Each factory accepts an `overrides` object so
// individual tests can pin specific values while everything else is faker-generated.
//
// IMPORTANT: These factories write directly via Prisma and bypass route-level
// validation + business-rule enforcement. Tests that want to assert on
// route-level behaviour (e.g. auto-MRN generation, token sequence) should POST
// to the API endpoint instead.

import { faker } from "@faker-js/faker";
import bcrypt from "bcryptjs";
import { getPrisma } from "./setup";

let patientSeq = 0;
let doctorSeq = 0;
let bedSeq = 0;

export async function createUserFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  return prisma.user.create({
    data: {
      email:
        overrides.email ||
        `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@test.local`,
      name: overrides.name || faker.person.fullName(),
      phone: overrides.phone || faker.string.numeric(10),
      passwordHash: await bcrypt.hash(overrides.password || "password123", 4),
      role: overrides.role || "PATIENT",
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function createPatientFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  const user = await createUserFixture({
    role: "PATIENT",
    name: overrides.name,
    phone: overrides.phone,
    email: overrides.email,
  });
  patientSeq++;
  return prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber:
        overrides.mrNumber ||
        `MRTEST${String(Date.now()).slice(-6)}${patientSeq}`,
      gender:
        overrides.gender ||
        faker.helpers.arrayElement(["MALE", "FEMALE", "OTHER"]),
      dateOfBirth:
        overrides.dateOfBirth ||
        faker.date.birthdate({ min: 5, max: 85, mode: "age" }),
      age: overrides.age,
      bloodGroup: overrides.bloodGroup || "O+",
      address: overrides.address || faker.location.streetAddress(),
      emergencyContactName: overrides.emergencyContactName,
      emergencyContactPhone: overrides.emergencyContactPhone,
      insuranceProvider: overrides.insuranceProvider,
      insurancePolicyNumber: overrides.insurancePolicyNumber,
      noShowCount: overrides.noShowCount ?? 0,
      preferredLanguage: overrides.preferredLanguage,
    },
    include: { user: true },
  });
}

export async function createDoctorFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  const user =
    overrides.user ||
    (await createUserFixture({
      role: "DOCTOR",
      name: overrides.name || `Dr. ${faker.person.fullName()}`,
    }));
  doctorSeq++;
  return prisma.doctor.create({
    data: {
      userId: user.id,
      specialization: overrides.specialization || "General Medicine",
      qualification: overrides.qualification || "MBBS",
    },
    include: { user: true },
  });
}

/**
 * Create a doctor user AND a signed JWT for that doctor. Useful for tests that
 * need to hit endpoints guarded by authorize(Role.DOCTOR).
 */
export async function createDoctorWithToken(
  overrides: Partial<any> = {}
): Promise<{ doctor: any; token: string }> {
  const prisma = await getPrisma();
  const { getAuthToken } = await import("./setup");
  const bcrypt = await import("bcryptjs");
  const jwt = (await import("jsonwebtoken")).default;
  const email =
    overrides.email ||
    `doctor_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: overrides.name || `Dr. ${faker.person.fullName()}`,
      phone: overrides.phone || faker.string.numeric(10),
      passwordHash: await bcrypt.hash("password123", 4),
      role: "DOCTOR",
    },
  });
  const doctor = await prisma.doctor.create({
    data: {
      userId: user.id,
      specialization: overrides.specialization || "General Medicine",
      qualification: overrides.qualification || "MBBS",
    },
    include: { user: true },
  });
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: "DOCTOR" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  // suppress unused import lint for getAuthToken
  void getAuthToken;
  return { doctor, token };
}

export async function createAppointmentFixture(args: {
  patientId: string;
  doctorId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  const date = args.overrides?.date || new Date();
  // Pick next token for the doctor/date combo
  const last = await prisma.appointment.findFirst({
    where: { doctorId: args.doctorId, date },
    orderBy: { tokenNumber: "desc" },
  });
  const tokenNumber = args.overrides?.tokenNumber ?? (last?.tokenNumber ?? 0) + 1;
  return prisma.appointment.create({
    data: {
      patientId: args.patientId,
      doctorId: args.doctorId,
      date,
      tokenNumber,
      type: args.overrides?.type || "WALK_IN",
      status: args.overrides?.status || "BOOKED",
      slotStart: args.overrides?.slotStart,
      priority: args.overrides?.priority || "NORMAL",
      notes: args.overrides?.notes,
    },
  });
}

export async function createInvoiceFixture(args: {
  patientId: string;
  appointmentId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  return prisma.invoice.create({
    data: {
      patientId: args.patientId,
      appointmentId: args.appointmentId,
      invoiceNumber: `INVT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      subtotal: args.overrides?.subtotal ?? 1000,
      taxAmount: args.overrides?.taxAmount ?? 0,
      cgstAmount: args.overrides?.cgstAmount ?? 0,
      sgstAmount: args.overrides?.sgstAmount ?? 0,
      discountAmount: args.overrides?.discountAmount ?? 0,
      totalAmount: args.overrides?.totalAmount ?? 1000,
      paymentStatus: args.overrides?.paymentStatus || "PENDING",
      items: {
        create: [
          {
            description: "Consultation",
            category: "CONSULTATION",
            quantity: 1,
            unitPrice: 1000,
            amount: 1000,
          },
        ],
      },
    },
  });
}

// ─── IPD FACTORIES ──────────────────────────────────────

export async function createWardFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  return prisma.ward.create({
    data: {
      name:
        overrides.name ||
        `Ward-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type: overrides.type || "GENERAL",
      floor: overrides.floor || "1",
    },
  });
}

export async function createBedFixture(args: {
  wardId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  bedSeq++;
  return prisma.bed.create({
    data: {
      wardId: args.wardId,
      bedNumber:
        args.overrides?.bedNumber || `B${Date.now() % 100000}-${bedSeq}`,
      status: args.overrides?.status || "AVAILABLE",
      dailyRate: args.overrides?.dailyRate ?? 1000,
    },
  });
}

export async function createAdmissionFixture(args: {
  patientId: string;
  doctorId: string;
  bedId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  // Mark bed as occupied for realism
  await prisma.bed.update({
    where: { id: args.bedId },
    data: { status: "OCCUPIED" },
  });
  return prisma.admission.create({
    data: {
      admissionNumber:
        args.overrides?.admissionNumber ||
        `ADMT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      patientId: args.patientId,
      doctorId: args.doctorId,
      bedId: args.bedId,
      reason: args.overrides?.reason || "Chest pain",
      diagnosis: args.overrides?.diagnosis || "Unstable angina",
      status: args.overrides?.status || "ADMITTED",
      admissionType: args.overrides?.admissionType || "ELECTIVE",
    },
  });
}

// ─── PHARMACY / MEDICINE FACTORIES ──────────────────────

export async function createMedicineFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  return prisma.medicine.create({
    data: {
      name:
        overrides.name ||
        `Med-${faker.science.chemicalElement().name}-${Date.now() % 100000}`,
      genericName: overrides.genericName || "Generic",
      form: overrides.form || "tablet",
      strength: overrides.strength || "500mg",
      category: overrides.category || "analgesic",
      isNarcotic: overrides.isNarcotic ?? false,
      requiresRegister: overrides.requiresRegister ?? false,
      scheduleClass: overrides.scheduleClass,
    },
  });
}

export async function createInventoryFixture(args: {
  medicineId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  return prisma.inventoryItem.create({
    data: {
      medicineId: args.medicineId,
      batchNumber:
        args.overrides?.batchNumber ||
        `BATCH${Date.now()}${Math.floor(Math.random() * 1000)}`,
      quantity: args.overrides?.quantity ?? 100,
      unitCost: args.overrides?.unitCost ?? 10,
      sellingPrice: args.overrides?.sellingPrice ?? 15,
      expiryDate: args.overrides?.expiryDate || expiry,
      reorderLevel: args.overrides?.reorderLevel ?? 10,
      location: args.overrides?.location || "Shelf A1",
    },
  });
}

// ─── LAB FACTORIES ──────────────────────────────────────

export async function createLabTestFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  return prisma.labTest.create({
    data: {
      code:
        overrides.code ||
        `LT${Date.now() % 100000}${Math.floor(Math.random() * 100)}`,
      name: overrides.name || "Complete Blood Count",
      category: overrides.category || "Hematology",
      price: overrides.price ?? 300,
      sampleType: overrides.sampleType || "Blood",
      normalRange: overrides.normalRange || "13-17 g/dL",
      unit: overrides.unit || "g/dL",
      panicLow: overrides.panicLow,
      panicHigh: overrides.panicHigh,
      tatHours: overrides.tatHours ?? 24,
    },
  });
}

export async function createLabOrderFixture(args: {
  patientId: string;
  doctorId: string;
  testIds: string[];
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  return prisma.labOrder.create({
    data: {
      orderNumber:
        args.overrides?.orderNumber ||
        `LOT${Date.now()}${Math.floor(Math.random() * 1000)}`,
      patientId: args.patientId,
      doctorId: args.doctorId,
      status: args.overrides?.status || "ORDERED",
      stat: args.overrides?.stat ?? false,
      priority: args.overrides?.priority || "ROUTINE",
      items: {
        create: args.testIds.map((testId) => ({ testId })),
      },
    },
    include: { items: true },
  });
}

// ─── BLOOD BANK FACTORIES ───────────────────────────────

export async function createBloodDonorFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  return prisma.bloodDonor.create({
    data: {
      donorNumber:
        overrides.donorNumber ||
        `DON${Date.now()}${Math.floor(Math.random() * 1000)}`,
      name: overrides.name || faker.person.fullName(),
      phone: overrides.phone || faker.string.numeric(10),
      bloodGroup: overrides.bloodGroup || "O_POS",
      gender: overrides.gender || "MALE",
      weight: overrides.weight ?? 70,
      isEligible: overrides.isEligible ?? true,
    },
  });
}

export async function createBloodUnitFixture(overrides: Partial<any> = {}) {
  const prisma = await getPrisma();
  const expires = new Date();
  expires.setDate(expires.getDate() + 35);
  return prisma.bloodUnit.create({
    data: {
      unitNumber:
        overrides.unitNumber ||
        `BU${Date.now()}${Math.floor(Math.random() * 10000)}`,
      bloodGroup: overrides.bloodGroup || "O_POS",
      component: overrides.component || "WHOLE_BLOOD",
      volumeMl: overrides.volumeMl ?? 450,
      collectedAt: overrides.collectedAt || new Date(),
      expiresAt: overrides.expiresAt || expires,
      status: overrides.status || "AVAILABLE",
      storageLocation: overrides.storageLocation || "Fridge-A",
    },
  });
}

// ─── HR FACTORIES ───────────────────────────────────────

export async function createShiftFixture(args: {
  userId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  const date = args.overrides?.date || new Date();
  // normalize to date-only
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return prisma.staffShift.create({
    data: {
      userId: args.userId,
      date: d,
      type: args.overrides?.type || "MORNING",
      startTime: args.overrides?.startTime || "08:00",
      endTime: args.overrides?.endTime || "16:00",
      status: args.overrides?.status || "SCHEDULED",
    },
  });
}

// ─── EMERGENCY + SURGERY + PRESCRIPTION ─────────────────

export async function createOperatingTheaterFixture(
  overrides: Partial<any> = {}
) {
  const prisma = await getPrisma();
  return prisma.operatingTheater.create({
    data: {
      name:
        overrides.name ||
        `OT-${Date.now() % 100000}-${Math.random().toString(36).slice(2, 5)}`,
      floor: overrides.floor || "2",
      dailyRate: overrides.dailyRate ?? 5000,
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function createPrescriptionFixture(args: {
  patientId: string;
  doctorId: string;
  appointmentId: string;
  overrides?: Partial<any>;
}) {
  const prisma = await getPrisma();
  return prisma.prescription.create({
    data: {
      patientId: args.patientId,
      doctorId: args.doctorId,
      appointmentId: args.appointmentId,
      diagnosis: args.overrides?.diagnosis || "Acute pharyngitis",
      advice: args.overrides?.advice || "Rest and fluids",
      items: {
        create: [
          {
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
            instructions: "After food",
          },
        ],
      },
    },
    include: { items: true },
  });
}
