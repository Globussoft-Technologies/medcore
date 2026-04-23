// Integration tests for the AI Knowledge (RAG) router (/api/v1/ai/knowledge).
// rag service is mocked — no external DB full-text search required to assert route behaviour.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

vi.mock("../../services/ai/rag", () => ({
  indexChunk: vi.fn().mockResolvedValue(undefined),
  retrieveContext: vi.fn().mockResolvedValue(""),
  seedFromExistingData: vi.fn().mockResolvedValue({ icd10: 42, medicines: 17 }),
}));

let app: any;
let adminToken: string;
let doctorToken: string;
let patientToken: string;

describeIfDB("AI Knowledge API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── GET / ────────────────────────────────────────────────────────────

  it("lists knowledge chunks paginated, ADMIN only", async () => {
    const prisma = await getPrisma();
    // Seed three active chunks and one inactive one
    await prisma.knowledgeChunk.createMany({
      data: [
        { documentType: "ICD10", title: "Hypertension", content: "High BP", tags: ["cardio"] },
        { documentType: "ICD10", title: "Diabetes", content: "High sugar", tags: ["endo"] },
        { documentType: "MEDICINE", title: "Aspirin", content: "Antiplatelet", tags: ["cardio"] },
        {
          documentType: "GUIDELINE",
          title: "Inactive",
          content: "Should not appear",
          tags: [],
          active: false,
        },
      ],
    });

    const res = await request(app)
      .get("/api/v1/ai/knowledge?page=1&limit=10")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.chunks.length).toBe(3);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(10);
    // inactive chunk must be filtered out
    const titles = res.body.data.chunks.map((c: any) => c.title);
    expect(titles).not.toContain("Inactive");
  });

  it("filters by documentType", async () => {
    const res = await request(app)
      .get("/api/v1/ai/knowledge?documentType=MEDICINE")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.chunks.every((c: any) => c.documentType === "MEDICINE")).toBe(true);
  });

  it("caps limit at 100", async () => {
    const res = await request(app)
      .get("/api/v1/ai/knowledge?limit=10000")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(100);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/ai/knowledge");
    expect(res.status).toBe(401);
  });

  it("rejects DOCTOR role (403) — only ADMIN allowed", async () => {
    const res = await request(app)
      .get("/api/v1/ai/knowledge")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(403);
  });

  it("rejects PATIENT role (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/knowledge")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });

  // ─── POST / ───────────────────────────────────────────────────────────

  it("creates a knowledge chunk via indexChunk", async () => {
    const { indexChunk } = await import("../../services/ai/rag");
    vi.mocked(indexChunk).mockClear();

    const res = await request(app)
      .post("/api/v1/ai/knowledge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        documentType: "PROTOCOL",
        title: "Sepsis Bundle",
        content: "Give broad-spectrum antibiotics within 1 hour of recognition.",
        tags: ["sepsis", "icu"],
        language: "en",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(vi.mocked(indexChunk)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(indexChunk).mock.calls[0][0];
    expect(callArgs.documentType).toBe("PROTOCOL");
    expect(callArgs.title).toBe("Sepsis Bundle");
    expect(callArgs.tags).toEqual(["sepsis", "icu"]);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/v1/ai/knowledge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ title: "Missing type and content" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("rejects DOCTOR role on POST (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/knowledge")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ documentType: "PROTOCOL", title: "x", content: "y" });

    expect(res.status).toBe(403);
  });

  // ─── DELETE /:id ──────────────────────────────────────────────────────

  it("soft-deletes a knowledge chunk (sets active=false)", async () => {
    const prisma = await getPrisma();
    const chunk = await prisma.knowledgeChunk.create({
      data: {
        documentType: "GUIDELINE",
        title: "To Delete",
        content: "temporary",
        tags: [],
      },
    });

    const res = await request(app)
      .delete(`/api/v1/ai/knowledge/${chunk.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const refetched = await prisma.knowledgeChunk.findUnique({ where: { id: chunk.id } });
    expect(refetched?.active).toBe(false);
  });

  it("returns 404 when deleting a non-existent chunk", async () => {
    const res = await request(app)
      .delete("/api/v1/ai/knowledge/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  // ─── POST /seed ───────────────────────────────────────────────────────

  it("seeds the knowledge base from existing DB data", async () => {
    const { seedFromExistingData } = await import("../../services/ai/rag");
    vi.mocked(seedFromExistingData).mockClear();

    const res = await request(app)
      .post("/api/v1/ai/knowledge/seed")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.icd10).toBe(42);
    expect(res.body.data.medicines).toBe(17);
    expect(vi.mocked(seedFromExistingData)).toHaveBeenCalledOnce();
  });

  it("rejects PATIENT on seed (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/knowledge/seed")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({});

    expect(res.status).toBe(403);
  });
});
