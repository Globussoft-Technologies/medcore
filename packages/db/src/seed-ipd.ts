import { PrismaClient, WardType, BedStatus, AdmissionStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Seeding IPD data ===\n");

  // ─── 1. WARDS ─────────────────────────────────────────
  console.log("Creating wards...");

  const generalWard = await prisma.ward.upsert({
    where: { name: "General Ward A" },
    update: {},
    create: {
      name: "General Ward A",
      type: "GENERAL" as WardType,
      floor: "1",
      description: "General male/female ward — shared occupancy",
    },
  });

  const privateWard = await prisma.ward.upsert({
    where: { name: "Private Rooms" },
    update: {},
    create: {
      name: "Private Rooms",
      type: "PRIVATE" as WardType,
      floor: "2",
      description: "Single-occupancy private rooms with attached bathroom",
    },
  });

  const icuWard = await prisma.ward.upsert({
    where: { name: "ICU" },
    update: {},
    create: {
      name: "ICU",
      type: "ICU" as WardType,
      floor: "3",
      description: "Intensive Care Unit — 24x7 nurse monitoring",
    },
  });

  console.log(`  Created 3 wards`);

  // ─── 2. BEDS ──────────────────────────────────────────
  console.log("\nCreating beds...");

  const bedSpecs: Array<{ wardId: string; bedNumber: string; dailyRate: number }> = [];
  for (let i = 1; i <= 10; i++) {
    bedSpecs.push({ wardId: generalWard.id, bedNumber: `GA-${100 + i}`, dailyRate: 1500 });
  }
  for (let i = 1; i <= 5; i++) {
    bedSpecs.push({ wardId: privateWard.id, bedNumber: `PR-${200 + i}`, dailyRate: 3500 });
  }
  for (let i = 1; i <= 4; i++) {
    bedSpecs.push({
      wardId: icuWard.id,
      bedNumber: `ICU-${String(i).padStart(2, "0")}`,
      dailyRate: 6000,
    });
  }

  for (const spec of bedSpecs) {
    await prisma.bed.upsert({
      where: { wardId_bedNumber: { wardId: spec.wardId, bedNumber: spec.bedNumber } },
      update: { dailyRate: spec.dailyRate },
      create: {
        wardId: spec.wardId,
        bedNumber: spec.bedNumber,
        dailyRate: spec.dailyRate,
        status: "AVAILABLE" as BedStatus,
      },
    });
  }
  console.log(`  Created ${bedSpecs.length} beds (10 General, 5 Private, 4 ICU)`);

  // ─── 3. SAMPLE ADMISSIONS ─────────────────────────────
  console.log("\nCreating sample admissions...");

  const patients = await prisma.patient.findMany({
    take: 2,
    include: { user: { select: { name: true } } },
    orderBy: { mrNumber: "asc" },
  });
  const doctors = await prisma.doctor.findMany({
    take: 2,
    include: { user: { select: { name: true } } },
    orderBy: { id: "asc" },
  });

  if (patients.length < 2 || doctors.length < 1) {
    console.log("  Not enough patients/doctors found. Run `seed-realistic` first.");
  } else {
    // pick first available GA bed and first available ICU bed
    const gaBed = await prisma.bed.findFirst({
      where: { wardId: generalWard.id, status: "AVAILABLE" as BedStatus },
      orderBy: { bedNumber: "asc" },
    });
    const icuBed = await prisma.bed.findFirst({
      where: { wardId: icuWard.id, status: "AVAILABLE" as BedStatus },
      orderBy: { bedNumber: "asc" },
    });

    // count existing admissions to continue numbering
    const existingCount = await prisma.admission.count();
    let seq = existingCount + 1;

    const admissions: Array<{
      patientId: string;
      doctorId: string;
      bedId: string;
      reason: string;
      diagnosis: string;
      daysAgo: number;
    }> = [];

    if (gaBed) {
      admissions.push({
        patientId: patients[0].id,
        doctorId: doctors[0].id,
        bedId: gaBed.id,
        reason: "Severe dehydration and acute gastroenteritis",
        diagnosis: "Acute Gastroenteritis with moderate dehydration",
        daysAgo: 2,
      });
    }
    if (icuBed && patients[1] && (doctors[1] || doctors[0])) {
      admissions.push({
        patientId: patients[1].id,
        doctorId: (doctors[1] ?? doctors[0]).id,
        bedId: icuBed.id,
        reason: "Chest pain with suspected acute coronary syndrome",
        diagnosis: "Acute Coronary Syndrome — under observation",
        daysAgo: 1,
      });
    }

    for (const adm of admissions) {
      // Issue #37 — patient-side idempotency guard. The earlier "skip if bed
      // not AVAILABLE" check is a bed-side guard, not a patient-side guard:
      // on the second seed run, the original bed (e.g. GA-101) is now
      // OCCUPIED so we'd pick the next free bed (GA-102) and create a SECOND
      // active admission for the same patient — exactly the dual-bed bug
      // reported on demo (Rahul Sharma in GA-101 + GA-102, Priya Mehta in
      // ICU-01 + GA-103). The DB-level partial unique index
      // `one_active_admission_per_patient` (migration 20260424000001) would
      // now reject this with P2002 and crash the seed; this guard makes the
      // seed idempotent BEFORE the DB rejects, so re-runs just no-op.
      const existingActive = await prisma.admission.findFirst({
        where: { patientId: adm.patientId, status: "ADMITTED" as AdmissionStatus },
        select: { id: true, admissionNumber: true, bedId: true },
      });
      if (existingActive) {
        console.log(
          `  Skipping admission — patient ${adm.patientId.slice(0, 8)} already has active admission ${existingActive.admissionNumber}`
        );
        continue;
      }

      // skip if bed is already occupied (idempotent-ish)
      const bed = await prisma.bed.findUnique({ where: { id: adm.bedId } });
      if (!bed || bed.status !== "AVAILABLE") {
        console.log(`  Skipping admission — bed ${adm.bedId} not available`);
        continue;
      }

      const admissionNumber = `IPD${String(seq).padStart(6, "0")}`;
      seq++;
      const admittedAt = new Date();
      admittedAt.setDate(admittedAt.getDate() - adm.daysAgo);

      await prisma.$transaction(async (tx) => {
        const created = await tx.admission.create({
          data: {
            admissionNumber,
            patientId: adm.patientId,
            doctorId: adm.doctorId,
            bedId: adm.bedId,
            reason: adm.reason,
            diagnosis: adm.diagnosis,
            status: "ADMITTED" as AdmissionStatus,
            admittedAt,
          },
        });
        await tx.bed.update({
          where: { id: adm.bedId },
          data: { status: "OCCUPIED" as BedStatus },
        });

        // Add a sample vitals record
        await tx.ipdVitals.create({
          data: {
            admissionId: created.id,
            recordedBy:
              (await tx.user.findFirst({ where: { role: "NURSE" } }))?.id ??
              doctors[0].userId,
            bloodPressureSystolic: 128,
            bloodPressureDiastolic: 82,
            temperature: 99.1,
            pulseRate: 88,
            respiratoryRate: 18,
            spO2: 97,
            painScore: 3,
            notes: "Patient stable, on IV fluids",
          },
        });
      });

      console.log(`  Admitted ${admissionNumber} — patient=${adm.patientId.slice(0, 8)} bed=${adm.bedId.slice(0, 8)}`);
    }
  }

  console.log("\n=== IPD seed complete! ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
