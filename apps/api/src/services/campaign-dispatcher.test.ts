// Unit tests for `dispatchCampaign` — the main fan-out function in
// `campaign-dispatcher.ts`. The pure helpers (`substituteTemplate`,
// `pickVariant`, `buildClickUrl`, send-window math, A/B parser) are
// covered by `campaign-dispatcher.pure.test.ts`; the sweep worker is
// covered by `campaign-dispatcher-sweep.test.ts`. This file closes the
// remaining gap on the fan-out loop itself: audience load, per-recipient
// + per-channel CampaignSend row creation, opt-out suppression,
// address-missing suppression, A/B variant pick, channel adapter call,
// status promotion, and DispatchSummary rollup.
//
// All four channel adapters + the audience compiler are mocked at the
// import boundary. Prisma is replaced by a hand-rolled minimal in-memory
// stub — no DB required.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./audience-compiler", () => ({
  compileAudience: vi.fn(() => ({})),
}));
vi.mock("./channels/whatsapp", () => ({
  sendWhatsApp: vi.fn(),
}));
vi.mock("./channels/sms", () => ({
  sendSMS: vi.fn(),
}));
vi.mock("./channels/email", () => ({
  sendEmail: vi.fn(),
}));
vi.mock("./channels/push", () => ({
  sendPush: vi.fn(),
}));

import { dispatchCampaign } from "./campaign-dispatcher";
import { compileAudience } from "./audience-compiler";
import { sendWhatsApp } from "./channels/whatsapp";
import { sendSMS } from "./channels/sms";
import { sendEmail } from "./channels/email";
import { sendPush } from "./channels/push";

const compileAudienceMock = vi.mocked(compileAudience);
const sendWhatsAppMock = vi.mocked(sendWhatsApp);
const sendSMSMock = vi.mocked(sendSMS);
const sendEmailMock = vi.mocked(sendEmail);
const sendPushMock = vi.mocked(sendPush);

interface FakeUser {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  pushToken: string | null;
  notificationPreferences: { channel: string; enabled: boolean }[];
}

interface FakePatient {
  id: string;
  mrNumber: string;
  user: FakveUser | null;
}

// typo guard: ensure neither type names collide.
type FakveUser = FakeUser;

interface FakeCampaign {
  id: string;
  tenantId: string;
  body: string;
  subject: string | null;
  channels: string[];
  abVariants: unknown;
  audience: { id: string; rules: unknown } | null;
  tenant: { name: string } | null;
}

interface CampaignSendRow {
  id: string;
  campaignId: string;
  tenantId: string;
  patientId: string;
  channel: string;
  variantId: string | null;
  status: string;
  failureReason?: string | null;
  sentAt?: Date | null;
  failedAt?: Date | null;
}

let sendIdCounter = 0;

function makePrismaMock(campaign: FakeCampaign | null, patients: FakePatient[]) {
  const sends: CampaignSendRow[] = [];
  return {
    sends,
    campaign: {
      findFirst: vi.fn().mockResolvedValue(campaign),
    },
    patient: {
      findMany: vi.fn().mockResolvedValue(patients),
    },
    campaignSend: {
      create: vi.fn(async (args: { data: Omit<CampaignSendRow, "id"> }) => {
        const row: CampaignSendRow = {
          id: `send-${++sendIdCounter}`,
          ...args.data,
        };
        sends.push(row);
        return row;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Partial<CampaignSendRow>;
        }) => {
          const row = sends.find((s) => s.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row ?? null;
        },
      ),
    },
  };
}

type PrismaMock = ReturnType<typeof makePrismaMock>;
// dispatchCampaign accepts a PrismaClient at runtime; we cast through unknown
// to keep the test focused on observable behaviour.
function asPrisma(mock: PrismaMock): Parameters<typeof dispatchCampaign>[0] {
  return mock as unknown as Parameters<typeof dispatchCampaign>[0];
}

function mkPatient(over: Partial<FakePatient> & { id: string }): FakePatient {
  return {
    mrNumber: `MR-${over.id}`,
    user: {
      id: `u-${over.id}`,
      name: "Asha Sharma",
      phone: "+919999999999",
      email: "asha@example.com",
      pushToken: "expo-token-1",
      notificationPreferences: [],
    },
    ...over,
  };
}

function mkCampaign(over: Partial<FakeCampaign> = {}): FakeCampaign {
  return {
    id: "camp-1",
    tenantId: "tenant-1",
    body: "Hello {{patient.firstName}}, visit {{campaignClickUrl}}",
    subject: "Hi {{patient.firstName}}",
    channels: ["WHATSAPP"],
    abVariants: null,
    audience: { id: "aud-1", rules: { matchMode: "ALL", filters: [] } },
    tenant: { name: "Onviqa Demo Hospital" },
    ...over,
  };
}

beforeEach(() => {
  sendIdCounter = 0;
  compileAudienceMock.mockReset();
  compileAudienceMock.mockReturnValue({});
  sendWhatsAppMock.mockReset();
  sendSMSMock.mockReset();
  sendEmailMock.mockReset();
  sendPushMock.mockReset();
  // sane defaults — adapters succeed
  sendWhatsAppMock.mockResolvedValue({ ok: true, messageId: "wa-1" });
  sendSMSMock.mockResolvedValue({ ok: true, messageId: "sms-1" });
  sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" });
  sendPushMock.mockResolvedValue({ ok: true, messageId: "push-1" });
});

describe("dispatchCampaign — early-exit guards", () => {
  it("returns all-zero summary when campaign is not found", async () => {
    const prisma = makePrismaMock(null, []);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "missing",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 0, sent: 0, failed: 0, suppressed: 0 });
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
    expect(prisma.campaignSend.create).not.toHaveBeenCalled();
  });

  it("returns all-zero summary when campaign has no audience", async () => {
    const prisma = makePrismaMock(mkCampaign({ audience: null }), []);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 0, sent: 0, failed: 0, suppressed: 0 });
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });

  it("scopes the campaign lookup to tenantId", async () => {
    const prisma = makePrismaMock(mkCampaign(), []);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(prisma.campaign.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "camp-1", tenantId: "tenant-1" },
      }),
    );
  });

  it("calls compileAudience with the audience rules JSON", async () => {
    const prisma = makePrismaMock(
      mkCampaign({
        audience: { id: "aud-1", rules: { foo: "bar" } },
      }),
      [],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(compileAudienceMock).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("treats a null audience.rules as an empty rules object", async () => {
    const prisma = makePrismaMock(
      mkCampaign({
        // simulating a saved audience with no rules set
        audience: { id: "aud-1", rules: null as unknown as object },
      }),
      [],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(compileAudienceMock).toHaveBeenCalledWith({});
  });
});

describe("dispatchCampaign — happy path (single channel)", () => {
  it("creates one CampaignSend per recipient and promotes QUEUED → SENT", async () => {
    const prisma = makePrismaMock(mkCampaign(), [
      mkPatient({ id: "p1" }),
      mkPatient({ id: "p2" }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 2, sent: 2, failed: 0, suppressed: 0 });
    expect(prisma.campaignSend.create).toHaveBeenCalledTimes(2);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(2);
    // both rows ended in SENT
    expect(prisma.sends.every((s) => s.status === "SENT")).toBe(true);
    expect(prisma.sends.every((s) => s.sentAt instanceof Date)).toBe(true);
  });

  it("substitutes tokens (patient.firstName + campaignClickUrl) into the body sent to the adapter", async () => {
    const prisma = makePrismaMock(mkCampaign(), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "Bob Johnson",
          phone: "+91111",
          email: "b@b.co",
          pushToken: "tok",
          notificationPreferences: [],
        },
      }),
    ]);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    const [phone, body] = sendWhatsAppMock.mock.calls[0];
    expect(phone).toBe("+91111");
    expect(body).toContain("Hello Bob");
    expect(body).toContain("/public/campaigns/click/send-1");
  });

  it("scopes the audience patient query to tenantId via AND[compiled-where]", async () => {
    compileAudienceMock.mockReturnValue({ gender: "FEMALE" });
    const prisma = makePrismaMock(mkCampaign(), []);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-7",
    });
    expect(prisma.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-7", AND: [{ gender: "FEMALE" }] },
      }),
    );
  });

  it("skips patients with no `user` relation (FK-null safety)", async () => {
    const prisma = makePrismaMock(mkCampaign(), [
      mkPatient({ id: "ghost", user: null }),
      mkPatient({ id: "real" }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.total).toBe(1);
    expect(summary.sent).toBe(1);
    expect(prisma.campaignSend.create).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchCampaign — multi-channel fan-out", () => {
  it("creates one send row per (patient, channel)", async () => {
    const prisma = makePrismaMock(
      mkCampaign({ channels: ["WHATSAPP", "SMS", "EMAIL", "PUSH"] }),
      [mkPatient({ id: "p1" })],
    );
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.total).toBe(4);
    expect(summary.sent).toBe(4);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(sendSMSMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendPushMock).toHaveBeenCalledTimes(1);
  });

  it("invokes each adapter with the expected address arg", async () => {
    const prisma = makePrismaMock(
      mkCampaign({ channels: ["WHATSAPP", "SMS", "EMAIL", "PUSH"], subject: "Hello!" }),
      [
        mkPatient({
          id: "p1",
          user: {
            id: "u-p1",
            name: "Asha Sharma",
            phone: "+919876543210",
            email: "asha@example.com",
            pushToken: "expo-xyz",
            notificationPreferences: [],
          },
        }),
      ],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(sendWhatsAppMock.mock.calls[0][0]).toBe("+919876543210");
    expect(sendSMSMock.mock.calls[0][0]).toBe("+919876543210");
    const [emailTo, emailSubject] = sendEmailMock.mock.calls[0];
    expect(emailTo).toBe("asha@example.com");
    expect(emailSubject).toContain("Hello!");
    expect(sendPushMock.mock.calls[0][0]).toEqual(["expo-xyz"]);
  });
});

describe("dispatchCampaign — suppression paths", () => {
  it("suppresses when the patient has opted out of the channel", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["WHATSAPP"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "Asha",
          phone: "+91",
          email: "a@b.co",
          pushToken: null,
          notificationPreferences: [{ channel: "WHATSAPP", enabled: false }],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 1, sent: 0, failed: 0, suppressed: 1 });
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(prisma.sends[0].status).toBe("SUPPRESSED");
    expect(prisma.sends[0].failureReason).toMatch(/opted out/i);
  });

  it("does NOT suppress when the patient has the preference row but enabled=true", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["WHATSAPP"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "Asha",
          phone: "+91",
          email: "a@b.co",
          pushToken: null,
          notificationPreferences: [{ channel: "WHATSAPP", enabled: true }],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.sent).toBe(1);
    expect(summary.suppressed).toBe(0);
    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
  });

  it("treats a missing pref row as enabled (default-allow semantics)", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["SMS"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "X",
          phone: "+91",
          email: null,
          pushToken: null,
          // no prefs at all
          notificationPreferences: [],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.sent).toBe(1);
    expect(summary.suppressed).toBe(0);
  });

  it("suppresses (NOT fails) WHATSAPP when phone is missing", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["WHATSAPP"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "X",
          phone: null,
          email: "x@y.co",
          pushToken: null,
          notificationPreferences: [],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 1, sent: 0, failed: 0, suppressed: 1 });
    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(prisma.sends[0].status).toBe("SUPPRESSED");
    expect(prisma.sends[0].failureReason).toMatch(/no phone/i);
  });

  it("suppresses SMS when phone is missing", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["SMS"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "X",
          phone: null,
          email: null,
          pushToken: null,
          notificationPreferences: [],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.suppressed).toBe(1);
    expect(sendSMSMock).not.toHaveBeenCalled();
  });

  it("suppresses EMAIL when email is missing", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["EMAIL"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "X",
          phone: "+91",
          email: null,
          pushToken: null,
          notificationPreferences: [],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.suppressed).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("suppresses PUSH when pushToken is missing", async () => {
    const prisma = makePrismaMock(mkCampaign({ channels: ["PUSH"] }), [
      mkPatient({
        id: "p1",
        user: {
          id: "u-p1",
          name: "X",
          phone: "+91",
          email: "x@y.co",
          pushToken: null,
          notificationPreferences: [],
        },
      }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary.suppressed).toBe(1);
    expect(sendPushMock).not.toHaveBeenCalled();
  });
});

describe("dispatchCampaign — failure resilience", () => {
  it("marks FAILED when the channel adapter returns ok:false (non-address)", async () => {
    sendWhatsAppMock.mockResolvedValue({ ok: false, error: "HTTP 500" });
    const prisma = makePrismaMock(mkCampaign(), [mkPatient({ id: "p1" })]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 1, sent: 0, failed: 1, suppressed: 0 });
    expect(prisma.sends[0].status).toBe("FAILED");
    expect(prisma.sends[0].failureReason).toBe("HTTP 500");
    expect(prisma.sends[0].failedAt).toBeInstanceOf(Date);
  });

  it("falls back to 'channel adapter failed' when ok:false lacks an error string", async () => {
    sendWhatsAppMock.mockResolvedValue({ ok: false });
    const prisma = makePrismaMock(mkCampaign(), [mkPatient({ id: "p1" })]);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(prisma.sends[0].failureReason).toBe("channel adapter failed");
  });

  it("isolates failures across recipients — one failure does not stop the next send", async () => {
    sendWhatsAppMock
      .mockResolvedValueOnce({ ok: false, error: "first explodes" })
      .mockResolvedValueOnce({ ok: true, messageId: "ok-2" });
    const prisma = makePrismaMock(mkCampaign(), [
      mkPatient({ id: "p1" }),
      mkPatient({ id: "p2" }),
    ]);
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 2, sent: 1, failed: 1, suppressed: 0 });
  });

  it("rolls up mixed sent/failed/suppressed across one batch correctly", async () => {
    sendWhatsAppMock.mockImplementation(async (phone: string) => {
      if (phone === "+91-fail") return { ok: false, error: "x" };
      return { ok: true, messageId: "m" };
    });
    const prisma = makePrismaMock(
      mkCampaign({ channels: ["WHATSAPP"] }),
      [
        mkPatient({
          id: "p-sent",
          user: {
            id: "u",
            name: "Sent",
            phone: "+91-ok",
            email: "s@x",
            pushToken: null,
            notificationPreferences: [],
          },
        }),
        mkPatient({
          id: "p-fail",
          user: {
            id: "u",
            name: "Fail",
            phone: "+91-fail",
            email: "f@x",
            pushToken: null,
            notificationPreferences: [],
          },
        }),
        mkPatient({
          id: "p-suppress",
          user: {
            id: "u",
            name: "Sup",
            phone: "+91-sup",
            email: "s2@x",
            pushToken: null,
            notificationPreferences: [{ channel: "WHATSAPP", enabled: false }],
          },
        }),
        mkPatient({
          id: "p-noaddr",
          user: {
            id: "u",
            name: "NoAddr",
            phone: null,
            email: null,
            pushToken: null,
            notificationPreferences: [],
          },
        }),
      ],
    );
    const summary = await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(summary).toEqual({ total: 4, sent: 1, failed: 1, suppressed: 2 });
  });
});

describe("dispatchCampaign — A/B variant resolution", () => {
  it("picks a variant per recipient and persists variantId on the send row", async () => {
    const prisma = makePrismaMock(
      mkCampaign({
        abVariants: [
          {
            id: "VA",
            weight: 1,
            subjectOverride: "Subj A",
            bodyOverride: "Body A {{patient.firstName}}",
          },
        ],
      }),
      [mkPatient({ id: "p1" })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(prisma.sends[0].variantId).toBe("VA");
    // The overridden body was substituted, not the campaign default
    const [, body] = sendWhatsAppMock.mock.calls[0];
    expect(body).toContain("Body A Asha");
  });

  it("uses null variantId when no abVariants are configured", async () => {
    const prisma = makePrismaMock(mkCampaign({ abVariants: null }), [
      mkPatient({ id: "p1" }),
    ]);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(prisma.sends[0].variantId).toBeNull();
  });

  it("uses the same variant across channels for one recipient", async () => {
    // single variant → deterministic pick
    const prisma = makePrismaMock(
      mkCampaign({
        channels: ["WHATSAPP", "SMS"],
        abVariants: [{ id: "ONLY", weight: 1 }],
      }),
      [mkPatient({ id: "p1" })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(prisma.sends).toHaveLength(2);
    expect(prisma.sends[0].variantId).toBe("ONLY");
    expect(prisma.sends[1].variantId).toBe("ONLY");
  });
});

describe("dispatchCampaign — token context edge cases", () => {
  it("handles a single-word patient name (lastName falls back to empty)", async () => {
    const prisma = makePrismaMock(
      mkCampaign({
        body: "Hi {{patient.firstName}}|{{patient.lastName}}|{{patient.fullName}}",
      }),
      [
        mkPatient({
          id: "p1",
          user: {
            id: "u",
            name: "Madonna",
            phone: "+91",
            email: "m@x.co",
            pushToken: null,
            notificationPreferences: [],
          },
        }),
      ],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, body] = sendWhatsAppMock.mock.calls[0];
    expect(body).toBe("Hi Madonna||Madonna");
  });

  it("uses empty tenant name when tenant relation is null", async () => {
    const prisma = makePrismaMock(
      mkCampaign({
        tenant: null,
        body: "From [{{tenant.name}}]",
      }),
      [mkPatient({ id: "p1" })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, body] = sendWhatsAppMock.mock.calls[0];
    expect(body).toBe("From []");
  });

  it("falls back to empty mrNumber when patient.mrNumber is null", async () => {
    const prisma = makePrismaMock(
      mkCampaign({ body: "MR: [{{patient.mrNumber}}]" }),
      [mkPatient({ id: "p1", mrNumber: null as unknown as string })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, body] = sendWhatsAppMock.mock.calls[0];
    expect(body).toBe("MR: []");
  });

  it("substitutes a non-null subject for EMAIL when configured", async () => {
    const prisma = makePrismaMock(
      mkCampaign({
        channels: ["EMAIL"],
        subject: "Hello {{patient.firstName}}",
      }),
      [mkPatient({ id: "p1" })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, subject] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Hello Asha");
  });

  it("uses the default 'Message' subject for EMAIL when campaign.subject is null", async () => {
    const prisma = makePrismaMock(
      mkCampaign({ channels: ["EMAIL"], subject: null }),
      [mkPatient({ id: "p1" })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, subject] = sendEmailMock.mock.calls[0];
    expect(subject).toBe("Message");
  });

  it("uses the default 'MedCore' title for PUSH when campaign.subject is null", async () => {
    const prisma = makePrismaMock(
      mkCampaign({ channels: ["PUSH"], subject: null }),
      [mkPatient({ id: "p1" })],
    );
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, title] = sendPushMock.mock.calls[0];
    expect(title).toBe("MedCore");
  });
});

describe("dispatchCampaign — CampaignSend row contract", () => {
  it("creates the row with QUEUED status BEFORE invoking the channel adapter", async () => {
    // We assert by inspecting the create-call args (not the post-update state).
    const prisma = makePrismaMock(mkCampaign(), [mkPatient({ id: "p1" })]);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    expect(prisma.campaignSend.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campaignId: "camp-1",
        tenantId: "tenant-1",
        patientId: "p1",
        channel: "WHATSAPP",
        variantId: null,
        status: "QUEUED",
      }),
    });
  });

  it("includes the send.id in the click URL the adapter receives", async () => {
    const prisma = makePrismaMock(mkCampaign(), [mkPatient({ id: "p1" })]);
    await dispatchCampaign(asPrisma(prisma), {
      campaignId: "camp-1",
      tenantId: "tenant-1",
    });
    const [, body] = sendWhatsAppMock.mock.calls[0];
    expect(body).toContain("send-1");
  });
});
