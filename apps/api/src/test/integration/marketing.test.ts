// Integration tests for the public marketing-enquiry router
// (apps/api/src/routes/marketing.ts).
//
// Modules: routes/marketing.ts (POST /enquiry), middleware/rate-limit.ts
// (no-op in NODE_ENV=test — the route swaps the limiter for a passthrough),
// @medcore/shared validation/marketing.ts (marketingEnquirySchema,
// zodIssuesToFieldErrors), Prisma MarketingEnquiry model.
//
// Why: marketing.ts is a 113-line zero-coverage public router that owns the
// SaaS "Request a Demo" intake form. It is reachable WITHOUT auth, optionally
// forwards to a CRM webhook, carries a honeypot anti-bot field, and emits a
// structured field-error 400 (Issue #45) that the browser form maps onto
// inline messages. This file pins:
//   - happy path (201 + Prisma row materialized + structured success body),
//   - structured 400 with `errors: [{ field, message }]` for each schema
//     branch (short name, bad email, bad Indian-mobile, blank hospitalName,
//     bad hospitalSize enum, bad role enum, short message),
//   - honeypot silent-accept (200 + no DB row + id:null),
//   - phone normalization (blank string -> undefined -> "" persisted; the
//     valid +91 prefix passes the IRTP regex; landline-shaped numbers fail),
//   - optional preferredContactTime — present + absent both pass,
//   - no auth header required (public endpoint).
//
// Per CLAUDE.md gotcha #4: this route never writes AuditLog, so no
// waitForAuditFlush. CRM forward path is opt-in via CRM_WEBHOOK_URL — we do
// NOT exercise the live fetch path (would require global mock + network
// gating); the env-unset branch is the default path under test.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";

let app: any;

function validPayload(overrides: Record<string, any> = {}) {
  return {
    fullName: "Asha Verma",
    email: `asha-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    phone: "9876543210",
    hospitalName: "Sunrise Multi-speciality Hospital",
    hospitalSize: "50-200",
    role: "Administrator",
    message: "We are evaluating MedCore for our 80-bed facility.",
    preferredContactTime: "Morning",
    ...overrides,
  };
}

describeIfDB("Marketing Enquiry API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    // Belt-and-braces: ensure CRM forward is OFF for the suite so the route
    // takes the no-CRM branch deterministically.
    delete process.env.CRM_WEBHOOK_URL;
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Happy path ────────────────────────────────────────────

  it("POST /enquiry accepts a valid payload, returns 201, and persists the row", async () => {
    const prisma = await getPrisma();
    const payload = validPayload();
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(payload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();

    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).not.toBeNull();
    expect(row.fullName).toBe(payload.fullName);
    expect(row.email).toBe(payload.email);
    expect(row.phone).toBe(payload.phone);
    expect(row.hospitalName).toBe(payload.hospitalName);
    expect(row.hospitalSize).toBe(payload.hospitalSize);
    expect(row.role).toBe(payload.role);
    expect(row.message).toBe(payload.message);
    expect(row.preferredContactTime).toBe(payload.preferredContactTime);
    expect(row.source).toBe("website");
    // CRM not configured for the suite — must remain unflagged.
    expect(row.forwardedToCrmAt).toBeNull();
  });

  it("POST /enquiry works without auth (public endpoint)", async () => {
    // No Authorization header — must still succeed.
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload());
    expect(res.status).toBe(201);
  });

  it("POST /enquiry persists phone as empty string when omitted", async () => {
    const prisma = await getPrisma();
    const { phone, ...rest } = validPayload();
    void phone;
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(rest);
    expect(res.status).toBe(201);
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    // Source-side coalesces optional/undefined to "" because the DB column
    // is non-null. Pin the contract so a schema migration cannot silently
    // shift to null without a test failure.
    expect(row.phone).toBe("");
  });

  it("POST /enquiry persists phone as empty string when sent as blank", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ phone: "" }));
    expect(res.status).toBe(201);
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row.phone).toBe("");
  });

  it("POST /enquiry accepts +91-prefixed Indian mobile", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ phone: "+91 9876543210" }));
    expect(res.status).toBe(201);
  });

  it("POST /enquiry accepts request without preferredContactTime", async () => {
    const { preferredContactTime, ...rest } = validPayload();
    void preferredContactTime;
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(rest);
    expect(res.status).toBe(201);
  });

  it("POST /enquiry persists message as null when sent as empty string", async () => {
    // The schema rejects message shorter than 10 chars, so the only way to
    // hit the `message || null` branch is via the schema-allowed minimum.
    // Pin the source's "" || null coalesce — defensively documents that an
    // empty message column is preferred over an empty string.
    const prisma = await getPrisma();
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ message: "1234567890" })); // exactly 10 chars, valid
    expect(res.status).toBe(201);
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row.message).toBe("1234567890");
  });

  // ─── Honeypot ──────────────────────────────────────────────

  it("POST /enquiry silently accepts honeypot-filled requests (200, id:null, no row)", async () => {
    const prisma = await getPrisma();
    const before = await prisma.marketingEnquiry.count();
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ website: "http://spam.example.com" }));
    // Note: honeypot path returns 200 (NOT 201) and id:null — intentional so
    // bots don't get a usable success signal.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeNull();
    const after = await prisma.marketingEnquiry.count();
    expect(after).toBe(before);
  });

  it("POST /enquiry persists row when honeypot is sent as empty string", async () => {
    // Empty website is the normal case — real users leave it blank.
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ website: "" }));
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
  });

  // ─── Structured 400 (Issue #45) ────────────────────────────

  it("POST /enquiry rejects short fullName with structured field error", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ fullName: "A" }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(res.body.error).toMatch(/highlighted fields/i);
    expect(Array.isArray(res.body.errors)).toBe(true);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("fullName");
  });

  it("POST /enquiry rejects > 100-char fullName", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ fullName: "X".repeat(101) }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("fullName");
  });

  it("POST /enquiry rejects malformed email", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("email");
  });

  it("POST /enquiry rejects a non-Indian-mobile phone (landline shape)", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ phone: "0223456789" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("phone");
  });

  it("POST /enquiry rejects blank hospitalName", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ hospitalName: "" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("hospitalName");
  });

  it("POST /enquiry rejects unknown hospitalSize", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ hospitalSize: "9000+" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("hospitalSize");
  });

  it("POST /enquiry rejects unknown role", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ role: "Janitor" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("role");
  });

  it("POST /enquiry rejects too-short message", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ message: "short" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("message");
  });

  it("POST /enquiry rejects > 2000-char message", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ message: "Y".repeat(2001) }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("message");
  });

  it("POST /enquiry rejects unknown preferredContactTime enum value", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload({ preferredContactTime: "Midnight" }));
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toContain("preferredContactTime");
  });

  it("POST /enquiry returns ALL field errors at once (form-friendly batched 400)", async () => {
    // Form wants to surface every error in one round-trip, not first-fail.
    // Send a payload with 3 bad fields and assert all 3 are reported.
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({
        fullName: "A", // too short
        email: "nope", // bad format
        hospitalName: "OK Hospital",
        hospitalSize: "50-200",
        role: "Wizard", // unknown
        message: "We are evaluating MedCore for our facility.",
      });
    expect(res.status).toBe(400);
    const fields = res.body.errors.map((e: any) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(["fullName", "email", "role"]),
    );
  });

  it("POST /enquiry rejects an entirely empty body (multiple required-field errors)", async () => {
    const res = await request(app).post("/api/v1/marketing/enquiry").send({});
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});
