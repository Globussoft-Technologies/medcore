import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    aITriageSession: {
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    aIScribeSession: {
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  recordConsent,
  checkConsent,
  revokeConsent,
  getConsentHistory,
} from "./consent";

beforeEach(() => {
  prismaMock.aITriageSession.update.mockReset();
  prismaMock.aITriageSession.findUnique.mockReset();
  prismaMock.aITriageSession.findMany.mockReset();
  prismaMock.aIScribeSession.update.mockReset();
  prismaMock.aIScribeSession.findUnique.mockReset();
  prismaMock.aIScribeSession.findMany.mockReset();
});

describe("recordConsent", () => {
  it("updates triage session with consentGiven and timestamp when granted", async () => {
    prismaMock.aITriageSession.update.mockResolvedValue({});
    await recordConsent("TRIAGE", "t1", true);
    const args = prismaMock.aITriageSession.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: "t1" });
    expect(args.data.consentGiven).toBe(true);
    expect(args.data.consentAt).toBeInstanceOf(Date);
  });

  it("clears timestamp when consent is denied", async () => {
    prismaMock.aITriageSession.update.mockResolvedValue({});
    await recordConsent("TRIAGE", "t1", false);
    const args = prismaMock.aITriageSession.update.mock.calls[0][0];
    expect(args.data.consentGiven).toBe(false);
    expect(args.data.consentAt).toBeNull();
  });

  it("uses aIScribeSession with consentObtained field for SCRIBE", async () => {
    prismaMock.aIScribeSession.update.mockResolvedValue({});
    await recordConsent("SCRIBE", "s1", true);
    const args = prismaMock.aIScribeSession.update.mock.calls[0][0];
    expect(args.data.consentObtained).toBe(true);
    expect(args.data.consentAt).toBeInstanceOf(Date);
  });
});

describe("checkConsent", () => {
  it("returns hasConsent=true when triage session is ACTIVE and consentGiven=true", async () => {
    const consentAt = new Date("2026-04-23T10:00:00Z");
    prismaMock.aITriageSession.findUnique.mockResolvedValue({
      consentGiven: true,
      consentAt,
      status: "ACTIVE",
    });
    const res = await checkConsent("TRIAGE", "t1");
    expect(res.hasConsent).toBe(true);
    expect(res.consentAt).toEqual(consentAt);
  });

  it("returns hasConsent=false for missing session", async () => {
    prismaMock.aITriageSession.findUnique.mockResolvedValue(null);
    const res = await checkConsent("TRIAGE", "ghost");
    expect(res.hasConsent).toBe(false);
    expect(res.consentAt).toBeNull();
  });

  it("returns hasConsent=false when session is ABANDONED despite consentGiven", async () => {
    prismaMock.aITriageSession.findUnique.mockResolvedValue({
      consentGiven: true,
      consentAt: new Date(),
      status: "ABANDONED",
    });
    const res = await checkConsent("TRIAGE", "t1");
    expect(res.hasConsent).toBe(false);
  });

  it("checks SCRIBE sessions via consentObtained flag", async () => {
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      consentObtained: true,
      consentAt: new Date(),
      status: "ACTIVE",
    });
    const res = await checkConsent("SCRIBE", "s1");
    expect(res.hasConsent).toBe(true);
  });
});

describe("revokeConsent", () => {
  it("sets triage session status to ABANDONED", async () => {
    prismaMock.aITriageSession.update.mockResolvedValue({});
    await revokeConsent("TRIAGE", "t1");
    const args = prismaMock.aITriageSession.update.mock.calls[0][0];
    expect(args.data.status).toBe("ABANDONED");
  });

  it("sets scribe session status to CONSENT_WITHDRAWN and clears transcript", async () => {
    prismaMock.aIScribeSession.update.mockResolvedValue({});
    await revokeConsent("SCRIBE", "s1");
    const args = prismaMock.aIScribeSession.update.mock.calls[0][0];
    expect(args.data.status).toBe("CONSENT_WITHDRAWN");
    expect(args.data.transcript).toEqual([]);
  });
});

describe("getConsentHistory", () => {
  it("merges triage and scribe sessions and sorts by consentAt desc", async () => {
    const early = new Date("2026-01-01T00:00:00Z");
    const mid = new Date("2026-02-01T00:00:00Z");
    const late = new Date("2026-04-01T00:00:00Z");

    prismaMock.aITriageSession.findMany.mockResolvedValue([
      {
        id: "t1",
        patientId: "p1",
        consentGiven: true,
        consentAt: early,
        status: "COMPLETED",
      },
      {
        id: "t2",
        patientId: "p1",
        consentGiven: false,
        consentAt: null,
        status: "ABANDONED",
      },
    ]);
    prismaMock.aIScribeSession.findMany.mockResolvedValue([
      {
        id: "s1",
        patientId: "p1",
        consentObtained: true,
        consentAt: late,
        status: "CONSENT_WITHDRAWN",
      },
      {
        id: "s2",
        patientId: "p1",
        consentObtained: true,
        consentAt: mid,
        status: "ACTIVE",
      },
    ]);

    const history = await getConsentHistory("p1");
    expect(history).toHaveLength(4);
    // Sorted late → mid → early → null
    expect(history[0].sessionId).toBe("s1");
    expect(history[1].sessionId).toBe("s2");
    expect(history[2].sessionId).toBe("t1");
    expect(history[3].sessionId).toBe("t2");

    // Status mapping
    const s1 = history.find((h) => h.sessionId === "s1")!;
    expect(s1.status).toBe("WITHDRAWN");
    const s2 = history.find((h) => h.sessionId === "s2")!;
    expect(s2.status).toBe("ACTIVE");
    const t1 = history.find((h) => h.sessionId === "t1")!;
    expect(t1.status).toBe("COMPLETED");
    const t2 = history.find((h) => h.sessionId === "t2")!;
    expect(t2.status).toBe("WITHDRAWN");
  });

  it("returns empty array when patient has no sessions", async () => {
    prismaMock.aITriageSession.findMany.mockResolvedValue([]);
    prismaMock.aIScribeSession.findMany.mockResolvedValue([]);
    const history = await getConsentHistory("p-none");
    expect(history).toEqual([]);
  });
});
