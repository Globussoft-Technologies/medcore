// Unit-style tests for the /api/v1/ai/transcribe router.
//
// Pins the audit contract: every successful Sarvam ASR call must stamp an
// AI_TRANSCRIBE_INFERENCE audit row with audio/transcript SIZES and latency
// only — never audio bytes or transcript content (PHI).
//
// security audit follow-up (2026-05-04-med): F-TX-1.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock, callWithASRFallbackMock, getASRClientMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  } as any,
  callWithASRFallbackMock: vi.fn(),
  getASRClientMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));
vi.mock("../services/ai/asr-providers", () => ({
  callWithASRFallback: callWithASRFallbackMock,
  getASRClient: getASRClientMock,
}));

import { aiTranscribeRouter } from "./ai-transcribe";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ai/transcribe", aiTranscribeRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign(
    { userId: `u-${role}`, email: `${role}@t.local`, role },
    "test-secret"
  );
}

describe("POST /api/v1/ai/transcribe — audit contract (F-TX-1)", () => {
  beforeEach(() => {
    callWithASRFallbackMock.mockReset();
    prismaMock.auditLog.create.mockClear();
  });

  it("writes an AI_TRANSCRIBE_INFERENCE audit row on the success path", async () => {
    callWithASRFallbackMock.mockResolvedValueOnce({
      transcript: "Hello, doctor.",
      segments: [
        { text: "Hello, doctor.", startMs: 0, endMs: 1500 },
      ],
      language: "en-IN",
      provider: "sarvam",
    });

    const audioBase64 = Buffer.from("FAKE_AUDIO_BYTES_x32").toString("base64");

    const res = await request(buildApp())
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`)
      .send({ audioBase64, language: "en-IN" });

    expect(res.status).toBe(200);
    expect(res.body.data.transcript).toBe("Hello, doctor.");

    const inferenceCalls = prismaMock.auditLog.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.action === "AI_TRANSCRIBE_INFERENCE"
    );
    expect(inferenceCalls.length).toBe(1);
    const details = inferenceCalls[0][0].data.details;
    expect(details.success).toBe(true);
    expect(details.model).toBe("sarvam-asr");
    expect(details.provider).toBe("sarvam");
    expect(typeof details.latencyMs).toBe("number");
    expect(details.promptBytes).toBe(
      Buffer.from(audioBase64, "base64").length
    );
    expect(details.responseBytes).toBe("Hello, doctor.".length);
    expect(details.segmentCount).toBe(1);
    expect(details.language).toBe("en-IN");
    // PHI safety: NEVER log audio or transcript content.
    expect(details).not.toHaveProperty("audioBase64");
    expect(details).not.toHaveProperty("audio");
    expect(details).not.toHaveProperty("transcript");
    expect(details).not.toHaveProperty("prompt");
    expect(details).not.toHaveProperty("segments");
  });
});
