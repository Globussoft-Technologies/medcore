import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Seeding Clinical (Referrals, OTs, Surgeries) ===\n");

  // ─── 1. OPERATING THEATERS ────────────────────────────
  console.log("Creating operating theaters...");

  const otSpecs = [
    {
      name: "OT-1",
      floor: "3",
      equipment: "C-arm, Anaesthesia machine, Ventilator, Laparoscopy tower",
      dailyRate: 15000,
    },
    {
      name: "OT-2",
      floor: "3",
      equipment: "Anaesthesia machine, Ventilator, Cautery unit",
      dailyRate: 15000,
    },
    {
      name: "Minor OT",
      floor: "2",
      equipment: "Basic surgical kit, local anaesthesia setup",
      dailyRate: 5000,
    },
  ];

  const ots: Record<string, string> = {};
  for (const spec of otSpecs) {
    const ot = await prisma.operatingTheater.upsert({
      where: { name: spec.name },
      update: {
        floor: spec.floor,
        equipment: spec.equipment,
        dailyRate: spec.dailyRate,
        isActive: true,
      },
      create: spec,
    });
    ots[spec.name] = ot.id;
    console.log(`  Created OT: ${spec.name} @ ₹${spec.dailyRate}/day`);
  }

  // ─── 2. FETCH EXISTING PATIENTS & DOCTORS ────────────
  const patients = await prisma.patient.findMany({ take: 10 });
  const doctors = await prisma.doctor.findMany({ take: 5 });

  if (patients.length < 2 || doctors.length < 2) {
    console.log(
      "\n  Skipping sample referrals & surgeries — not enough patients/doctors. Run seed-realistic first."
    );
    await prisma.$disconnect();
    return;
  }

  // ─── 3. SAMPLE REFERRALS ─────────────────────────────
  console.log("\nCreating sample referrals...");

  // Compute next referral number
  const lastRef = await prisma.referral.findFirst({
    orderBy: { referralNumber: "desc" },
    select: { referralNumber: true },
  });
  let refSeq = 1;
  if (lastRef?.referralNumber) {
    const m = lastRef.referralNumber.match(/(\d+)$/);
    if (m) refSeq = parseInt(m[1], 10) + 1;
  }

  const refSamples = [
    {
      patientId: patients[0].id,
      fromDoctorId: doctors[0].id,
      toDoctorId: doctors[1].id,
      specialty: doctors[1].specialization,
      reason:
        "Patient shows signs of cardiac arrhythmia on ECG. Requesting specialist review.",
      notes: "ECG and recent vitals attached. Patient on Amlodipine 5mg.",
      status: "PENDING" as const,
    },
    {
      patientId: patients[1].id,
      fromDoctorId: doctors[0].id,
      externalProvider: "Jaslok Hospital - Orthopedic Dept",
      externalContact: "022-66573000",
      specialty: "Orthopedics",
      reason:
        "Suspected meniscus tear on MRI. Recommending arthroscopic evaluation.",
      notes: "MRI report dated last week. Conservative therapy not effective.",
      status: "ACCEPTED" as const,
    },
  ];

  for (const r of refSamples) {
    const referralNumber = `REF${String(refSeq).padStart(6, "0")}`;
    refSeq++;
    const exists = await prisma.referral.findUnique({
      where: { referralNumber },
    });
    if (exists) continue;
    await prisma.referral.create({
      data: {
        referralNumber,
        ...r,
        referredAt: new Date(),
        respondedAt: r.status !== "PENDING" ? new Date() : null,
      },
    });
    console.log(`  Created referral: ${referralNumber} (${r.status})`);
  }

  // ─── 4. SAMPLE SURGERIES ─────────────────────────────
  console.log("\nCreating sample surgeries...");

  const lastSrg = await prisma.surgery.findFirst({
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });
  let srgSeq = 1;
  if (lastSrg?.caseNumber) {
    const m = lastSrg.caseNumber.match(/(\d+)$/);
    if (m) srgSeq = parseInt(m[1], 10) + 1;
  }

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);

  const dayAfter = new Date(now);
  dayAfter.setDate(dayAfter.getDate() + 2);
  dayAfter.setHours(14, 30, 0, 0);

  const surgerySamples = [
    {
      patientId: patients[2]?.id || patients[0].id,
      surgeonId: doctors[1]?.id || doctors[0].id,
      otId: ots["OT-1"],
      procedure: "Laparoscopic Cholecystectomy",
      scheduledAt: tomorrow,
      durationMin: 90,
      anaesthesiologist: "Dr. S. Menon",
      assistants: "Dr. R. Iyer, Nurse P. Fernandes",
      preOpNotes:
        "NPO after midnight. IV line established. Pre-op antibiotics: Ceftriaxone 1g.",
      diagnosis: "Symptomatic cholelithiasis",
      cost: 45000,
      status: "SCHEDULED" as const,
    },
    {
      patientId: patients[3]?.id || patients[1].id,
      surgeonId: doctors[2]?.id || doctors[0].id,
      otId: ots["Minor OT"],
      procedure: "Incision & drainage of abscess (right forearm)",
      scheduledAt: dayAfter,
      durationMin: 30,
      anaesthesiologist: "Local anaesthesia (Lignocaine 2%)",
      preOpNotes: "Consent obtained. Area marked.",
      diagnosis: "Right forearm abscess",
      cost: 6500,
      status: "SCHEDULED" as const,
    },
  ];

  for (const s of surgerySamples) {
    const caseNumber = `SRG${String(srgSeq).padStart(6, "0")}`;
    srgSeq++;
    const exists = await prisma.surgery.findUnique({ where: { caseNumber } });
    if (exists) continue;
    await prisma.surgery.create({
      data: { caseNumber, ...s },
    });
    console.log(`  Created surgery: ${caseNumber} — ${s.procedure}`);
  }

  console.log("\n=== Clinical seed complete ===");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
