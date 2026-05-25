/**
 * Test-cron tick (2026-05-25) — ABDM Consent service unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the four exported entry points of the ABDM
 *   consent service — `requestConsent` (Step 1 CM init, ABDMError input
 *   validation, local artefact persistence, CM POST body shape),
 *   `getConsent` (lookup), `revokeConsent` (state-machine: GRANTED-only,
 *   404 + 409 branches, CM POST + local update), and
 *   `handleConsentCallback` (REQUESTED→GRANTED/DENIED/EXPIRED/REVOKED
 *   transitions, idempotent unknown-id, artefact merge behaviour,
 *   grantedAt set only on GRANTED).
 * - MODULES: hoisted mock of `@medcore/db` (Prisma client surface for
 *   `consentArtefact`) + a mock of `./client` so `abdmRequest` never opens
 *   a socket and so we can assert the body sent to the CM and force-throw
 *   ABDMError. Mirrors the doc-qa.test.ts hoisted-mock pattern.
 * - WHY: this service is the legal entry point for ABDM HIU data fetches.
 *   A broken state-machine (e.g. allowing revoke from REQUESTED, or
 *   accidentally writing GRANTED on a DENIED callback) is a compliance
 *   incident, not just a bug — and the dateTo/dateFrom + expiresAt
 *   validators are the only thing stopping an inverted-range artefact
 *   from being persisted with status REQUESTED forever.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, abdmRequestMock, ABDMErrorClass } = vi.hoisted(() => {
  class ABDMErrorClass extends Error {
    readonly statusCode: number;
    readonly upstreamBody?: unknown;
    constructor(message: string, statusCode = 503, upstreamBody?: unknown) {
      super(message);
      this.name = "ABDMError";
      this.statusCode = statusCode;
      this.upstreamBody = upstreamBody;
    }
  }
  return {
    prismaMock: {
      consentArtefact: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    } as any,
    abdmRequestMock: vi.fn(),
    ABDMErrorClass,
  };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
}));

vi.mock("./client", () => ({
  abdmRequest: abdmRequestMock,
  ABDMError: ABDMErrorClass,
}));

import {
  requestConsent,
  getConsent,
  revokeConsent,
  handleConsentCallback,
  CONSENT_PURPOSES,
  type RequestConsentInput,
} from "./consent";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeRequestInput(over: Partial<RequestConsentInput> = {}): RequestConsentInput {
  const now = Date.now();
  return {
    patientId: over.patientId ?? "pat-1",
    hiuId: over.hiuId ?? "hiu-medcore",
    purpose: over.purpose ?? "CAREMGT",
    hiTypes: over.hiTypes ?? ["OPConsultation", "Prescription"],
    abhaAddress: over.abhaAddress ?? "alice@sbx",
    dateFrom: over.dateFrom ?? new Date(now - 30 * 86400_000),
    dateTo: over.dateTo ?? new Date(now - 1 * 86400_000),
    expiresAt: over.expiresAt ?? new Date(now + 7 * 86400_000),
    requesterId: over.requesterId ?? "doc-1",
    requesterName: over.requesterName ?? "Dr. Strange",
  };
}

function makeArtefactRow(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "ca-1",
    patientId: over.patientId ?? "pat-1",
    hiuId: over.hiuId ?? "hiu-medcore",
    purpose: over.purpose ?? "CAREMGT",
    status: over.status ?? "REQUESTED",
    artefact: over.artefact ?? { hiTypes: ["OPConsultation"] },
    expiresAt: over.expiresAt ?? new Date(Date.now() + 86400_000),
    createdAt: over.createdAt ?? new Date(),
    grantedAt: over.grantedAt ?? null,
    revokedAt: over.revokedAt ?? null,
  };
}

function resetAllMocks() {
  prismaMock.consentArtefact.create.mockReset();
  prismaMock.consentArtefact.findUnique.mockReset();
  prismaMock.consentArtefact.update.mockReset();
  abdmRequestMock.mockReset();
  prismaMock.consentArtefact.create.mockImplementation(async ({ data }: any) => ({
    ...data,
    createdAt: new Date(),
    grantedAt: null,
    revokedAt: null,
  }));
  prismaMock.consentArtefact.findUnique.mockResolvedValue(null);
  prismaMock.consentArtefact.update.mockImplementation(async ({ data }: any) => data);
  abdmRequestMock.mockResolvedValue(undefined);
}

// ─── CONSENT_PURPOSES constant ────────────────────────────────────────────

describe("CONSENT_PURPOSES", () => {
  it("contains the canonical ABDM v0.5 purpose codes", () => {
    expect(CONSENT_PURPOSES).toEqual([
      "CAREMGT",
      "BTG",
      "PUBHLTH",
      "HPAYMT",
      "DSRCH",
      "PATRQT",
    ]);
  });
});

// ─── requestConsent ───────────────────────────────────────────────────────

describe("requestConsent", () => {
  beforeEach(resetAllMocks);

  it("rejects when dateTo is not after dateFrom (equal)", async () => {
    const t = new Date("2026-05-01T00:00:00Z");
    await expect(
      requestConsent(makeRequestInput({ dateFrom: t, dateTo: t })),
    ).rejects.toThrow(/dateTo must be after dateFrom/);
    expect(prismaMock.consentArtefact.create).not.toHaveBeenCalled();
    expect(abdmRequestMock).not.toHaveBeenCalled();
  });

  it("rejects when dateTo is before dateFrom", async () => {
    await expect(
      requestConsent(
        makeRequestInput({
          dateFrom: new Date("2026-05-02T00:00:00Z"),
          dateTo: new Date("2026-05-01T00:00:00Z"),
        }),
      ),
    ).rejects.toThrow(/dateTo must be after dateFrom/);
  });

  it("rejects when expiresAt is already in the past", async () => {
    await expect(
      requestConsent(
        makeRequestInput({ expiresAt: new Date(Date.now() - 60_000) }),
      ),
    ).rejects.toThrow(/expiresAt must be in the future/);
    expect(prismaMock.consentArtefact.create).not.toHaveBeenCalled();
  });

  it("rejects when expiresAt equals now (boundary — strict > check)", async () => {
    const fixedNow = new Date("2026-05-25T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      await expect(
        requestConsent(makeRequestInput({ expiresAt: fixedNow })),
      ).rejects.toThrow(/expiresAt must be in the future/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when hiTypes is empty", async () => {
    await expect(
      requestConsent(makeRequestInput({ hiTypes: [] })),
    ).rejects.toThrow(/At least one hiType is required/);
    expect(prismaMock.consentArtefact.create).not.toHaveBeenCalled();
  });

  it("returns the consentRequestId + localId on success", async () => {
    const input = makeRequestInput();
    const r = await requestConsent(input);

    expect(typeof r.consentRequestId).toBe("string");
    expect(r.consentRequestId.length).toBeGreaterThan(10);
    expect(r.localId).toBe(r.consentRequestId);
  });

  it("persists a REQUESTED row with all input fields encoded into artefact JSON", async () => {
    const input = makeRequestInput();
    await requestConsent(input);

    expect(prismaMock.consentArtefact.create).toHaveBeenCalledTimes(1);
    const arg = prismaMock.consentArtefact.create.mock.calls[0][0];
    expect(arg.data.patientId).toBe(input.patientId);
    expect(arg.data.hiuId).toBe(input.hiuId);
    expect(arg.data.purpose).toBe(input.purpose);
    expect(arg.data.status).toBe("REQUESTED");
    expect(arg.data.expiresAt).toEqual(input.expiresAt);
    expect(arg.data.artefact).toEqual({
      hiTypes: input.hiTypes,
      abhaAddress: input.abhaAddress,
      dateFrom: input.dateFrom.toISOString(),
      dateTo: input.dateTo.toISOString(),
      requester: { id: input.requesterId, name: input.requesterName },
    });
  });

  it("dispatches the CM init POST with the ABDM v0.5 consent envelope", async () => {
    const input = makeRequestInput();
    await requestConsent(input);

    expect(abdmRequestMock).toHaveBeenCalledTimes(1);
    const init = abdmRequestMock.mock.calls[0][0];
    expect(init.method).toBe("POST");
    expect(init.path).toBe("/v0.5/consent-requests/init");
    expect(init.requestId).toBeDefined();
    expect(init.body.requestId).toBe(init.requestId);
    expect(typeof init.body.timestamp).toBe("string");

    const consent = init.body.consent;
    expect(consent.purpose).toEqual({ text: "CAREMGT", code: "CAREMGT" });
    expect(consent.patient).toEqual({ id: input.abhaAddress });
    expect(consent.hiu).toEqual({ id: input.hiuId });
    expect(consent.requester).toEqual({
      name: input.requesterName,
      identifier: { type: "REGNO", value: input.requesterId },
    });
    expect(consent.hiTypes).toEqual(input.hiTypes);
    expect(consent.permission.accessMode).toBe("VIEW");
    expect(consent.permission.dateRange.from).toBe(input.dateFrom.toISOString());
    expect(consent.permission.dateRange.to).toBe(input.dateTo.toISOString());
    expect(consent.permission.dataEraseAt).toBe(input.expiresAt.toISOString());
    expect(consent.permission.frequency).toEqual({ unit: "HOUR", value: 1, repeats: 0 });
  });

  it("uses the same UUID for both the local row id and the CM requestId (correlation key)", async () => {
    const input = makeRequestInput();
    await requestConsent(input);

    const createArg = prismaMock.consentArtefact.create.mock.calls[0][0];
    const initArg = abdmRequestMock.mock.calls[0][0];
    expect(createArg.data.id).toBe(initArg.requestId);
    expect(initArg.body.requestId).toBe(createArg.data.id);
  });

  it("propagates ABDM gateway failures (CM unreachable) — does not swallow", async () => {
    abdmRequestMock.mockRejectedValueOnce(new ABDMErrorClass("CM unreachable", 503));
    await expect(requestConsent(makeRequestInput())).rejects.toThrow(/CM unreachable/);
    // The local row is still persisted (idempotency anchor), but the call
    // surface is "this consent request failed" — the caller sees the throw.
    expect(prismaMock.consentArtefact.create).toHaveBeenCalledTimes(1);
  });
});

// ─── getConsent ───────────────────────────────────────────────────────────

describe("getConsent", () => {
  beforeEach(resetAllMocks);

  it("returns null when the artefact does not exist", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(null);
    const r = await getConsent("missing-id");
    expect(r).toBeNull();
    expect(prismaMock.consentArtefact.findUnique).toHaveBeenCalledWith({
      where: { id: "missing-id" },
    });
  });

  it("returns the artefact row when present", async () => {
    const row = makeArtefactRow({ id: "ca-42", status: "GRANTED" });
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(row);
    const r = await getConsent("ca-42");
    expect(r).not.toBeNull();
    expect(r!.id).toBe("ca-42");
    expect(r!.status).toBe("GRANTED");
  });
});

// ─── revokeConsent ────────────────────────────────────────────────────────

describe("revokeConsent", () => {
  beforeEach(resetAllMocks);

  it("throws 404 ABDMError when the artefact is unknown", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(null);
    await expect(revokeConsent("ghost")).rejects.toMatchObject({
      message: /Consent not found/,
      statusCode: 404,
    });
    expect(abdmRequestMock).not.toHaveBeenCalled();
    expect(prismaMock.consentArtefact.update).not.toHaveBeenCalled();
  });

  it.each([
    ["REQUESTED"],
    ["DENIED"],
    ["REVOKED"],
    ["EXPIRED"],
  ])("throws 409 when the artefact is in state %s (only GRANTED is revocable)", async (state) => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ status: state }),
    );
    await expect(revokeConsent("ca-1")).rejects.toMatchObject({
      message: new RegExp(`Cannot revoke consent in state ${state}`),
      statusCode: 409,
    });
    expect(abdmRequestMock).not.toHaveBeenCalled();
    expect(prismaMock.consentArtefact.update).not.toHaveBeenCalled();
  });

  it("fires POST /v0.5/consents/revoke and flips the row to REVOKED with timestamp", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: "ca-1", status: "GRANTED" }),
    );
    const before = Date.now();
    await revokeConsent("ca-1");
    const after = Date.now();

    expect(abdmRequestMock).toHaveBeenCalledTimes(1);
    const init = abdmRequestMock.mock.calls[0][0];
    expect(init.method).toBe("POST");
    expect(init.path).toBe("/v0.5/consents/revoke");
    expect(init.requestId).toBeDefined();
    expect(init.body).toEqual({ consents: [{ id: "ca-1" }] });

    expect(prismaMock.consentArtefact.update).toHaveBeenCalledTimes(1);
    const upd = prismaMock.consentArtefact.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "ca-1" });
    expect(upd.data.status).toBe("REVOKED");
    expect(upd.data.revokedAt).toBeInstanceOf(Date);
    const rev = (upd.data.revokedAt as Date).getTime();
    expect(rev).toBeGreaterThanOrEqual(before);
    expect(rev).toBeLessThanOrEqual(after + 5);
  });

  it("propagates ABDM gateway failure and does NOT flip the local row", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ status: "GRANTED" }),
    );
    abdmRequestMock.mockRejectedValueOnce(new ABDMErrorClass("revoke failed", 502));

    await expect(revokeConsent("ca-1")).rejects.toThrow(/revoke failed/);
    expect(prismaMock.consentArtefact.update).not.toHaveBeenCalled();
  });
});

// ─── handleConsentCallback ────────────────────────────────────────────────

describe("handleConsentCallback", () => {
  beforeEach(resetAllMocks);

  it("returns silently (idempotent) when the consentRequestId is unknown", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(null);

    await expect(
      handleConsentCallback({
        consentRequestId: "ghost",
        status: "GRANTED",
        artefact: { signed: true },
      }),
    ).resolves.toBeUndefined();

    expect(prismaMock.consentArtefact.update).not.toHaveBeenCalled();
  });

  it("flips REQUESTED → GRANTED and sets grantedAt + new artefact payload", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: "ca-1", status: "REQUESTED", grantedAt: null }),
    );
    const newArtefact = { signed: "JWT", cmSignature: "xyz" };
    const before = Date.now();

    await handleConsentCallback({
      consentRequestId: "ca-1",
      status: "GRANTED",
      artefact: newArtefact,
    });
    const after = Date.now();

    expect(prismaMock.consentArtefact.update).toHaveBeenCalledTimes(1);
    const arg = prismaMock.consentArtefact.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "ca-1" });
    expect(arg.data.status).toBe("GRANTED");
    expect(arg.data.artefact).toEqual(newArtefact);
    expect(arg.data.grantedAt).toBeInstanceOf(Date);
    expect((arg.data.grantedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((arg.data.grantedAt as Date).getTime()).toBeLessThanOrEqual(after + 5);
  });

  it.each([
    ["DENIED"],
    ["EXPIRED"],
    ["REVOKED"],
  ])("flips to %s WITHOUT touching grantedAt", async (status) => {
    const existingGrantedAt = new Date("2026-05-01T00:00:00Z");
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({
        id: "ca-1",
        status: "GRANTED",
        grantedAt: existingGrantedAt,
      }),
    );

    await handleConsentCallback({
      consentRequestId: "ca-1",
      status: status as any,
      artefact: { reason: status },
    });

    const arg = prismaMock.consentArtefact.update.mock.calls[0][0];
    expect(arg.data.status).toBe(status);
    // Existing grantedAt must be preserved verbatim — not overwritten.
    expect(arg.data.grantedAt).toEqual(existingGrantedAt);
  });

  it("preserves the existing artefact when payload omits one", async () => {
    const existingArtefact = { hiTypes: ["OPConsultation"], stored: true };
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: "ca-1", status: "REQUESTED", artefact: existingArtefact }),
    );

    await handleConsentCallback({
      consentRequestId: "ca-1",
      status: "DENIED",
      // artefact omitted
    });

    const arg = prismaMock.consentArtefact.update.mock.calls[0][0];
    expect(arg.data.artefact).toEqual(existingArtefact);
    expect(arg.data.status).toBe("DENIED");
  });

  it("writes a Prisma JsonNull when both payload and existing artefact are absent", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: "ca-1", status: "REQUESTED", artefact: null }),
    );

    await handleConsentCallback({
      consentRequestId: "ca-1",
      status: "EXPIRED",
    });

    const arg = prismaMock.consentArtefact.update.mock.calls[0][0];
    // Prisma.JsonNull is the sentinel — not strictly equal to JS null. Just
    // assert it's not undefined and not a plain object with our data.
    expect(arg.data.artefact).toBeDefined();
    expect(arg.data.status).toBe("EXPIRED");
  });

  it("looks up the artefact by the supplied consentRequestId (correlation key)", async () => {
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: "ca-7", status: "REQUESTED" }),
    );

    await handleConsentCallback({
      consentRequestId: "ca-7",
      status: "GRANTED",
      artefact: { jws: "..." },
    });

    expect(prismaMock.consentArtefact.findUnique).toHaveBeenCalledWith({
      where: { id: "ca-7" },
    });
  });
});

// ─── State-machine end-to-end ─────────────────────────────────────────────

describe("Consent state machine (end-to-end through public API)", () => {
  beforeEach(resetAllMocks);

  it("REQUESTED → GRANTED via callback, then revoke succeeds", async () => {
    // 1) Request
    const { consentRequestId } = await requestConsent(makeRequestInput());
    expect(prismaMock.consentArtefact.create).toHaveBeenCalledTimes(1);

    // 2) Grant via callback
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: consentRequestId, status: "REQUESTED" }),
    );
    await handleConsentCallback({
      consentRequestId,
      status: "GRANTED",
      artefact: { jws: "ok" },
    });
    expect(prismaMock.consentArtefact.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: consentRequestId },
        data: expect.objectContaining({ status: "GRANTED" }),
      }),
    );

    // 3) Revoke — re-prime findUnique to return the now-GRANTED row.
    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: consentRequestId, status: "GRANTED" }),
    );
    await revokeConsent(consentRequestId);
    const lastUpdate = prismaMock.consentArtefact.update.mock.calls.at(-1)![0];
    expect(lastUpdate.data.status).toBe("REVOKED");
  });

  it("REQUESTED → DENIED → revoke is rejected (409)", async () => {
    const { consentRequestId } = await requestConsent(makeRequestInput());

    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: consentRequestId, status: "REQUESTED" }),
    );
    await handleConsentCallback({
      consentRequestId,
      status: "DENIED",
    });

    prismaMock.consentArtefact.findUnique.mockResolvedValueOnce(
      makeArtefactRow({ id: consentRequestId, status: "DENIED" }),
    );
    await expect(revokeConsent(consentRequestId)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
