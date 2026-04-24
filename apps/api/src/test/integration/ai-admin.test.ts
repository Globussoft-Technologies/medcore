// Integration tests for the AI Admin router (/api/v1/ai/admin). This router
// manages the prompt-registry CRUD that steers every LLM call, so the
// role guard (ADMIN-only) is load-bearing — widening to DOCTOR/RECEPTION
// would let any clinic user rewrite the triage system prompt.
//
// Prompt-registry service is mocked so tests don't need the Prisma
// `Prompt` / `PromptVersion` tables to be populated.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

vi.mock("../../services/ai/prompt-registry", () => ({
  listPromptVersions: vi.fn(),
  createPromptVersion: vi.fn(),
  activatePromptVersion: vi.fn(),
  rollbackPromptKey: vi.fn(),
}));

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;
let patientToken: string;

describeIfDB("AI Admin API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Happy path: ADMIN lists versions ─────────────────────────────────

  it("ADMIN can list versions for a prompt key", async () => {
    const { listPromptVersions } = await import("../../services/ai/prompt-registry");
    vi.mocked(listPromptVersions).mockResolvedValueOnce({
      total: 2,
      page: 1,
      pageSize: 20,
      versions: [
        { id: "v2", key: "triage.system", version: 2, content: "v2", active: true, createdBy: "admin-1", createdAt: new Date().toISOString() },
        { id: "v1", key: "triage.system", version: 1, content: "v1", active: false, createdBy: "admin-1", createdAt: new Date().toISOString() },
      ] as any,
    } as any);

    const res = await request(app)
      .get("/api/v1/ai/admin/prompts/triage.system/versions")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.versions[0].active).toBe(true);
    expect(vi.mocked(listPromptVersions)).toHaveBeenCalledWith("triage.system", {
      page: 1,
      pageSize: 20,
    });
  });

  // ─── Happy path: ADMIN creates a new version ──────────────────────────

  it("ADMIN can create a new prompt version and gets 201 + the created row", async () => {
    const { createPromptVersion } = await import("../../services/ai/prompt-registry");
    vi.mocked(createPromptVersion).mockResolvedValueOnce({
      id: "pv-new",
      key: "triage.system",
      version: 3,
      content: "You are an ER triage assistant.",
      active: false,
      createdBy: "admin-1",
      createdAt: new Date().toISOString(),
      notes: "Quarterly refresh",
    } as any);

    const res = await request(app)
      .post("/api/v1/ai/admin/prompts/triage.system/versions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        content: "You are an ER triage assistant.",
        notes: "Quarterly refresh",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.version).toBe(3);
    expect(res.body.data.active).toBe(false);
    expect(vi.mocked(createPromptVersion)).toHaveBeenCalledWith(
      "triage.system",
      "You are an ER triage assistant.",
      expect.any(String),
      "Quarterly refresh"
    );
  });

  // ─── Input validation: empty content rejected ─────────────────────────

  it("rejects empty prompt content with 400", async () => {
    const res = await request(app)
      .post("/api/v1/ai/admin/prompts/triage.system/versions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ content: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content/i);
  });

  // ─── Activate surfaces 404 from service ──────────────────────────────

  it("returns 404 when activating a non-existent version", async () => {
    const { activatePromptVersion } = await import("../../services/ai/prompt-registry");
    vi.mocked(activatePromptVersion).mockRejectedValueOnce(
      new Error("Prompt version not found")
    );

    const res = await request(app)
      .post("/api/v1/ai/admin/prompts/versions/does-not-exist/activate")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ─── Rollback 409 when no prior version ──────────────────────────────

  it("returns 409 when rollback has no prior version to restore", async () => {
    const { rollbackPromptKey } = await import("../../services/ai/prompt-registry");
    vi.mocked(rollbackPromptKey).mockRejectedValueOnce(
      new Error("No prior version available to roll back to")
    );

    const res = await request(app)
      .post("/api/v1/ai/admin/prompts/triage.system/rollback")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/prior version/i);
  });

  // ─── Role guard: DOCTOR rejected ──────────────────────────────────────

  it("rejects DOCTOR role with 403 on GET versions (admin-only)", async () => {
    const res = await request(app)
      .get("/api/v1/ai/admin/prompts/triage.system/versions")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(403);
  });

  // ─── Role guard: RECEPTION rejected on write ─────────────────────────

  it("rejects RECEPTION role with 403 on POST versions (admin-only)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/admin/prompts/triage.system/versions")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ content: "nefarious prompt override" });

    expect(res.status).toBe(403);
  });

  // ─── Role guard: PATIENT rejected ─────────────────────────────────────

  it("rejects PATIENT role with 403 on rollback (admin-only)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/admin/prompts/triage.system/rollback")
      .set("Authorization", `Bearer ${patientToken}`);

    expect(res.status).toBe(403);
  });

  // ─── Auth required ────────────────────────────────────────────────────

  it("requires authentication on all /admin routes", async () => {
    const res = await request(app).get("/api/v1/ai/admin/prompts/triage.system/versions");
    expect(res.status).toBe(401);
  });
});
