// Integration tests for Pearl ERP Stage 1 §5.1 piece 2b — Campaign
// dispatcher sweep worker (`services/campaign-dispatcher-sweep.ts`).
//
// What / which modules / why:
//   - Verifies the deferred dispatch lane: a Campaign in `SCHEDULED`
//     status with `scheduledAt <= now` gets picked up by the sweep, its
//     audience is compiled, per-recipient CampaignSend rows are written,
//     and the Campaign transitions to COMPLETED. The sync-dispatch lane
//     (POST /:id/dispatch) has its own coverage in `campaigns.test.ts`;
//     this file specifically exercises the worker shell.
//   - Covers:
//       1. Happy path — 3 seeded patients, audience matches 2 (one
//          OPTED_OUT of WHATSAPP → SUPPRESSED), one non-match (OTHER
//          gender) → 0 sends. Result: 2 CampaignSend rows (1 SENT,
//          1 SUPPRESSED), Campaign.status flipped to COMPLETED.
//       2. Quiet-hour clamp — sendWindowStart=22:00, sendWindowEnd=06:00,
//          opts.now=14:00 IST equivalent → no sends, Campaign stays
//          SCHEDULED, sweep counter `deferredQuietHours += 1`.
//       3. Token substitution — body `Hi {{patient.firstName}} ...`
//          renders with the patient's first name before being handed to
//          the channel adapter. We assert via a spy on
//          `services/messaging/whatsapp.ts:sendWhatsApp`.
//       4. No-audience guard — a SCHEDULED campaign with `audienceId =
//          null` gets CANCELLED with a machine-readable `cancelReason`.
//   - Stub mode for the WhatsApp adapter: with no
//     WHATSAPP_API_URL/WHATSAPP_API_KEY env vars set, the adapter
//     returns `{ok: true, messageId: "stub-..."}` so we can assert
//     status=SENT without standing up an outbound HTTP server.
//
// Direct-prisma seeding mirrors `campaign-audiences.test.ts`.

import { it, expect, beforeAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";

// Capture every (to, text) the dispatcher hands to the WhatsApp adapter so
// the token-substitution test can assert on the rendered body. We mock
// the module to a stub that records calls AND mirrors the real
// stub-mode contract (`{ok: true, messageId: "stub-..."}`) so the
// dispatcher writes `status=SENT` to CampaignSend.
// Campaigns now send WhatsApp via messaging/whatsapp ({ to, body }), the
// same Meta sender prescriptions use.
const whatsappCalls: Array<{ to: string; text: string }> = [];
vi.mock("../../services/messaging/whatsapp", () => ({
  sendWhatsApp: vi.fn(async (input: { to: string; body: string }) => {
    whatsappCalls.push({ to: input.to, text: input.body });
    return { ok: true, messageId: `stub-${Date.now()}` };
  }),
}));

import { dispatchPendingCampaigns } from "../../services/campaign-dispatcher-sweep";

let tenantId: string;
let patientMatchUserId: string;
let patientMatchId: string;
let patientNonMatchId: string;
let patientOptedOutId: string;
let audienceId: string;

describeIfDB(
  "Campaign dispatcher sweep (Pearl §5.1 piece 2b — integration)",
  () => {
    beforeAll(async () => {
      await resetDB();

      const prisma = await getPrisma();
      const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);

      const ts = Date.now();
      const tenant = await prisma.tenant.create({
        data: {
          name: "Tenant CDS",
          subdomain: `tenant-cds-${ts}`,
          plan: "BASIC",
          active: true,
        },
      });
      tenantId = tenant.id;

      async function seedPatient(
        gender: "MALE" | "FEMALE" | "OTHER",
        idx: number,
        opts: { optOutWhatsApp?: boolean } = {},
      ) {
        const user = await prisma.user.create({
          data: {
            email: `cds-${gender.toLowerCase()}-${idx}-${ts}@test.local`,
            name: `Cds ${gender}${idx} Patient`,
            phone: `9100${String(ts).slice(-6)}${idx}`,
            passwordHash,
            role: "PATIENT",
            tenantId,
          },
        });
        if (opts.optOutWhatsApp) {
          await prisma.notificationPreference.create({
            data: {
              userId: user.id,
              channel: "WHATSAPP",
              enabled: false,
            },
          });
        }
        const patient = await prisma.patient.create({
          data: {
            userId: user.id,
            mrNumber: `MR-CDS-${ts}-${idx}`,
            gender,
            tenantId,
          },
        });
        return { user, patient };
      }

      const m = await seedPatient("FEMALE", 1);
      patientMatchUserId = m.user.id;
      patientMatchId = m.patient.id;

      const nm = await seedPatient("MALE", 2);
      patientNonMatchId = nm.patient.id;

      const oo = await seedPatient("FEMALE", 3, { optOutWhatsApp: true });
      patientOptedOutId = oo.patient.id;

      const audience = await prisma.campaignAudience.create({
        data: {
          tenantId,
          name: "CDS — females",
          rules: {
            filters: [{ field: "gender", op: "eq", value: "FEMALE" }],
            matchMode: "ALL",
          },
        },
      });
      audienceId = audience.id;
    });

    it("sweeps a due SCHEDULED campaign, writes CampaignSend rows, flips to COMPLETED", async () => {
      const prisma = await getPrisma();
      const now = new Date();

      const campaign = await prisma.campaign.create({
        data: {
          tenantId,
          name: "CDS happy-path",
          status: "SCHEDULED",
          kind: "BROADCAST",
          channels: ["WHATSAPP"],
          body: "Hi {{patient.firstName}}, time for your check-up.",
          audienceId,
          scheduledAt: new Date(now.getTime() - 60_000), // 1 min ago → due
        },
      });

      const summary = await dispatchPendingCampaigns(prisma, { now });

      expect(summary.inspected).toBeGreaterThanOrEqual(1);
      expect(summary.dispatched).toBeGreaterThanOrEqual(1);
      expect(summary.errors).toBe(0);

      const refreshed = await prisma.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(refreshed?.status).toBe("COMPLETED");
      expect(refreshed?.completedAt).not.toBeNull();

      const sends = await prisma.campaignSend.findMany({
        where: { campaignId: campaign.id },
        orderBy: { createdAt: "asc" },
      });
      // 2 rows expected: matching patient (SENT) + opted-out patient
      // (SUPPRESSED); non-match excluded by the audience filter.
      expect(sends).toHaveLength(2);
      const byPatient = new Map<string, any>(
        sends.map((s: any) => [s.patientId, s]),
      );
      const sent: any = byPatient.get(patientMatchId);
      const suppressed: any = byPatient.get(patientOptedOutId);
      expect(sent?.status).toBe("SENT");
      expect(sent?.sentAt).not.toBeNull();
      expect(suppressed?.status).toBe("SUPPRESSED");
      // Non-match must NOT have a send row.
      expect(byPatient.has(patientNonMatchId)).toBe(false);

      void patientMatchUserId; // referenced for documentation clarity
    });

    it("defers a campaign whose send-window does NOT contain `now` (quiet-hour clamp)", async () => {
      const prisma = await getPrisma();

      // sendWindow 22:00 → 06:00 IST. Pick a `now` whose IST minute-of-day
      // falls outside that window (14:00 IST = 08:30 UTC).
      const now = new Date(Date.UTC(2026, 4, 15, 8, 30, 0)); // 14:00 IST

      const campaign = await prisma.campaign.create({
        data: {
          tenantId,
          name: "CDS quiet-hour test",
          status: "SCHEDULED",
          kind: "BROADCAST",
          channels: ["WHATSAPP"],
          body: "Quiet-hour message",
          audienceId,
          scheduledAt: new Date(now.getTime() - 60_000),
          sendWindowStart: 22 * 60, // 22:00 IST
          sendWindowEnd: 6 * 60, // 06:00 IST  — but our isWithinSendWindow
          // treats start>=end as a window that never contains 14:00; the
          // helper does `mod >= start && mod < end`, which for [1320, 360)
          // is false for mod=840 (14:00). So the clamp triggers as
          // intended.
        },
      });

      const summary = await dispatchPendingCampaigns(prisma, { now });

      expect(summary.deferredQuietHours).toBeGreaterThanOrEqual(1);

      const refreshed = await prisma.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(refreshed?.status).toBe("SCHEDULED");
      expect(refreshed?.startedAt).toBeNull();

      const sends = await prisma.campaignSend.findMany({
        where: { campaignId: campaign.id },
      });
      expect(sends).toHaveLength(0);
    });

    it("substitutes {{patient.firstName}} before handing to the channel adapter", async () => {
      const prisma = await getPrisma();
      const now = new Date();
      const lengthBefore = whatsappCalls.length;

      const campaign = await prisma.campaign.create({
        data: {
          tenantId,
          name: "CDS token-sub test",
          status: "SCHEDULED",
          kind: "BROADCAST",
          channels: ["WHATSAPP"],
          body: "Hi {{patient.firstName}}, this is a token-substitution probe.",
          audienceId,
          scheduledAt: new Date(now.getTime() - 60_000),
        },
      });

      await dispatchPendingCampaigns(prisma, { now });

      // The matching FEMALE-1 patient name is "Cds FEMALE1 Patient" → first
      // word "Cds". The captured call must show "Hi Cds, ..." with the
      // moustache resolved.
      const matchingCalls = whatsappCalls
        .slice(lengthBefore)
        .filter((c) => c.text.includes("token-substitution probe"));
      expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
      const renderedBody = matchingCalls[0].text;
      expect(renderedBody).toContain("Hi Cds,");
      // And critically — no raw moustache survived the substitution.
      expect(renderedBody).not.toContain("{{patient.firstName}}");

      // Ensure this campaign moved to COMPLETED (we used the real fan-out).
      const refreshed = await prisma.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(refreshed?.status).toBe("COMPLETED");
    });

    it("cancels a due SCHEDULED campaign that has no audience attached", async () => {
      const prisma = await getPrisma();
      const now = new Date();

      const campaign = await prisma.campaign.create({
        data: {
          tenantId,
          name: "CDS no-audience guard",
          status: "SCHEDULED",
          kind: "BROADCAST",
          channels: ["WHATSAPP"],
          body: "Should never send",
          audienceId: null,
          scheduledAt: new Date(now.getTime() - 60_000),
        },
      });

      const summary = await dispatchPendingCampaigns(prisma, { now });

      expect(summary.cancelledNoAudience).toBeGreaterThanOrEqual(1);

      const refreshed = await prisma.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(refreshed?.status).toBe("CANCELLED");
      expect(refreshed?.cancelReason).toContain("no audience");

      const sends = await prisma.campaignSend.findMany({
        where: { campaignId: campaign.id },
      });
      expect(sends).toHaveLength(0);

      void patientNonMatchId; // suppress unused-warning when this test is skipped
    });
  },
);
