// Integration tests for /api/v1/marketing/enquiry (public, unauthenticated).
// Covers happy path, Zod validation, honeypot rejection, and CRM forward
// best-effort semantics. Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";

let app: any;

describeIfDB("Marketing enquiry API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  beforeEach(async () => {
    // Ensure each test sees a clean enquiries table even though resetDB
    // only runs once per suite. A small cleanup is cheaper than a full reset.
    const prisma = await getPrisma();
    await prisma.marketingEnquiry.deleteMany({});
    delete process.env.CRM_WEBHOOK_URL;
  });

  afterAll(() => {
    delete process.env.CRM_WEBHOOK_URL;
    vi.restoreAllMocks();
  });

  const validPayload = {
    fullName: "Dr. Meera Rao",
    email: "meera@asha.hospital",
    phone: "+919000000001",
    hospitalName: "Asha Hospital",
    hospitalSize: "10-50",
    role: "Administrator",
    message: "Looking for a demo",
    preferredContactTime: "Morning",
  };

  it("accepts a well-formed enquiry and persists it", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send(validPayload);
    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.id).toBeTruthy();

    const prisma = await getPrisma();
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    expect(row.fullName).toBe(validPayload.fullName);
    expect(row.email).toBe(validPayload.email);
    expect(row.hospitalSize).toBe(validPayload.hospitalSize);
    expect(row.role).toBe(validPayload.role);
    expect(row.source).toBe("website");
    expect(row.forwardedToCrmAt).toBeNull(); // no CRM_WEBHOOK_URL set
  });

  it("rejects payload with bad email (400)", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("rejects payload with missing required fields (400)", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ fullName: "X" });
    expect(res.status).toBe(400);
  });

  it("rejects payload with bad hospitalSize enum (400)", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, hospitalSize: "giant" });
    expect(res.status).toBe(400);
  });

  it("rejects payload with bad role enum (400)", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, role: "CEO" });
    expect(res.status).toBe(400);
  });

  it("honeypot: filled 'website' field returns 200 but does NOT persist", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, website: "https://spambot.example" });
    // Silently "successful" to avoid signalling the bot.
    expect([200, 201]).toContain(res.status);
    expect(res.body.success).toBe(true);

    const prisma = await getPrisma();
    const count = await prisma.marketingEnquiry.count();
    expect(count).toBe(0);
  });

  it("accepts optional fields (message + preferredContactTime)", async () => {
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({
        fullName: "No Message User",
        email: "no-msg@x.com",
        phone: "+911234567890",
        hospitalName: "Clinic X",
        hospitalSize: "1-10",
        role: "Doctor",
      });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row.message).toBeNull();
    expect(row.preferredContactTime).toBeNull();
  });

  it("works without authentication (public endpoint)", async () => {
    // No Authorization header deliberately.
    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, email: "public@x.com" });
    expect([200, 201]).toContain(res.status);
  });

  it("forwards to CRM when CRM_WEBHOOK_URL is set (success stamps forwardedToCrmAt)", async () => {
    process.env.CRM_WEBHOOK_URL = "https://crm.example/webhook";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, email: "crm-ok@x.com" });
    expect([200, 201]).toContain(res.status);

    // Give the async CRM call time to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe("https://crm.example/webhook");
    const init = call[1] as any;
    expect(init.method).toBe("POST");
    expect(init.headers["x-medcore-source"]).toBe("website");
    const body = JSON.parse(init.body);
    expect(body.email).toBe("crm-ok@x.com");
    expect(body.source).toBe("website");

    const prisma = await getPrisma();
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row.forwardedToCrmAt).toBeTruthy();

    fetchSpy.mockRestore();
  });

  it("CRM failure (5xx) does NOT block the enquiry — forwardedToCrmAt stays null", async () => {
    process.env.CRM_WEBHOOK_URL = "https://crm.example/webhook";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("boom", { status: 500 }));

    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, email: "crm-fail@x.com" });
    expect([200, 201]).toContain(res.status);

    await new Promise((r) => setTimeout(r, 50));

    const prisma = await getPrisma();
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    expect(row.forwardedToCrmAt).toBeNull();

    fetchSpy.mockRestore();
  });

  it("CRM throw (network error) does NOT block the enquiry", async () => {
    process.env.CRM_WEBHOOK_URL = "https://crm.example/webhook";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network"));

    const res = await request(app)
      .post("/api/v1/marketing/enquiry")
      .send({ ...validPayload, email: "crm-throw@x.com" });
    expect([200, 201]).toContain(res.status);

    const prisma = await getPrisma();
    const row = await prisma.marketingEnquiry.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    expect(row.forwardedToCrmAt).toBeNull();

    fetchSpy.mockRestore();
  });
});
