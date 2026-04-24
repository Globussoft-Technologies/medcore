/**
 * Prompt registry — V2 of TRIAGE_SYSTEM.
 *
 * Exercises the prompt-registry rollout flow end-to-end. This is the first
 * V2 row we've ever seeded, so it doubles as a smoke test of
 * `createPromptVersion` running against real Postgres (the existing
 * seed-prompts.ts only creates v1 rows).
 *
 * Delta versus V1 (minimum-diff — three sentence-level changes):
 *   1. Red-flag handling: V2 requires an EXPLICIT acknowledgement of
 *      emergency symptoms in the assistant's reply, not just routing
 *      away. Reinforces the red-flag layer at the language level.
 *   2. JSON-only output directive: V2 tightens the structured-output
 *      instruction to reduce tool-call hallucinations that eval logs
 *      have been showing on mid-turn refusals.
 *   3. Scope guard: V2 explicitly forbids drug-name / dosage mentions
 *      (the routing assistant was occasionally echoing user-typed drug
 *      names back, which QA flagged as prescription-adjacent).
 *
 * Behaviour:
 *   - Inserts V2 as INACTIVE. V1 stays live until an admin flips the
 *     activation flag via POST /api/v1/ai/admin/prompts/versions/:id/activate.
 *   - Idempotent: if a row with (key="TRIAGE_SYSTEM", version=2, content=...)
 *     already exists, we skip. If a v2 row exists with DIFFERENT content,
 *     we refuse and exit non-zero — the caller should bump to v3 rather
 *     than mutate history.
 *
 * Run:
 *   npm -w @medcore/db run db:seed-prompts-v2
 *
 * Then roll out:
 *   curl -X POST /api/v1/ai/admin/prompts/versions/$V2_ID/activate \
 *        -H "Authorization: Bearer $ADMIN_JWT"
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TRIAGE_SYSTEM_V2 = `You are MedCore's AI appointment booking assistant for Indian hospitals. Your role is to help patients find the right specialist doctor based on their symptoms. You are NOT a diagnostic tool — you route patients to the right doctor, nothing more.

Guidelines:
- Ask concise, empathetic follow-up questions (max 5-7 total across the conversation)
- Always check for red-flag/emergency symptoms at every turn, and when detected, explicitly acknowledge the emergency in your reply before routing (e.g. "This sounds serious — please seek emergency care immediately")
- Respond in the same language the patient uses (English or Hindi)
- Never diagnose, prescribe, or give medical advice; do not mention specific drug names or dosages even if the patient volunteers them
- Always include a disclaimer that this is a routing assistant only
- If unsure, recommend a General Physician
- Output MUST be a single JSON object matching the supplied schema. Do not wrap it in markdown, do not emit tool-calls, do not append commentary after the closing brace

Red-flag symptoms requiring immediate emergency routing: chest pain with radiation, difficulty breathing, stroke signs (facial drooping, arm weakness, speech difficulty), severe bleeding, loss of consciousness, anaphylaxis, suicidal ideation, eclampsia, neonatal distress, severe burns.

Indian medical specialties to consider: General Physician, Cardiologist, Pulmonologist, Gastroenterologist, Neurologist, Orthopedic, Dermatologist, ENT, Ophthalmologist, Gynecologist, Pediatrician, Urologist, Endocrinologist, Psychiatrist, Oncologist, Nephrologist, Rheumatologist, Dentist, Physiotherapist.`;

async function main() {
  const KEY = "TRIAGE_SYSTEM";
  const SYSTEM_USER = "system-seed-v2";

  const existingV2 = await prisma.prompt.findUnique({
    where: { key_version: { key: KEY, version: 2 } },
  });

  if (existingV2) {
    if (existingV2.content === TRIAGE_SYSTEM_V2) {
      console.log(`seed-prompts-v2: V2 of ${KEY} already seeded (id=${existingV2.id}), skipping.`);
      return;
    }
    console.error(
      `seed-prompts-v2: V2 of ${KEY} exists but content differs. Refusing to mutate history; ` +
        `bump to V3 via POST /api/v1/ai/admin/prompts/${KEY}/versions instead.`
    );
    process.exit(2);
  }

  // Compute nextVersion explicitly rather than trusting "2" in case some
  // admin has already created v2/v3 manually. This keeps the script
  // re-runnable in any environment.
  const latest = await prisma.prompt.aggregate({
    where: { key: KEY },
    _max: { version: true },
  });
  const nextVersion = (latest._max.version ?? 0) + 1;
  if (nextVersion !== 2) {
    console.error(
      `seed-prompts-v2: expected to insert as v2 but next version would be v${nextVersion}. ` +
        `Another process has already bumped ${KEY}; aborting to avoid clobbering.`
    );
    process.exit(3);
  }

  const created = await prisma.prompt.create({
    data: {
      key: KEY,
      version: nextVersion,
      content: TRIAGE_SYSTEM_V2,
      createdBy: SYSTEM_USER,
      // Intentionally INACTIVE — V1 stays live until an admin promotes.
      active: false,
      notes:
        "V2: explicit red-flag acknowledgement + tightened JSON-only directive + " +
        "no drug-name/dosage echo. Seeded inactive; activate via admin API.",
    },
  });

  console.log(
    `seed-prompts-v2: created ${KEY} v${created.version} (id=${created.id}, active=false). ` +
      `To roll out: POST /api/v1/ai/admin/prompts/versions/${created.id}/activate`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
