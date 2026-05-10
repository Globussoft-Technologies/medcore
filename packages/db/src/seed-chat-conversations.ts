/**
 * Chat conversations seed — realistic doctor / nursing / admin / emergency
 * room dialog history (4 rooms x ~25-30 messages each).
 *
 * Idempotency contract (2026-05-10): safe to re-run on a populated demo
 * without creating duplicate rooms or duplicate messages.
 *
 *   - Rooms: findFirst({ where: { name, department } }) skip-or-create
 *     (this part was already idempotent before this commit).
 *   - Participants: upsert({ where: { roomId_userId } }) (already
 *     idempotent — leverages existing @@unique([roomId, userId])).
 *   - Messages (NEW): every seed-created message gets a stable seed-tag
 *     prefix [CHAT-SEED-<roomKey>-<NNNN>] embedded at the start of the
 *     content column. Re-runs do findFirst({ where: { roomId, content:
 *     { startsWith: '[CHAT-SEED-<roomKey>-<NNNN>]' } } }) and skip if
 *     present. This survives the case where a human user has posted real
 *     messages into the seeded room — we no longer rely on a coarse
 *     existing >= 10 count.
 *   - All randomness is driven by a deterministic mulberry32 PRNG seeded
 *     from a fixed constant (matches the seed-realistic.ts pattern).
 *     Re-runs produce byte-identical decisions for which messages get
 *     reactions / pins / mentions, so re-running doesn't drift the row
 *     content even if some rows already exist and others don't.
 *
 * Wired into scripts/deploy.sh step 8n. Failures are non-fatal
 * (matches the policy of every other deploy-time fixture seed).
 */
import { PrismaClient, MessageType, Role } from "@prisma/client";

const prisma = new PrismaClient();

// Deterministic mulberry32 PRNG — same fixed-seed pattern as
// seed-realistic.ts so re-runs pick the same senders / reactions / pins /
// mentions even if some messages already exist (partial-run recovery).
const SEED_RNG = 0xc4a72042;
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

function hoursAgo(n: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d;
}

// Per-room target message counts (deterministic — stable index → seed-tag).
const FILLER_BY_ROOM: Record<string, number> = {
  "doctors-lounge": 9,
  "nursing-handover": 8,
  "all-staff-announcements": 10,
  "emergency-coordination": 7,
};

const DOCTOR_DISCUSSION_MESSAGES = [
  "Got a 58 y/o male with atypical chest pain, troponin trending up. ECG shows new T-wave inversion in V2-V4. Cardiology consult?",
  "Sounds like evolving NSTEMI. Start DAPT + atorva 80mg stat. I'll see him in 15.",
  "Thanks. Family wants to know about cath timing.",
  "If troponin peaks are rising, will book for same-day angio. Keep NPO.",
  "Noted. Will update the chart.",
  "Anyone have experience with the new Dapagliflozin protocol for HFrEF? Starting one today.",
  "Yes, start low dose, check creatinine at day 3. Mind for volume depletion in elderly.",
  "Perfect — that aligns with what the ESC 2023 guidance says.",
  "Quick poll: should we add empagliflozin or dapagliflozin to our standing HF order set?",
  "Dapa is on formulary and cheaper for self-pay patients. Vote dapa.",
  "Peds case: 4-year-old with recurrent tonsillitis, 5 episodes this year. Criteria for T&A?",
  "Paradise criteria: 7 in 1yr, 5/yr x2, or 3/yr x3. You're borderline — one more season may tip it.",
  "Also factor in missed school days and sleep-disordered breathing.",
  "Will document and counsel parents for watchful waiting over summer.",
  "Anyone seeing the ID consultant today? Need an opinion on persistent fever post-op day 5.",
  "Dr. Menon is on rounds till 2pm. Page extension 4521.",
  "Thanks — will page. Cultures still pending.",
  "Update: cultures grew MRSA. Stepping up to vancomycin, trough at 48h.",
  "Good catch. Also consider echo to rule out endocarditis given persistent bacteremia.",
];

const NURSING_HANDOVER_MESSAGES = [
  "Night handover 7pm — Ward A.\n\nBed 1: Mr. Rao, post-op day 2 lap chole. Pain controlled on tramadol PRN, drain output 40ml serosanguinous. Passed flatus this evening.\nBed 3: Mrs. Iyer, CHF. On lasix IV BD, I/O negative 600ml today. Weigh at 6am.\nBed 5: Mr. Sharma, COPD exacerbation. SpO2 92% on 2L NC, neb 4-hourly. Watch for CO2 retention.\nBed 7: Admission pending from ER — possible DKA.",
  "Thanks Sister Meera. Will take over.",
  "One more — Bed 2 needs BP check q2h overnight, running on labetalol drip. Titrate per standing orders.",
  "Got it. Any falls risk?",
  "Bed 6 (Mr. Naik) — confused, attempting to climb rails. Bed alarm on, family staying overnight. No restraints yet.",
  "Will keep a close eye. Thanks!",
  "Morning handover — had a rough night.",
  "Bed 4 coded at 3:12am. ROSC after 2 rounds CPR + 1 shock. Transferred to ICU. Family notified.",
  "Ugh. His daughter was here yesterday asking about discharge 😔",
  "I know. Dr. Kapoor is updating family at 10am.",
  "Bed 8 — IV infiltrated around 5am, restarted in right AC. Arm wrapped with cold compress.",
  "Please document in the EMR and let the PICC team know if we need a midline.",
  "Med admin running 15 min behind — short-staffed tonight. Flagged to charge nurse.",
];

const ADMIN_ANNOUNCEMENTS = [
  "📢 Monthly staff meeting: Friday 18th April, 4:30 PM, Conference Hall A. Attendance mandatory for all department heads.",
  "The EMR system will undergo scheduled maintenance on Saturday 1am-4am. Paper charting protocol will be active during this window. Please brief your teams.",
  "Reminder: NABH audit next week (Mon–Wed). Ensure all patient consent forms, medication charts, and infection control logs are up to date.",
  "New HR policy on leave: effective May 1st, casual leave applications must be submitted 48h in advance except for emergencies. Updated policy on the intranet.",
  "Hospital foundation day celebrations on 25th April. All staff invited for lunch at 1pm. Department heads please confirm attendance count by Monday.",
  "Infection control update: hand hygiene compliance dropped to 78% last month. Let's get back above 90%. Audits will increase this week.",
  "Fire drill scheduled Thursday 11am. Please follow evacuation routes. Do not use elevators during the drill.",
  "Welcome to our new resident doctors joining the pediatrics and general medicine departments! Orientation is on Monday 9am, Room 205.",
];

const EMERGENCY_COORDINATION = [
  "🚨 Code Blue - ICU Bed 3. All available doctors please respond.",
  "On my way.",
  "Anesthesia en route.",
  "ROSC achieved. Stabilizing. Thanks everyone.",
  "Great team work. Debrief at 10pm.",
  "MCI alert — 6 casualties incoming from RTA on NH8. ETA 12 min.",
  "ER staff please prepare 6 bays. OT team stay on standby.",
  "Blood bank — need 4 units O-neg urgently.",
  "O-neg being cross-matched now, 4 units ready in 8 min.",
  "Triage complete: 2 red (chest trauma + pelvic fx), 3 yellow, 1 green. Green discharged home.",
  "Red #1 going to OT now. Red #2 needs CT first, then OT.",
  "Ambulance #3 requesting route to trauma bay — service entrance clear.",
  "Situation under control. Thanks team — exceptional response.",
];

const SHORT_MESSAGES = [
  "Ok",
  "👍",
  "On it",
  "Thanks!",
  "Will do",
  "Noted.",
  "Copy that",
  "Any updates?",
  "See you there",
  "Done ✅",
  "Paged Dr. Rao",
  "Back in 10",
];

const REACTIONS = ["👍", "❤️", "🙏", "😂", "👏", "🔥", "💯", "😮"];

async function main() {
  console.log("\n=== Seeding Chat Conversations ===\n");

  // Gather users by role
  const doctorUsers = await prisma.user.findMany({ where: { role: Role.DOCTOR, isActive: true }, take: 10 });
  const nurseUsers = await prisma.user.findMany({ where: { role: Role.NURSE, isActive: true }, take: 10 });
  const adminUsers = await prisma.user.findMany({ where: { role: Role.ADMIN, isActive: true }, take: 5 });
  const receptionUsers = await prisma.user.findMany({ where: { role: Role.RECEPTION, isActive: true }, take: 5 });

  if (doctorUsers.length === 0 && nurseUsers.length === 0) {
    console.warn("  No users found — skipping.");
    return;
  }

  const creatorId =
    adminUsers[0]?.id ?? doctorUsers[0]?.id ?? nurseUsers[0]?.id ?? receptionUsers[0]?.id;

  // ─── Ensure rooms exist (idempotent) ───────────────────
  const roomDefs = [
    {
      key: "doctors-lounge",
      name: "Doctors Lounge",
      department: "Doctors",
      isGroup: true,
      isChannel: false,
      participants: doctorUsers.map((u) => u.id),
      messageSet: "doctor",
    },
    {
      key: "nursing-handover",
      name: "Nursing Handover",
      department: "Nursing",
      isGroup: true,
      isChannel: false,
      participants: nurseUsers.map((u) => u.id),
      messageSet: "nursing",
    },
    {
      key: "all-staff-announcements",
      name: "All Staff Announcements",
      department: "All Staff",
      isGroup: true,
      isChannel: true,
      participants: [
        ...doctorUsers.map((u) => u.id),
        ...nurseUsers.map((u) => u.id),
        ...adminUsers.map((u) => u.id),
        ...receptionUsers.map((u) => u.id),
      ],
      messageSet: "admin",
    },
    {
      key: "emergency-coordination",
      name: "Emergency Coordination",
      department: "Emergency",
      isGroup: true,
      isChannel: false,
      participants: [
        ...doctorUsers.slice(0, 3).map((u) => u.id),
        ...nurseUsers.slice(0, 3).map((u) => u.id),
      ],
      messageSet: "emergency",
    },
  ];

  const roomMap: Record<string, { id: string; participants: string[]; messageSet: string }> = {};

  for (const r of roomDefs) {
    if (r.participants.length === 0) continue;

    // Find existing by (name + department)
    let room = await prisma.chatRoom.findFirst({
      where: { name: r.name, department: r.department },
    });
    if (!room) {
      room = await prisma.chatRoom.create({
        data: {
          name: r.name,
          department: r.department,
          isGroup: r.isGroup,
          isChannel: r.isChannel,
          createdBy: creatorId,
        },
      });
      // Add participants
      for (const uid of r.participants) {
        await prisma.chatParticipant.upsert({
          where: { roomId_userId: { roomId: room.id, userId: uid } },
          update: {},
          create: { roomId: room.id, userId: uid },
        });
      }
    }
    roomMap[r.key] = {
      id: room.id,
      participants: r.participants.filter((p, i, a) => a.indexOf(p) === i),
      messageSet: r.messageSet,
    };
  }

  // Build messages (seed-tagged, idempotent).
  let messagesCreated = 0;
  let messagesSkipped = 0;
  let reactionsAdded = 0;
  let pinnedCount = 0;
  let mentionsCount = 0;

  const messageSets: Record<string, string[]> = {
    doctor: DOCTOR_DISCUSSION_MESSAGES,
    nursing: NURSING_HANDOVER_MESSAGES,
    admin: ADMIN_ANNOUNCEMENTS,
    emergency: EMERGENCY_COORDINATION,
  };

  for (const [key, room] of Object.entries(roomMap)) {
    const msgs = messageSets[room.messageSet];
    if (!msgs || room.participants.length === 0) continue;

    // Deterministic per-room totals — stable across re-runs so seed-tag
    // indexes always map to the same content slot.
    const fillerCount = FILLER_BY_ROOM[key] ?? 8;
    const totalForRoom = msgs.length + fillerCount;
    let perRoomCreated = 0;
    let perRoomSkipped = 0;
    let lastTs = hoursAgo(72 + (msgs.length % 24));
    const pinsForThisRoom = key === "all-staff-announcements" ? 2 : 1;
    let pinsDone = 0;

    for (let n = 0; n < totalForRoom; n++) {
      const seedTag = `[CHAT-SEED-${key}-${String(n + 1).padStart(4, "0")}]`;

      // Idempotency guard: skip if a seed-tagged row with this index
      // already exists in this room. Tag is embedded at the start of the
      // content column so we can detect via startsWith.
      const exists = await prisma.chatMessage.findFirst({
        where: { roomId: room.id, content: { startsWith: seedTag } },
        select: { id: true, isPinned: true },
      });
      if (exists) {
        perRoomSkipped++;
        if (exists.isPinned) pinsDone++;
        // advance the simulated timestamp anyway so subsequent NEW rows
        // land in chronological order.
        lastTs = new Date(lastTs.getTime() + randomInt(5, 90) * 60_000);
        // burn rng rolls so downstream decisions stay aligned with the
        // original seeded run when only some rows were inserted.
        rng(); rng(); rng();
        continue;
      }

      const baseContent = n < msgs.length ? msgs[n] : randomItem(SHORT_MESSAGES);
      lastTs = new Date(lastTs.getTime() + randomInt(5, 90) * 60_000);

      let senderId: string;
      if (key === "all-staff-announcements") {
        senderId = randomItem(adminUsers.length > 0 ? adminUsers.map((u) => u.id) : room.participants);
      } else {
        senderId = room.participants[n % room.participants.length];
      }

      let mentionIds: string | null = null;
      let mentionPrefix = "";
      if (rng() < 0.15 && room.participants.length > 1) {
        const mentioned = randomItem(room.participants.filter((p) => p !== senderId));
        const mentionedUser = [...doctorUsers, ...nurseUsers, ...adminUsers, ...receptionUsers].find(
          (u) => u.id === mentioned,
        );
        if (mentionedUser) {
          mentionPrefix = `@${mentionedUser.name.split(" ")[0]} `;
          mentionIds = mentioned;
          mentionsCount++;
        }
      }

      let reactions: Record<string, string[]> | null = null;
      if (rng() < 0.3) {
        const numReactors = randomInt(1, Math.min(4, room.participants.length));
        const emoji = randomItem(REACTIONS);
        const reactors = [...room.participants]
          .sort(() => rng() - 0.5)
          .slice(0, numReactors)
          .filter((p) => p !== senderId);
        if (reactors.length > 0) {
          reactions = { [emoji]: reactors };
          if (rng() < 0.3) {
            const emoji2 = randomItem(REACTIONS.filter((e) => e !== emoji));
            reactions[emoji2] = reactors.slice(0, 1);
          }
          reactionsAdded++;
        }
      }

      const shouldPin =
        pinsDone < pinsForThisRoom &&
        (key === "all-staff-announcements" ? n < 3 : n < msgs.length && rng() < 0.1);

      // Embed seed-tag at the start of content so the next run can detect
      // and skip this row. Visible in the chat UI (acceptable for demo).
      const finalContent = `${seedTag} ${mentionPrefix}${baseContent}`;

      await prisma.chatMessage.create({
        data: {
          roomId: room.id,
          senderId,
          type: MessageType.TEXT,
          content: finalContent,
          mentionIds,
          reactions: reactions as any,
          isPinned: shouldPin,
          pinnedAt: shouldPin ? lastTs : null,
          pinnedBy: shouldPin ? senderId : null,
          createdAt: lastTs,
        },
      });
      if (shouldPin) {
        pinsDone++;
        pinnedCount++;
      }
      perRoomCreated++;
      messagesCreated++;
    }

    messagesSkipped += perRoomSkipped;

    if (perRoomCreated > 0) {
      await prisma.chatRoom.update({
        where: { id: room.id },
        data: { lastMessageAt: lastTs },
      });
    }

    console.log(`  ${key}: created ${perRoomCreated}, skipped ${perRoomSkipped} (already seeded)`);
  }

  console.log(`\n  Messages created:  ${messagesCreated}`);
  console.log(`  Messages skipped:  ${messagesSkipped} (idempotent re-run)`);
  console.log(`  With reactions:    ${reactionsAdded}`);
  console.log(`  Pinned messages:   ${pinnedCount}`);
  console.log(`  Mentions included: ${mentionsCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
