// Seed additional Acute Care module data (Apr 2026 enhancements)
// Run: npx tsx packages/db/src/seed-acute-care-enhancements.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}
function daysAhead(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

async function main() {
  console.log("=== Seeding Acute Care Enhancements ===\n");

  // ─── Prereqs ───────────────────────────────────────────
  const patients = await prisma.patient.findMany({
    take: 10,
    include: { user: { select: { name: true } } },
    orderBy: { mrNumber: "asc" },
  });
  const doctors = await prisma.doctor.findMany({
    take: 5,
    include: { user: { select: { name: true } } },
  });
  const nurses = await prisma.user.findMany({
    where: { role: "NURSE" },
    take: 3,
  });
  if (patients.length < 5 || doctors.length < 2) {
    console.log("Not enough base data — run seed-realistic / seed-ipd first.");
    return;
  }

  // ─── 1. Additional Active Admissions ──────────────────
  console.log("Seeding additional admissions...");
  const availableBeds = await prisma.bed.findMany({
    where: { status: "AVAILABLE" },
    take: 4,
    orderBy: { bedNumber: "asc" },
  });

  const admissionSpecs = [
    {
      reason: "Acute appendicitis — surgical admission",
      diagnosis: "Acute appendicitis",
      admissionType: "ELECTIVE" as const,
      referredByDoctor: "Dr. P. Venkatesh (External GP)",
      daysAgo: 3,
    },
    {
      reason: "Pneumonia with respiratory distress",
      diagnosis: "Community-acquired pneumonia, bilateral",
      admissionType: "EMERGENCY" as const,
      referredByDoctor: null,
      daysAgo: 5,
    },
    {
      reason: "Diabetic ketoacidosis",
      diagnosis: "DKA — Type 2 Diabetes",
      admissionType: "EMERGENCY" as const,
      referredByDoctor: null,
      daysAgo: 2,
    },
    {
      reason: "Elective cholecystectomy preparation",
      diagnosis: "Symptomatic cholelithiasis",
      admissionType: "ELECTIVE" as const,
      referredByDoctor: "Dr. Rao (Clinic)",
      daysAgo: 1,
    },
  ];

  const createdAdmissions: { id: string; bedId: string }[] = [];
  const countBefore = await prisma.admission.count();
  let nextSeq = countBefore + 1;

  for (let i = 0; i < admissionSpecs.length && i < availableBeds.length; i++) {
    const bed = availableBeds[i];
    const patient = patients[i % patients.length];
    const doc = doctors[i % doctors.length];
    const s = admissionSpecs[i];
    const admissionNumber = `IPD${String(nextSeq++).padStart(6, "0")}`;

    const adm = await prisma.admission.create({
      data: {
        admissionNumber,
        patientId: patient.id,
        doctorId: doc.id,
        bedId: bed.id,
        reason: s.reason,
        diagnosis: s.diagnosis,
        admissionType: s.admissionType,
        referredByDoctor: s.referredByDoctor,
        admittedAt: daysAgo(s.daysAgo),
        status: "ADMITTED",
      },
    });
    await prisma.bed.update({
      where: { id: bed.id },
      data: { status: "OCCUPIED" },
    });
    createdAdmissions.push({ id: adm.id, bedId: bed.id });

    // Nurse rounds (1 per day)
    if (nurses.length > 0) {
      for (let d = s.daysAgo; d >= 0; d--) {
        await prisma.nurseRound.create({
          data: {
            admissionId: adm.id,
            nurseId: nurses[d % nurses.length].id,
            notes:
              d === 0
                ? "Patient stable, afebrile, tolerating orals."
                : "Morning round — vitals within normal limits, oriented.",
            performedAt: daysAgo(d),
          },
        });
      }
    }

    // Medication order + scheduled administrations
    const order = await prisma.medicationOrder.create({
      data: {
        admissionId: adm.id,
        doctorId: doc.id,
        medicineName: i === 2 ? "Insulin (Regular)" : "Ceftriaxone 1g",
        dosage: i === 2 ? "10 units SC" : "1g IV",
        frequency: i === 2 ? "every 6 hours" : "BID",
        route: i === 2 ? "SC" : "IV",
        startDate: daysAgo(s.daysAgo),
        isActive: true,
      },
    });

    const interval = i === 2 ? 6 : 12;
    const doses: Date[] = [];
    let t = daysAgo(s.daysAgo).getTime();
    const endMs = Date.now();
    while (t <= endMs) {
      doses.push(new Date(t));
      t += interval * 60 * 60 * 1000;
    }
    for (let d = 0; d < doses.length; d++) {
      const isPast = doses[d].getTime() < Date.now() - 30 * 60 * 1000;
      await prisma.medicationAdministration.create({
        data: {
          medicationOrderId: order.id,
          scheduledAt: doses[d],
          status: isPast ? "ADMINISTERED" : "SCHEDULED",
          administeredAt: isPast ? doses[d] : null,
          administeredBy: isPast && nurses[0] ? nurses[0].id : null,
          notes: isPast ? "Given on time" : null,
        },
      });
    }

    // I/O records (last 24h)
    if (nurses.length > 0) {
      const ioSpecs: Array<{
        type:
          | "INTAKE_ORAL"
          | "INTAKE_IV"
          | "OUTPUT_URINE"
          | "OUTPUT_STOOL";
        amountMl: number;
        hoursBack: number;
        description?: string;
      }> = [
        { type: "INTAKE_IV", amountMl: 500, hoursBack: 20, description: "Normal saline" },
        { type: "INTAKE_ORAL", amountMl: 150, hoursBack: 18 },
        { type: "OUTPUT_URINE", amountMl: 300, hoursBack: 16 },
        { type: "INTAKE_IV", amountMl: 500, hoursBack: 12, description: "RL" },
        { type: "OUTPUT_URINE", amountMl: 400, hoursBack: 8 },
        { type: "INTAKE_ORAL", amountMl: 200, hoursBack: 4 },
        { type: "OUTPUT_URINE", amountMl: 250, hoursBack: 2 },
      ];
      for (const io of ioSpecs) {
        await prisma.ipdIntakeOutput.create({
          data: {
            admissionId: adm.id,
            type: io.type,
            amountMl: io.amountMl,
            description: io.description,
            recordedAt: hoursAgo(io.hoursBack),
            recordedBy: nurses[0].id,
          },
        });
      }
    }

    // Daily bill estimate
    const bedFull = await prisma.bed.findUnique({ where: { id: bed.id } });
    const bill = (bedFull?.dailyRate ?? 0) * Math.max(1, s.daysAgo);
    await prisma.admission.update({
      where: { id: adm.id },
      data: { totalBillAmount: bill },
    });
  }
  console.log(`  Created ${createdAdmissions.length} additional admissions`);

  // ─── 2. Surgeries with pre-op / complications ────────
  console.log("\nSeeding surgeries with enhancements...");
  const ots = await prisma.operatingTheater.findMany({ take: 2 });
  if (ots.length === 0) {
    await prisma.operatingTheater.create({
      data: { name: "Main OT", floor: "2", dailyRate: 5000 },
    });
    ots.push(...(await prisma.operatingTheater.findMany({ take: 2 })));
  }

  const surgerySpecs = [
    {
      procedure: "Laparoscopic Cholecystectomy",
      diagnosis: "Symptomatic cholelithiasis",
      daysAgo: 4,
      duration: 90,
      complications: null as string | null,
      complicationSeverity: null as string | null,
      bloodLoss: 80,
    },
    {
      procedure: "Open Appendicectomy",
      diagnosis: "Perforated appendicitis",
      daysAgo: 6,
      duration: 75,
      complications: "Minor intra-op bleeding; resolved with cautery",
      complicationSeverity: "MILD",
      bloodLoss: 220,
    },
    {
      procedure: "Inguinal Hernia Repair (Mesh)",
      diagnosis: "Right-sided inguinal hernia",
      daysAgo: 10,
      duration: 60,
      complications: null,
      complicationSeverity: null,
      bloodLoss: 50,
    },
  ];

  const surgeryCountBefore = await prisma.surgery.count();
  let srgSeq = surgeryCountBefore + 1;

  for (let i = 0; i < surgerySpecs.length; i++) {
    const s = surgerySpecs[i];
    const patient = patients[i % patients.length];
    const surgeon = doctors[i % doctors.length];
    const ot = ots[i % ots.length];
    const caseNumber = `SRG${String(srgSeq++).padStart(6, "0")}`;
    const scheduledAt = daysAgo(s.daysAgo);
    const startAt = new Date(scheduledAt.getTime() + 30 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + s.duration * 60 * 1000);

    await prisma.surgery.create({
      data: {
        caseNumber,
        patientId: patient.id,
        surgeonId: surgeon.id,
        otId: ot.id,
        procedure: s.procedure,
        scheduledAt,
        durationMin: s.duration,
        actualStartAt: startAt,
        actualEndAt: endAt,
        status: "COMPLETED",
        diagnosis: s.diagnosis,
        preOpNotes: "Consent obtained. NPO since midnight. Antibiotics per protocol.",
        postOpNotes:
          s.complications ?? "Uneventful procedure. Patient shifted to recovery.",
        anaesthesiologist: "Dr. Kavitha R",
        assistants: "Dr. Suresh (Asst), Scrub: Priya, Circulating: Meera",
        consentSigned: true,
        consentSignedAt: new Date(scheduledAt.getTime() - 2 * 60 * 60 * 1000),
        npoSince: new Date(scheduledAt.getTime() - 10 * 60 * 60 * 1000),
        allergiesVerified: true,
        antibioticsGiven: true,
        antibioticsAt: new Date(scheduledAt.getTime() - 60 * 60 * 1000),
        siteMarked: true,
        bloodReserved: i === 1,
        anesthesiaStartAt: new Date(startAt.getTime() - 10 * 60 * 1000),
        anesthesiaEndAt: new Date(endAt.getTime() + 15 * 60 * 1000),
        incisionAt: startAt,
        closureAt: new Date(endAt.getTime() - 10 * 60 * 1000),
        complications: s.complications,
        complicationSeverity: s.complicationSeverity,
        bloodLossMl: s.bloodLoss,
        cost: 45000 + i * 5000,
      },
    });
  }
  console.log(`  Created ${surgerySpecs.length} surgery cases`);

  // ─── 3. ER Cases at various triage levels ─────────────
  console.log("\nSeeding ER cases...");
  const erCountBefore = await prisma.emergencyCase.count();
  let erSeq = erCountBefore + 1;

  const erSpecs: Array<{
    chiefComplaint: string;
    triage:
      | "RESUSCITATION"
      | "EMERGENT"
      | "URGENT"
      | "LESS_URGENT"
      | "NON_URGENT";
    closed: boolean;
    isMLC: boolean;
    hoursAgo: number;
    arrivalMode: string;
    patientIdx: number | null; // null = unknown
    mewsScore?: number;
  }> = [
    {
      chiefComplaint: "Road traffic accident — head injury, loss of consciousness",
      triage: "RESUSCITATION",
      closed: false,
      isMLC: true,
      hoursAgo: 2,
      arrivalMode: "AMBULANCE",
      patientIdx: null,
      mewsScore: 8,
    },
    {
      chiefComplaint: "Severe chest pain radiating to left arm",
      triage: "EMERGENT",
      closed: false,
      isMLC: false,
      hoursAgo: 1,
      arrivalMode: "AMBULANCE",
      patientIdx: 0,
      mewsScore: 5,
    },
    {
      chiefComplaint: "High fever with rigors",
      triage: "URGENT",
      closed: false,
      isMLC: false,
      hoursAgo: 0.5,
      arrivalMode: "WALK_IN",
      patientIdx: 1,
    },
    {
      chiefComplaint: "Laceration over forehead — minor",
      triage: "LESS_URGENT",
      closed: true,
      isMLC: false,
      hoursAgo: 12,
      arrivalMode: "WALK_IN",
      patientIdx: 2,
    },
    {
      chiefComplaint: "Stab wound — left forearm",
      triage: "URGENT",
      closed: true,
      isMLC: true,
      hoursAgo: 18,
      arrivalMode: "POLICE",
      patientIdx: 3,
    },
    {
      chiefComplaint: "Mild ankle sprain after fall",
      triage: "NON_URGENT",
      closed: true,
      isMLC: false,
      hoursAgo: 24,
      arrivalMode: "WALK_IN",
      patientIdx: 4,
    },
    {
      chiefComplaint: "Shortness of breath, wheezing",
      triage: "URGENT",
      closed: false,
      isMLC: false,
      hoursAgo: 1.5,
      arrivalMode: "WALK_IN",
      patientIdx: 5 % patients.length,
    },
  ];

  for (const e of erSpecs) {
    const caseNumber = `ER${String(erSeq++).padStart(6, "0")}`;
    const arrivedAt = hoursAgo(e.hoursAgo);
    const patient =
      e.patientIdx != null ? patients[e.patientIdx % patients.length] : null;
    const seenAt = e.closed ? new Date(arrivedAt.getTime() + 20 * 60 * 1000) : null;

    await prisma.emergencyCase.create({
      data: {
        caseNumber,
        patientId: patient?.id ?? null,
        unknownName: patient ? null : "Unknown (John Doe)",
        unknownAge: patient ? null : 35,
        unknownGender: patient ? null : "MALE",
        arrivedAt,
        arrivalMode: e.arrivalMode,
        triageLevel: e.triage,
        triagedAt: new Date(arrivedAt.getTime() + 8 * 60 * 1000),
        chiefComplaint: e.chiefComplaint,
        mewsScore: e.mewsScore,
        attendingDoctorId: e.closed ? doctors[0].id : null,
        seenAt,
        status: e.closed ? "DISCHARGED" : "TRIAGED",
        disposition: e.closed ? "DISCHARGED" : null,
        closedAt: e.closed ? new Date(arrivedAt.getTime() + 2 * 60 * 60 * 1000) : null,
        outcomeNotes: e.closed
          ? "Stabilized and discharged with advice for follow-up"
          : null,
        isMLC: e.isMLC,
        mlcNumber: e.isMLC ? `MLC-${caseNumber}` : null,
        mlcPoliceStation: e.isMLC ? "Cyberabad PS" : null,
        mlcOfficerName: e.isMLC ? "SI Ramesh Kumar" : null,
        treatmentOrders: e.closed
          ? JSON.stringify([
              {
                type: "MEDICATION",
                name: "Paracetamol",
                dose: "500mg PO",
                givenAt: new Date(arrivedAt.getTime() + 30 * 60 * 1000),
              },
            ])
          : null,
      },
    });
  }
  console.log(`  Created ${erSpecs.length} ER cases`);

  // ─── 4. Past Telemedicine Sessions with ratings ─────
  console.log("\nSeeding telemedicine sessions...");
  const telCountBefore = await prisma.telemedicineSession.count();
  let telSeq = telCountBefore + 1;

  const telSpecs = [
    {
      patientIdx: 0,
      doctorIdx: 0,
      complaint: "Follow-up consultation for hypertension",
      daysAgo: 2,
      duration: 18,
      rating: 5,
      notes: "BP trending well. Continue ramipril 5mg OD. Review in 4 weeks.",
      techIssues: null,
    },
    {
      patientIdx: 1,
      doctorIdx: 0,
      complaint: "Skin rash review",
      daysAgo: 4,
      duration: 12,
      rating: 4,
      notes: "Contact dermatitis. Rx: Topical hydrocortisone 1% BID x 5 days.",
      techIssues: "AUDIO_DROP_BRIEF",
    },
    {
      patientIdx: 2,
      doctorIdx: 1,
      complaint: "Pediatric fever and cough",
      daysAgo: 7,
      duration: 22,
      rating: 5,
      notes: "Likely viral URI. Supportive care; Paracetamol PRN; hydration.",
      techIssues: null,
    },
    {
      patientIdx: 3,
      doctorIdx: 1,
      complaint: "Diabetes medication review",
      daysAgo: 10,
      duration: 25,
      rating: 4,
      notes: "HbA1c 7.2% — adjust metformin to 1g BID. Repeat HbA1c in 3 months.",
      techIssues: null,
    },
  ];

  for (const t of telSpecs) {
    const sessionNumber = `TEL${String(telSeq++).padStart(6, "0")}`;
    const scheduled = daysAgo(t.daysAgo);
    const started = new Date(scheduled.getTime() + 2 * 60 * 1000);
    const ended = new Date(started.getTime() + t.duration * 60 * 1000);
    await prisma.telemedicineSession.create({
      data: {
        sessionNumber,
        patientId: patients[t.patientIdx % patients.length].id,
        doctorId: doctors[t.doctorIdx % doctors.length].id,
        scheduledAt: scheduled,
        startedAt: started,
        endedAt: ended,
        durationMin: t.duration,
        meetingId: `mtg${telSeq}`,
        meetingUrl: `https://meet.jit.si/medcore-seed-${telSeq}`,
        status: "COMPLETED",
        chiefComplaint: t.complaint,
        doctorNotes: t.notes,
        patientRating: t.rating,
        fee: 500,
        technicalIssues: t.techIssues,
        recordingConsent: false,
        patientJoinedAt: new Date(scheduled.getTime() - 5 * 60 * 1000),
      },
    });
  }
  console.log(`  Created ${telSpecs.length} telemedicine sessions`);

  // ─── 5. ANC Enhancements — visits + USG ───────────────
  console.log("\nSeeding ANC enhancements...");
  const ancCases = await prisma.antenatalCase.findMany({ take: 3 });
  for (const c of ancCases) {
    const usgCount = await prisma.ultrasoundRecord.count({
      where: { ancCaseId: c.id },
    });
    if (usgCount === 0) {
      await prisma.ultrasoundRecord.create({
        data: {
          ancCaseId: c.id,
          scanDate: daysAgo(30),
          gestationalWeeks: 12,
          efwGrams: 60,
          afi: 14,
          placentaPosition: "Anterior, upper segment",
          fetalHeartRate: 150,
          presentation: "Not defined (early)",
          findings: "Single live intrauterine fetus. CRL corresponds to 12 weeks.",
          impression: "Normal first trimester scan",
          recordedBy: doctors[0].id,
        },
      });
      await prisma.ultrasoundRecord.create({
        data: {
          ancCaseId: c.id,
          scanDate: daysAgo(7),
          gestationalWeeks: 20,
          efwGrams: 320,
          afi: 16,
          placentaPosition: "Fundal",
          fetalHeartRate: 142,
          presentation: "Cephalic",
          findings: "Anomaly scan — no gross anomalies detected.",
          impression: "Normal anomaly scan at 20 weeks",
          recordedBy: doctors[0].id,
        },
      });
    }

    // Extra visits
    const visitCount = await prisma.ancVisit.count({ where: { ancCaseId: c.id } });
    if (visitCount < 3) {
      await prisma.ancVisit.create({
        data: {
          ancCaseId: c.id,
          type: "ROUTINE",
          visitDate: daysAgo(28),
          weeksOfGestation: 16,
          weight: 62.5,
          bloodPressure: "118/76",
          fundalHeight: "16 cm",
          fetalHeartRate: 148,
          hemoglobin: 11.4,
          urineProtein: "Nil",
          urineSugar: "Nil",
          notes: "All vitals stable. Iron & folic acid started.",
          nextVisitDate: daysAhead(28),
        },
      });
    }
  }
  console.log(`  Enhanced ${ancCases.length} ANC cases`);

  // ─── 6. Pediatric Growth & Immunizations ────────────
  console.log("\nSeeding pediatric growth records...");
  const peds = await prisma.patient.findMany({
    where: { age: { lte: 12 } },
    take: 3,
  });
  if (peds.length === 0) {
    // fallback — use first patient regardless
    peds.push(...patients.slice(0, 2));
  }

  for (const p of peds) {
    const recCount = await prisma.growthRecord.count({
      where: { patientId: p.id },
    });
    if (recCount >= 3) continue;

    const ages = [3, 6, 9, 12, 18];
    for (const ageM of ages) {
      const w = 4 + ageM * 0.4;
      const h = 55 + ageM * 1.8;
      const hM = h / 100;
      const bmi = Math.round((w / (hM * hM)) * 10) / 10;
      await prisma.growthRecord.create({
        data: {
          patientId: p.id,
          ageMonths: ageM,
          weightKg: Math.round(w * 10) / 10,
          heightCm: Math.round(h * 10) / 10,
          headCircumference: 35 + ageM * 0.4,
          bmi,
          weightPercentile: 50,
          heightPercentile: 55,
          milestoneNotes:
            ageM >= 12
              ? "Stands with support; says mama/dada"
              : ageM >= 6
                ? "Sits with support; babbles"
                : "Smiles socially",
          developmentalNotes: "Age-appropriate gross and fine motor development",
          recordedBy: doctors[0].id,
        },
      });
    }

    // Immunization records — first 3 compliant, rest missing
    const vaccines = [
      { vaccine: "BCG", monthOffset: 0 },
      { vaccine: "OPV-0", monthOffset: 0 },
      { vaccine: "Hepatitis B-0", monthOffset: 0 },
      { vaccine: "Pentavalent-1", monthOffset: 1.5 },
      { vaccine: "OPV-1", monthOffset: 1.5 },
    ];
    for (const v of vaccines) {
      const existing = await prisma.immunization.findFirst({
        where: { patientId: p.id, vaccine: v.vaccine },
      });
      if (!existing && p.dateOfBirth) {
        await prisma.immunization.create({
          data: {
            patientId: p.id,
            vaccine: v.vaccine,
            doseNumber: 1,
            dateGiven: new Date(
              new Date(p.dateOfBirth).getTime() +
                v.monthOffset * 30.4375 * 24 * 60 * 60 * 1000
            ),
            administeredBy: "MedCore Vaccination Clinic",
          },
        });
      }
    }
  }
  console.log(`  Enhanced ${peds.length} pediatric patients`);

  console.log("\n=== Acute Care enhancements seeded ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
