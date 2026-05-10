/**
 * Phase 4 engagement seed — patient feedback, complaints, internal chat,
 * and visitor passes.
 *
 * Idempotency contract (2026-05-11): safe to re-run on a populated demo
 * without creating duplicates AND without wiping user-created rows. The
 * pre-2026-05-11 version called `deleteMany({})` (unscoped) on
 * PatientFeedback, Complaint, ChatRoom/ChatParticipant/ChatMessage, and
 * Visitor — which would have nuked every real-tenant row of those tables
 * on every deploy. All four `deleteMany` calls have been removed and
 * replaced with stable-id / deterministic-anchor guards.
 *
 *   - PatientFeedback (no natural unique): per-iteration anchor is the
 *     triple `(patientId, category, submittedAt)`. Each of the 20 seed
 *     entries gets a deterministic `submittedAt` derived from its index
 *     (no longer `daysAgo(randomInt(0, 90))`) — see DAYS_AGO_BY_IDX
 *     below. findFirst on that triple skip-or-creates.
 *   - Complaint: stable seed-namespaced ticketNumber `CMP-PH4-SEED-<NNNN>`
 *     (1..5) — distinct from both the live counter (`CMP000001..`) and
 *     from `seed-complaints-data.ts`'s `CMP-SEED-<NNNN>`. Skip-or-create
 *     via `findUnique({ where: { ticketNumber } })`.
 *   - ChatRoom (group): natural anchor is `(name, isGroup, createdBy)`
 *     for the two named group rooms ("Doctors Channel", "Nursing Team").
 *     For the 1-on-1 direct room (no name), anchor is membership-by-both-
 *     userIds via findFirst on the participants relation.
 *   - ChatParticipant: `upsert({ where: { roomId_userId } })` — leverages
 *     the existing @@unique([roomId, userId]).
 *   - ChatMessage: seed-tag prefix `[PH4-ENG-CHAT-SEED-<roomKey>-<NNNN>]`
 *     embedded at the start of the content column. Re-runs do
 *     findFirst({ where: { roomId, content: { startsWith } } }) and skip
 *     if present (same pattern as seed-chat-conversations.ts wave 2).
 *   - Visitor: stable seed-namespaced passNumber `VIS-PH4-SEED-<NNNN>`
 *     (1..8) — distinct from both the live passNumber counter and from
 *     `seed-visitors-history.ts`'s `VIS-HIST-SEED-<NNNN>`. Skip-or-create
 *     via `findUnique({ where: { passNumber } })`.
 *
 * Math.random() is replaced by a deterministic mulberry32 PRNG so partial-
 * run recovery stays byte-identical.
 *
 * Wired into `scripts/deploy.sh` by the orchestrator (separate commit).
 * Failures are non-fatal (matches the policy of every other deploy-time
 * fixture seed).
 */
import {
  PrismaClient,
  FeedbackCategory,
  ComplaintStatus,
  MessageType,
  VisitorPurpose,
} from "@prisma/client";

const prisma = new PrismaClient();

// ─── DETERMINISTIC RNG ──────────────────────────────────
// mulberry32 — same fixed-seed pattern as seed-realistic.ts /
// seed-chat-conversations.ts. Re-runs against a populated DB pick the
// same patient for each feedback slot, same comment-bucket for each
// rating, same purpose for each visitor, etc.
const SEED_RNG = 0xeb1a2042;
let _rngState = SEED_RNG;
function rng(): number {
  _rngState |= 0;
  _rngState = (_rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randomInt(min: number, max: number) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // Normalize to UTC midnight so re-runs at different times of day still
  // hit the same row via the (patientId, category, submittedAt) anchor.
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function hoursAgo(n: number) {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d;
}

// Stable per-index "days ago" anchors for the 20 PatientFeedback rows.
// Pre-2026-05-11 this was `daysAgo(randomInt(0, 90))` which made the
// submittedAt non-deterministic — re-runs would not find the previous
// row via (patientId, category, submittedAt) and would duplicate.
const FEEDBACK_DAYS_AGO_BY_IDX = [
  0, 3, 7, 12, 18, 22, 28, 33, 40, 46,
  52, 58, 63, 67, 72, 77, 81, 85, 88, 90,
];

async function main() {
  console.log("=== Seeding Phase 4 Engagement data ===\n");

  // ─── FEEDBACK ──────────────────────────────────
  console.log("Creating patient feedback...");
  const patients = await prisma.patient.findMany({ take: 20 });
  if (patients.length === 0) {
    console.log("No patients found. Run base seed first.");
    return;
  }

  const categories: FeedbackCategory[] = [
    "DOCTOR",
    "NURSE",
    "RECEPTION",
    "CLEANLINESS",
    "FOOD",
    "WAITING_TIME",
    "BILLING",
    "OVERALL",
  ];

  const goodComments = [
    "Excellent service, staff was very attentive.",
    "Doctor explained everything clearly.",
    "Clean and well-organized facility.",
    "Quick service, no long wait.",
    null,
    null,
  ];
  const mediumComments = [
    "Decent experience overall, but could be improved.",
    "Food was okay, not great.",
    "Waiting time was a bit long.",
    null,
  ];
  const badComments = [
    "Very long wait time, disappointed.",
    "Staff seemed rushed and inattentive.",
    "Billing took forever and was confusing.",
  ];

  // Pre-2026-05-11: `await prisma.patientFeedback.deleteMany({})` —
  // wiped EVERY feedback row in the DB. Removed; replaced with the
  // per-row (patientId, category, submittedAt) skip-or-create guard
  // below.
  let feedbackCreated = 0;
  let feedbackSkipped = 0;
  for (let i = 0; i < 20; i++) {
    const patient = patients[i % patients.length];
    const category = categories[i % categories.length];
    const submittedAt = daysAgo(FEEDBACK_DAYS_AGO_BY_IDX[i]);

    const existing = await prisma.patientFeedback.findFirst({
      where: { patientId: patient.id, category, submittedAt },
    });
    if (existing) {
      // Burn rng rolls so downstream decisions stay aligned with the
      // original seeded run when only some rows were inserted.
      rng(); // rating bucket roll
      rng(); // rating numeric roll
      if (category === "OVERALL") rng(); // nps roll
      rng(); // comment roll
      feedbackSkipped++;
      continue;
    }

    const rating = rng() < 0.75 ? randomInt(4, 5) : randomInt(2, 3);
    const nps =
      category === "OVERALL"
        ? rating >= 4
          ? randomInt(8, 10)
          : rating >= 3
            ? randomInt(5, 7)
            : randomInt(0, 4)
        : undefined;
    const comment =
      rating >= 4
        ? randomItem(goodComments)
        : rating === 3
          ? randomItem(mediumComments)
          : randomItem(badComments);

    await prisma.patientFeedback.create({
      data: {
        patientId: patient.id,
        category,
        rating,
        nps: nps ?? null,
        comment: comment ?? null,
        submittedAt,
      },
    });
    feedbackCreated++;
  }
  console.log(`  Feedback: ${feedbackCreated} created, ${feedbackSkipped} skipped`);

  // ─── COMPLAINTS ──────────────────────────────────
  console.log("\nCreating complaints...");
  // Pre-2026-05-11: `await prisma.complaint.deleteMany({})` — wiped
  // EVERY complaint row in the DB. Removed; replaced with per-row
  // findUnique on the seed-namespaced ticketNumber.

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    take: 2,
  });
  const adminId = admins[0]?.id ?? null;

  const complaintSeeds: Array<{
    status: ComplaintStatus;
    priority: string;
    category: string;
    description: string;
    daysOld: number;
    resolution?: string;
    assign: boolean;
  }> = [
    {
      status: "OPEN",
      priority: "HIGH",
      category: "Billing",
      description: "Charged twice for the same consultation.",
      daysOld: 2,
      assign: false,
    },
    {
      status: "OPEN",
      priority: "CRITICAL",
      category: "Service",
      description:
        "Elderly patient was made to wait over 3 hours for emergency consultation.",
      daysOld: 9,
      assign: false,
    },
    {
      status: "UNDER_REVIEW",
      priority: "MEDIUM",
      category: "Staff Behavior",
      description: "Reception staff was rude while handling queries.",
      daysOld: 5,
      assign: true,
    },
    {
      status: "RESOLVED",
      priority: "LOW",
      category: "Cleanliness",
      description: "Washroom on 2nd floor was not maintained well.",
      daysOld: 10,
      resolution: "Housekeeping schedule updated; now cleaned every 2 hours.",
      assign: true,
    },
    {
      status: "RESOLVED",
      priority: "HIGH",
      category: "Food",
      description: "Food served was cold and tasteless during admission.",
      daysOld: 15,
      resolution: "Kitchen supervisor briefed. Temperature monitoring enforced.",
      assign: true,
    },
  ];

  let complaintsCreated = 0;
  let complaintsSkipped = 0;
  for (let i = 0; i < complaintSeeds.length; i++) {
    const c = complaintSeeds[i];
    const ticketNumber = `CMP-PH4-SEED-${String(i + 1).padStart(4, "0")}`;

    const existing = await prisma.complaint.findUnique({ where: { ticketNumber } });
    if (existing) {
      // Burn rng rolls so partial-run recovery stays aligned.
      rng(); // patient-vs-anonymous roll
      rng(); // phone digits
      complaintsSkipped++;
      continue;
    }

    const patient = rng() > 0.4 ? patients[i % patients.length] : null;
    const created = daysAgo(c.daysOld);
    await prisma.complaint.create({
      data: {
        ticketNumber,
        patientId: patient?.id,
        name: patient ? null : `Anonymous Caller ${i + 1}`,
        phone: patient ? null : `98765${randomInt(10000, 99999)}`,
        category: c.category,
        description: c.description,
        status: c.status,
        priority: c.priority,
        assignedTo: c.assign ? adminId : null,
        resolution: c.resolution ?? null,
        resolvedAt: c.status === "RESOLVED" ? daysAgo(c.daysOld - 3) : null,
        createdAt: created,
        updatedAt: created,
      },
    });
    complaintsCreated++;
  }
  console.log(`  Complaints: ${complaintsCreated} created, ${complaintsSkipped} skipped`);

  // ─── CHAT ──────────────────────────────────
  console.log("\nCreating chat rooms and messages...");
  // Pre-2026-05-11: three unscoped `deleteMany({})` calls on ChatMessage,
  // ChatParticipant, and ChatRoom. Removed; replaced with per-room
  // findFirst-by-name guard + per-message seed-tag startsWith guard.

  const doctors = await prisma.user.findMany({
    where: { role: "DOCTOR" },
    take: 5,
  });
  const nurses = await prisma.user.findMany({
    where: { role: "NURSE" },
    take: 5,
  });

  if (admins.length === 0) {
    console.log("  No admin user found, skipping chat seed.");
  } else {
    const admin = admins[0];

    // 1. Doctors Channel (group)
    const doctorsChannel = await ensureGroupRoom(
      "Doctors Channel",
      admin.id,
      [admin.id, ...doctors.map((d) => d.id)],
    );

    const doctorMessages = [
      { senderId: admin.id, content: "Welcome to the Doctors channel!" },
      { senderId: doctors[0]?.id ?? admin.id, content: "Thanks, good to be here." },
      {
        senderId: doctors[1]?.id ?? admin.id,
        content: "Could we align on new referral SOPs?",
      },
      { senderId: admin.id, content: "Yes, let's have a meet on Friday at 10 AM." },
      { senderId: doctors[2]?.id ?? admin.id, content: "Noted. Will confirm schedule." },
      { senderId: doctors[0]?.id ?? admin.id, content: "Also, the OT scheduling app needs an update." },
      { senderId: admin.id, content: "Raising with IT team." },
      { senderId: doctors[3]?.id ?? admin.id, content: "Perfect, thanks." },
      { senderId: doctors[1]?.id ?? admin.id, content: "New patient from ER being admitted to ward 2B." },
      { senderId: admin.id, content: "Ack. Please update admission record." },
    ];
    const doctorMsgsAny = await seedTaggedMessages(doctorsChannel.id, "doctors", doctorMessages);

    // 2. Nursing Team (group)
    const nursingTeam = await ensureGroupRoom(
      "Nursing Team",
      admin.id,
      [admin.id, ...nurses.map((n) => n.id)],
    );

    const nurseMessages = [
      { senderId: admin.id, content: "Shift roster for next week is uploaded." },
      { senderId: nurses[0]?.id ?? admin.id, content: "Thanks, will review." },
      { senderId: nurses[1]?.id ?? admin.id, content: "Medication cart restocking today at 2 PM." },
      { senderId: nurses[2]?.id ?? admin.id, content: "Copy, I'll be there." },
      { senderId: nurses[0]?.id ?? admin.id, content: "Bed 304 needs attention — patient has high fever." },
      { senderId: admin.id, content: "Calling the on-call doctor now." },
      { senderId: nurses[3]?.id ?? admin.id, content: "Dr. Sharma is on way." },
      { senderId: nurses[1]?.id ?? admin.id, content: "Good, vitals monitored every 30 min." },
      { senderId: admin.id, content: "Appreciate the quick response team." },
      { senderId: nurses[2]?.id ?? admin.id, content: "Thanks team!" },
    ];
    const nurseMsgsAny = await seedTaggedMessages(nursingTeam.id, "nursing", nurseMessages);

    // 3. 1-on-1 between admin and Dr. Sharma (first doctor)
    const drSharma = doctors[0];
    let directAny = false;
    if (drSharma) {
      const direct = await ensureDirectRoom(admin.id, drSharma.id);

      const directMessages = [
        { senderId: admin.id, content: "Hi Dr. Sharma, got a minute?" },
        { senderId: drSharma.id, content: "Yes, what's up?" },
        { senderId: admin.id, content: "Need your input on the surgery schedule for next week." },
        { senderId: drSharma.id, content: "Sure, send me the draft." },
        { senderId: admin.id, content: "Sending now via email. Please review by EOD." },
        { senderId: drSharma.id, content: "Will do." },
        { senderId: admin.id, content: "Also, patient Rahul Sharma is asking for a follow-up." },
        { senderId: drSharma.id, content: "Schedule him for Thursday 4 PM." },
        { senderId: admin.id, content: "Done, thanks." },
        { senderId: drSharma.id, content: "Anytime!" },
      ];
      directAny = await seedTaggedMessages(direct.id, "admin-sharma", directMessages);
    }

    console.log(
      `  Chat rooms ready (new messages this run: doctors=${doctorMsgsAny ? "yes" : "no"}, ` +
        `nursing=${nurseMsgsAny ? "yes" : "no"}, direct=${directAny ? "yes" : "no"})`,
    );
  }

  // ─── VISITORS ──────────────────────────────────
  console.log("\nCreating visitors...");
  // Pre-2026-05-11: `await prisma.visitor.deleteMany({})` — wiped EVERY
  // visitor row in the DB. Removed; replaced with per-row findUnique on
  // the seed-namespaced passNumber.

  const purposes: VisitorPurpose[] = [
    "PATIENT_VISIT",
    "DELIVERY",
    "APPOINTMENT",
    "MEETING",
    "OTHER",
  ];
  const visitorNames = [
    "Ramesh Kumar",
    "Sita Devi",
    "Anil Verma",
    "Priya Singh",
    "Arjun Reddy",
    "Meena Sharma",
    "Vikram Gupta",
    "Sunita Patel",
  ];
  const idTypes = ["Aadhaar", "PAN", "Driving License", "Passport"];

  let visitorsCreated = 0;
  let visitorsSkipped = 0;
  for (let i = 0; i < 8; i++) {
    // Stable seed-namespaced passNumber. Pre-2026-05-11 used a yyyymmdd
    // suffix that shifted on every deploy — the new namespace is stable.
    const passNumber = `VIS-PH4-SEED-${String(i + 1).padStart(4, "0")}`;

    const existing = await prisma.visitor.findUnique({ where: { passNumber } });
    if (existing) {
      // Burn rng rolls for deterministic partial-run recovery.
      rng(); rng(); rng(); rng(); rng();
      visitorsSkipped++;
      continue;
    }

    const isActive = i < 5;
    // Deterministic checkIn offset keyed off `i`.
    const checkInHoursAgo = isActive ? 1 + (i % 6) : 8 + ((i * 3) % 13);
    const checkInAt = hoursAgo(checkInHoursAgo);
    const stayMinutes = 30 + ((i * 23) % 150);
    const checkOutAt = isActive
      ? null
      : new Date(checkInAt.getTime() + stayMinutes * 60000);

    const idTypePick = randomItem(idTypes);
    const idProofDigits = randomInt(100000, 999999);
    const patientForVisitor = rng() > 0.5 ? patients[i % patients.length] : null;
    const dept = randomItem([
      "Cardiology",
      "Orthopedics",
      "Pediatrics",
      "General",
      "ICU",
    ]);
    const phoneDigits = randomInt(10000, 99999);

    await prisma.visitor.create({
      data: {
        passNumber,
        name: visitorNames[i],
        phone: `98765${phoneDigits}`,
        idProofType: idTypePick,
        idProofNumber: `ID${idProofDigits}`,
        patientId: patientForVisitor?.id ?? null,
        purpose: purposes[i % purposes.length],
        department: dept,
        checkInAt,
        checkOutAt,
        notes: isActive ? null : "Checked out normally",
      },
    });
    visitorsCreated++;
  }
  console.log(`  Visitors: ${visitorsCreated} created, ${visitorsSkipped} skipped`);

  console.log("\n=== Phase 4 Engagement seed complete ===");
}

// ─── Chat helpers ──────────────────────────────────────
async function ensureGroupRoom(
  name: string,
  createdBy: string,
  participantUserIds: string[],
) {
  let room = await prisma.chatRoom.findFirst({
    where: { name, isGroup: true, createdBy },
  });
  if (!room) {
    room = await prisma.chatRoom.create({
      data: {
        name,
        isGroup: true,
        createdBy,
      },
    });
  }
  const uniqueParticipants = Array.from(new Set(participantUserIds));
  for (const uid of uniqueParticipants) {
    await prisma.chatParticipant.upsert({
      where: { roomId_userId: { roomId: room.id, userId: uid } },
      update: {},
      create: { roomId: room.id, userId: uid },
    });
  }
  return room;
}

async function ensureDirectRoom(userA: string, userB: string) {
  const candidate = await prisma.chatRoom.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: userA } } },
        { participants: { some: { userId: userB } } },
      ],
    },
  });
  if (candidate) {
    return candidate;
  }
  const room = await prisma.chatRoom.create({
    data: {
      isGroup: false,
      createdBy: userA,
    },
  });
  await prisma.chatParticipant.upsert({
    where: { roomId_userId: { roomId: room.id, userId: userA } },
    update: {},
    create: { roomId: room.id, userId: userA },
  });
  await prisma.chatParticipant.upsert({
    where: { roomId_userId: { roomId: room.id, userId: userB } },
    update: {},
    create: { roomId: room.id, userId: userB },
  });
  return room;
}

async function seedTaggedMessages(
  roomId: string,
  roomKey: string,
  messages: Array<{ senderId: string; content: string }>,
): Promise<boolean> {
  let created = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const seedTag = `[PH4-ENG-CHAT-SEED-${roomKey}-${String(i + 1).padStart(4, "0")}]`;

    const exists = await prisma.chatMessage.findFirst({
      where: { roomId, content: { startsWith: seedTag } },
      select: { id: true },
    });
    if (exists) continue;

    await prisma.chatMessage.create({
      data: {
        roomId,
        senderId: m.senderId,
        content: `${seedTag} ${m.content}`,
        type: "TEXT" as MessageType,
        createdAt: hoursAgo(messages.length - i),
      },
    });
    created = true;
  }
  if (created) {
    await prisma.chatRoom.update({
      where: { id: roomId },
      data: { lastMessageAt: hoursAgo(1) },
    });
  }
  return created;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
