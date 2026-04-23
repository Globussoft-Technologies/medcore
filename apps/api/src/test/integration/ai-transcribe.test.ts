// Integration tests for the AI Transcribe router (/api/v1/ai/transcribe).
// Forwards to the Sarvam speech-to-text API — we mock global fetch.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

let app: any;
let patientToken: string;
let originalFetch: typeof fetch;
let originalSarvamKey: string | undefined;

describeIfDB("AI Transcribe API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;

    originalFetch = global.fetch;
    originalSarvamKey = process.env.SARVAM_API_KEY;
    process.env.SARVAM_API_KEY = "test-sarvam-key";
  });

  beforeEach(() => {
    // Install a default success mock for fetch that returns a fake Sarvam response
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        transcript: "Hello, this is a test transcript.",
        language_code: "en-IN",
      }),
    })) as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalSarvamKey === undefined) {
      delete process.env.SARVAM_API_KEY;
    } else {
      process.env.SARVAM_API_KEY = originalSarvamKey;
    }
  });

  // ─── Happy path ───────────────────────────────────────────────────────

  it("transcribes a base64 audio blob successfully", async () => {
    const audioBase64 = Buffer.from("fake-audio-bytes").toString("base64");

    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ audioBase64, language: "en-IN" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transcript).toBe("Hello, this is a test transcript.");
    expect(res.body.data.languageCode).toBe("en-IN");
    expect(global.fetch).toHaveBeenCalledOnce();
    // Verify the request went to Sarvam's ASR endpoint
    const firstCall = (global.fetch as any).mock.calls[0];
    expect(firstCall[0]).toBe("https://api.sarvam.ai/speech-to-text");
    expect(firstCall[1].method).toBe("POST");
    expect(firstCall[1].headers["api-subscription-key"]).toBe("test-sarvam-key");
  });

  it("defaults language to en-IN when not provided", async () => {
    const audioBase64 = Buffer.from("another-fake-blob").toString("base64");

    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ audioBase64 });

    expect(res.status).toBe(200);
    expect(res.body.data.languageCode).toBe("en-IN");
  });

  it("handles missing transcript/language_code in Sarvam response gracefully", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as any;

    const audioBase64 = Buffer.from("x").toString("base64");

    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ audioBase64, language: "hi-IN" });

    expect(res.status).toBe(200);
    expect(res.body.data.transcript).toBe("");
    expect(res.body.data.languageCode).toBe("hi-IN");
  });

  // ─── Validation / auth ────────────────────────────────────────────────

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .send({ audioBase64: "x" });

    expect(res.status).toBe(401);
  });

  it("returns 400 when audioBase64 is missing", async () => {
    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ language: "en-IN" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/audioBase64/);
  });

  it("returns 400 when audioBase64 is not a string", async () => {
    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ audioBase64: 12345 });

    expect(res.status).toBe(400);
  });

  // ─── Configuration errors ─────────────────────────────────────────────

  it("returns 500 when SARVAM_API_KEY is not configured", async () => {
    const savedKey = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;

    try {
      const res = await request(app)
        .post("/api/v1/ai/transcribe")
        .set("Authorization", `Bearer ${patientToken}`)
        .send({ audioBase64: Buffer.from("x").toString("base64") });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/SARVAM_API_KEY/);
    } finally {
      process.env.SARVAM_API_KEY = savedKey;
    }
  });

  // ─── Upstream error handling ──────────────────────────────────────────

  it("returns 502 when Sarvam responds with a non-ok JSON error", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ message: "Rate limit exceeded" }),
    })) as any;

    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ audioBase64: Buffer.from("x").toString("base64") });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  it("returns 502 with default error message when Sarvam response is not JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
    })) as any;

    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ audioBase64: Buffer.from("x").toString("base64") });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Sarvam ASR error: 503/);
  });

  it("allows any authenticated role (no authorize middleware)", async () => {
    const doctorToken = await getAuthToken("DOCTOR");

    const res = await request(app)
      .post("/api/v1/ai/transcribe")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ audioBase64: Buffer.from("x").toString("base64") });

    expect(res.status).toBe(200);
  });
});
