// Unit-style tests for the /api/v1/ai/knowledge router.
//
// Pins the audit contract: every KB write must stamp BOTH the existing
// KB_CREATE row AND a new AI_KNOWLEDGE_INFERENCE row with metadata only —
// never the chunk's full content (PHI risk if a doctor pastes a patient
// note into a KB chunk by mistake).
//
// security audit follow-up (2026-05-04-med): F-KB-2.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock, indexChunkMock, seedMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    knowledgeChunk: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  } as any,
  indexChunkMock: vi.fn(async () => undefined),
  seedMock: vi.fn(async () => ({ icd10: 0, medicines: 0 })),
}));

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));
vi.mock("../services/ai/rag", () => ({
  indexChunk: indexChunkMock,
  seedFromExistingData: seedMock,
}));

import { aiKnowledgeRouter } from "./ai-knowledge";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ai/knowledge", aiKnowledgeRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign(
    { userId: `u-${role}`, email: `${role}@t.local`, role },
    "test-secret"
  );
}

describe("POST /api/v1/ai/knowledge — audit contract (F-KB-2)", () => {
  beforeEach(() => {
    indexChunkMock.mockReset();
    indexChunkMock.mockResolvedValue(undefined);
    prismaMock.auditLog.create.mockClear();
  });

  it("writes an AI_KNOWLEDGE_INFERENCE audit row on the success path", async () => {
    const res = await request(buildApp())
      .post("/api/v1/ai/knowledge")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({
        documentType: "ICD10",
        title: "J45 Asthma",
        content: "Asthma is a chronic respiratory condition.",
        sourceId: "icd10-J45",
      });

    expect(res.status).toBe(201);

    const inferenceCalls = prismaMock.auditLog.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.action === "AI_KNOWLEDGE_INFERENCE"
    );
    expect(inferenceCalls.length).toBe(1);
    const details = inferenceCalls[0][0].data.details;
    expect(details.success).toBe(true);
    expect(details.model).toBe("sarvam-105b");
    expect(typeof details.latencyMs).toBe("number");
    expect(details.documentType).toBe("ICD10");
    expect(details.contentBytes).toBe(
      "Asthma is a chronic respiratory condition.".length
    );
    expect(details.titleBytes).toBe("J45 Asthma".length);
    // PHI safety: never log the chunk content or title verbatim in the AI row.
    expect(details).not.toHaveProperty("content");
    expect(details).not.toHaveProperty("prompt");

    // The pre-existing KB_CREATE row must still be present alongside the
    // new inference row.
    const kbCreate = prismaMock.auditLog.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.action === "KB_CREATE"
    );
    expect(kbCreate.length).toBe(1);
  });
});
