/**
 * Seed 3 active AI-Triage → Agent-Console handoffs so the
 * /dashboard/agent-console page demos with realistic data.
 *
 * Each handoff creates:
 *   1. An ACTIVE AITriageSession with a believable mid-conversation
 *      `messages` JSON, a `chiefComplaint`, `handoffChatRoomId`, and
 *      Patient + tenant linkage.
 *   2. A ChatRoom (isGroup=true) with the patient as a participant.
 *   3. 4–6 ChatMessages alternating between the patient and the
 *      "AI assistant" persona — last message is FROM the patient
 *      ("Can I talk to a person please?") so the agent has something
 *      to react to.
 *
 * Idempotent: re-runs check for existing rows with deterministic ids
 * derived from `seedKey` and skip if present. Safe to re-run on prod
 * after a sanitize-and-reseed pass.
 *
 * Run:  npx tsx scripts/seed-active-handoffs.ts [--apply]
 *
 * Default mode is APPLY (this is a tiny script, no destructive ops).
 * Pass --dry-run to just print the plan.
 */

import { prisma } from "@medcore/db";
import { createHash } from "crypto";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const PREFIX = "[seed-handoffs]";

function det(seedKey: string): string {
  // Deterministic UUID-shaped string derived from a seed string. Lets us
  // upsert by id without a unique constraint on natural keys.
  const h = createHash("sha1").update(`medcore:handoff:${seedKey}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20,
  )}-${h.slice(20, 32)}`;
}

interface Scenario {
  seedKey: string;
  language: "en" | "hi" | "ta";
  chiefComplaint: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    seedKey: "chest-tightness-2026-04-27",
    language: "en",
    chiefComplaint: "Tightness in chest with mild breathlessness",
    conversation: [
      { role: "assistant", content: "Hello! I'm the MedCore AI assistant. What's bringing you in today?" },
      { role: "user", content: "I've had this tightness in my chest since yesterday morning. Comes and goes." },
      { role: "assistant", content: "I'm sorry to hear that. Is it sharp, dull, or pressure-like? Does anything make it worse?" },
      { role: "user", content: "It's pressure-like. Worse when I climb stairs. I'm 54 and on BP medication." },
      { role: "assistant", content: "Thanks for that. Have you had any breathlessness, sweating, or pain radiating to your arm or jaw?" },
      { role: "user", content: "A little breathlessness this morning. No sweating. Can I talk to a person please? I'm a bit worried." },
    ],
  },
  {
    seedKey: "fever-pediatric-2026-04-27",
    language: "hi",
    chiefComplaint: "Bachhe ko 2 din se bukhar hai (Child has fever for 2 days)",
    conversation: [
      { role: "assistant", content: "Namaste! Bataiye, kya pareshani hai?" },
      { role: "user", content: "Mere bete ko 2 din se bukhar hai, 102°F tak chala jaata hai. Wo 4 saal ka hai." },
      { role: "assistant", content: "Theek hai. Kya use khaansi, ulti, ya dast bhi hai? Aur kya wo paani peene ke liye taiyaar hai?" },
      { role: "user", content: "Halki khaansi hai. Ulti nahi. Paani thoda kam pee raha hai aaj. Kripya kisi se baat karwa dijiye." },
    ],
  },
  {
    seedKey: "knee-pain-elderly-2026-04-27",
    language: "en",
    chiefComplaint: "Right knee swelling and pain after a fall",
    conversation: [
      { role: "assistant", content: "Hello! Tell me what's going on." },
      { role: "user", content: "I'm 68 and I slipped at home this morning. My right knee is swollen and very painful when I try to put weight on it." },
      { role: "assistant", content: "I'm sorry to hear that. Are you able to bear weight at all? Any deformity or numbness in the leg?" },
      { role: "user", content: "I can stand but only briefly. No numbness. The knee looks bigger than the other one. Can someone book me into ortho today?" },
      { role: "assistant", content: "Of course. Let me check today's orthopaedic availability." },
      { role: "user", content: "Actually can I just speak to a person to be sure? I'm worried about the swelling." },
    ],
  },
];

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { subdomain: "default" } });
  if (!tenant) {
    console.error(`${PREFIX} no default tenant found — aborting.`);
    process.exit(1);
  }
  // Pick 3 patients with rich-enough records (any 3 active patients work)
  const patients = await prisma.patient.findMany({
    where: { tenantId: tenant.id },
    include: { user: true },
    take: 3,
    orderBy: { mrNumber: "desc" },
  });
  if (patients.length < 3) {
    console.error(`${PREFIX} need ≥3 patients; found ${patients.length}.`);
    process.exit(1);
  }

  // Pick a system / receptionist user as the "assistant" sender for chat
  // messages. ChatMessage requires a senderId pointing at a real user.
  const adminUser = await prisma.user.findFirst({
    where: { role: "ADMIN", tenantId: tenant.id },
  });
  if (!adminUser) {
    console.error(`${PREFIX} no ADMIN user found — aborting.`);
    process.exit(1);
  }

  console.log(`${PREFIX} mode=${DRY ? "DRY_RUN" : "APPLY"} tenant=${tenant.id} patients=${patients.length}`);

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    const patient = patients[i];
    const sessionId = det(`session:${scenario.seedKey}`);
    const roomId = det(`room:${scenario.seedKey}`);

    const existingSession = await prisma.aITriageSession.findUnique({ where: { id: sessionId } });
    if (existingSession) {
      console.log(`${PREFIX} SKIP ${scenario.seedKey} — session already exists (${sessionId})`);
      skipped += 1;
      continue;
    }

    console.log(
      `${PREFIX} ${DRY ? "[DRY RUN] would create" : "creating"} handoff "${scenario.chiefComplaint}" (lang=${scenario.language}, patient=${patient.user.name})`,
    );

    if (DRY) continue;

    // 1. ChatRoom
    await prisma.chatRoom.create({
      data: {
        id: roomId,
        name: `Triage handoff: ${patient.user.name}`,
        isGroup: true,
        createdBy: adminUser.id,
        tenantId: tenant.id,
        lastMessageAt: new Date(),
      },
    });

    // 2. ChatParticipant (patient)
    await prisma.chatParticipant.create({
      data: {
        roomId,
        userId: patient.userId,
        tenantId: tenant.id,
      },
    });

    // 3. ChatMessages (alternating)
    for (let m = 0; m < scenario.conversation.length; m++) {
      const msg = scenario.conversation[m];
      await prisma.chatMessage.create({
        data: {
          id: det(`msg:${scenario.seedKey}:${m}`),
          roomId,
          senderId: msg.role === "user" ? patient.userId : adminUser.id,
          content: msg.content,
          tenantId: tenant.id,
          createdAt: new Date(Date.now() - (scenario.conversation.length - m) * 60_000),
        },
      });
    }

    // 4. AITriageSession (ACTIVE, with handoffChatRoomId)
    await prisma.aITriageSession.create({
      data: {
        id: sessionId,
        patientId: patient.id,
        language: scenario.language,
        inputMode: "text",
        status: "ACTIVE",
        chiefComplaint: scenario.chiefComplaint,
        messages: scenario.conversation as any,
        consentGiven: true,
        consentAt: new Date(Date.now() - 10 * 60_000),
        handoffChatRoomId: roomId,
        tenantId: tenant.id,
        bookingFor: "SELF",
        createdAt: new Date(Date.now() - 12 * 60_000),
        updatedAt: new Date(),
      },
    });

    inserted += 1;
  }

  console.log(`${PREFIX} done. inserted=${inserted} skipped=${skipped}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(`${PREFIX} FATAL:`, err);
  await prisma.$disconnect();
  process.exit(1);
});
