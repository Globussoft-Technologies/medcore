// Integration tests for the AI Sentiment router (/api/v1/ai/sentiment).
// The sentiment-ai service is mocked so tests don't depend on Sarvam.
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

vi.mock("../../services/ai/sentiment-ai", () => ({
  analyzeFeedback: vi.fn(),
  summarizeNpsDrivers: vi.fn(),
  triggerFeedbackAnalysis: vi.fn(),
}));

async function buildTestApp(): Promise<express.Express> {
  const a = express();
  a.use(express.json());
  const { aiSentimentRouter } = await import("../../routes/ai-sentiment");
  a.use("/api/v1/ai/sentiment", aiSentimentRouter);
  const { errorHandler } = await import("../../middleware/error");
  a.use(errorHandler);
  return a;
}

let app: express.Express;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;

describeIfDB("AI Sentiment API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    app = await buildTestApp();
  });

  it("requires authentication on POST /analyze/:feedbackId", async () => {
    const res = await request(app).post("/api/v1/ai/sentiment/analyze/fake-id");
    expect(res.status).toBe(401);
  });

  it("rejects DOCTOR role (403) on POST /analyze/:feedbackId", async () => {
    const res = await request(app)
      .post("/api/v1/ai/sentiment/analyze/fake-id")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("analyses a feedback for ADMIN and returns the structured result", async () => {
    const { analyzeFeedback } = await import("../../services/ai/sentiment-ai");
    vi.mocked(analyzeFeedback).mockResolvedValueOnce({
      feedbackId: "fb-1",
      sentiment: "positive",
      emotions: ["gratitude"],
      themes: ["nurse care"],
      actionableItems: [],
      analyzedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post("/api/v1/ai/sentiment/analyze/fb-1")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sentiment).toBe("positive");
    expect(res.body.data.themes).toContain("nurse care");
  });

  it("returns 404 when analyzeFeedback returns null", async () => {
    const { analyzeFeedback } = await import("../../services/ai/sentiment-ai");
    vi.mocked(analyzeFeedback).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/v1/ai/sentiment/analyze/nonexistent")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it("computes NPS drivers for ADMIN", async () => {
    const { summarizeNpsDrivers } = await import("../../services/ai/sentiment-ai");
    vi.mocked(summarizeNpsDrivers).mockResolvedValueOnce({
      windowDays: 30,
      totalFeedback: 42,
      positiveThemes: [{ theme: "kind staff", count: 20, sampleQuotes: ["great team"] }],
      negativeThemes: [{ theme: "wait time", count: 10, sampleQuotes: ["waited too long"] }],
      actionableInsights: ["Reduce reception wait time."],
      generatedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .get("/api/v1/ai/sentiment/nps-drivers?days=30")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalFeedback).toBe(42);
    expect(res.body.data.positiveThemes[0].theme).toBe("kind staff");
    expect(res.body.data.negativeThemes[0].theme).toBe("wait time");
  });

  it("rejects DOCTOR role (403) on GET /nps-drivers", async () => {
    const res = await request(app)
      .get("/api/v1/ai/sentiment/nps-drivers")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // Issue #28: the reception dashboard renders the NPS-drivers widget. The
  // router-level authorize was widened so this returns 200 instead of 403.
  it("allows RECEPTION on GET /nps-drivers", async () => {
    const { summarizeNpsDrivers } = await import("../../services/ai/sentiment-ai");
    vi.mocked(summarizeNpsDrivers).mockResolvedValueOnce({
      windowDays: 30,
      totalFeedback: 0,
      positiveThemes: [],
      negativeThemes: [],
      actionableInsights: [],
      generatedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .get("/api/v1/ai/sentiment/nps-drivers?days=30")
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalFeedback).toBe(0);
  });

  it("still rejects RECEPTION (403) on POST /analyze/:feedbackId", async () => {
    // Write-paths remain admin-only even though reads were widened.
    const res = await request(app)
      .post("/api/v1/ai/sentiment/analyze/fb-x")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("clamps days parameter to allowed range", async () => {
    const { summarizeNpsDrivers } = await import("../../services/ai/sentiment-ai");
    vi.mocked(summarizeNpsDrivers).mockResolvedValueOnce({
      windowDays: 365,
      totalFeedback: 0,
      positiveThemes: [],
      negativeThemes: [],
      actionableInsights: [],
      generatedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .get("/api/v1/ai/sentiment/nps-drivers?days=99999")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // Should have clamped to 365
    expect(vi.mocked(summarizeNpsDrivers)).toHaveBeenLastCalledWith({ windowDays: 365 });
  });

  it("returns 503 or 404 on GET /feedback/:feedbackId when no sentiment stored", async () => {
    const res = await request(app)
      .get("/api/v1/ai/sentiment/feedback/some-id")
      .set("Authorization", `Bearer ${adminToken}`);
    expect([404, 503]).toContain(res.status);
  });
});
