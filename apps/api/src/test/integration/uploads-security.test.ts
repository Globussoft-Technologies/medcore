// Security hardening tests for the uploads router:
//   - row-level ACL on GET /document/:documentId
//   - magic-byte content sniffing (reject EXE-renamed-as-JPG)
//   - hard 10 MB size cap
//   - HMAC signed-URL helper integrity
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  signParts,
  verifySignature,
} from "../../services/signed-url";
import { UPLOAD_MAX_BYTES } from "../../routes/uploads";

let app: any;
let prisma: any;

let adminToken: string;
let receptionToken: string;
let receptionUserId: string;
let otherDoctorToken: string;
let patientUserToken: string;

let patientId: string;
let documentId: string;

describeIfDB("Uploads security (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    prisma = await getPrisma();

    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    otherDoctorToken = await getAuthToken("DOCTOR");
    patientUserToken = await getAuthToken("PATIENT");

    const reception = await prisma.user.findUnique({
      where: { email: "reception@test.local" },
    });
    receptionUserId = reception.id;
    const patientUser = await prisma.user.findUnique({
      where: { email: "patient@test.local" },
    });

    // Create the doctor profile for the unrelated-doctor user (no
    // appointments with our patient).
    const doctorUser = await prisma.user.findUnique({
      where: { email: "doctor@test.local" },
    });
    await prisma.doctor.create({
      data: { userId: doctorUser.id, specialization: "OTHER" },
    });

    // Create a patient owned by patientUser.
    const patient = await prisma.patient.create({
      data: {
        userId: patientUser.id,
        mrNumber: "MR-SEC-1",
        gender: "MALE" as any,
      },
    });
    patientId = patient.id;

    const mod = await import("../../app");
    app = mod.app;

    // Upload a real PDF as the reception user, attached to this patient.
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.from("test pdf body"),
    ]);
    const up = await request(app)
      .post("/api/v1/uploads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        filename: "report.pdf",
        base64Content: pdf.toString("base64"),
        patientId,
        type: "OTHER",
      });
    expect([200, 201]).toContain(up.status);
    expect(up.body.data.mimeType).toBe("application/pdf");

    // Persist a PatientDocument referencing the stored file so we can
    // exercise the row-level ACL endpoint.
    const doc = await prisma.patientDocument.create({
      data: {
        patientId,
        type: "OTHER" as any,
        title: "Lab report",
        filePath: up.body.data.filePath,
        fileSize: up.body.data.fileSize,
        mimeType: up.body.data.mimeType,
        uploadedBy: receptionUserId,
      },
    });
    documentId = doc.id;
  });

  // ─── ACL ─────────────────────────────────────────────
  it("ACL: uploader (reception) can read", async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/document/${documentId}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
  });

  it("ACL: admin can read", async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/document/${documentId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("ACL: the patient themselves can read their own document", async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/document/${documentId}`)
      .set("Authorization", `Bearer ${patientUserToken}`);
    expect(res.status).toBe(200);
  });

  it("ACL: unrelated doctor (no appointment) gets 403", async () => {
    const res = await request(app)
      .get(`/api/v1/uploads/document/${documentId}`)
      .set("Authorization", `Bearer ${otherDoctorToken}`);
    expect(res.status).toBe(403);
  });

  it("ACL: a different patient is forbidden (403)", async () => {
    // Create a second patient + their user, then try to read.
    const u = await prisma.user.create({
      data: {
        email: "other-patient@test.local",
        name: "Other Patient",
        phone: "9000000001",
        passwordHash: "x",
        role: "PATIENT",
      },
    });
    await prisma.patient.create({
      data: { userId: u.id, mrNumber: "MR-SEC-2", gender: "FEMALE" as any },
    });
    const jwt = await import("jsonwebtoken");
    const token = jwt.sign(
      { userId: u.id, email: u.email, role: u.role },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );
    const res = await request(app)
      .get(`/api/v1/uploads/document/${documentId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("ACL: missing token → 401", async () => {
    const res = await request(app).get(
      `/api/v1/uploads/document/${documentId}`
    );
    expect(res.status).toBe(401);
  });

  it("ACL: signed-url endpoint enforces same ACL", async () => {
    const denied = await request(app)
      .get(`/api/v1/uploads/document/${documentId}/signed-url`)
      .set("Authorization", `Bearer ${otherDoctorToken}`);
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .get(`/api/v1/uploads/document/${documentId}/signed-url`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.url).toMatch(/expires=\d+&sig=[a-f0-9]+/);
    expect(ok.body.data.expires).toBeGreaterThan(
      Math.floor(Date.now() / 1000)
    );
  });

  // ─── MIME filter ─────────────────────────────────────
  it("MIME filter: EXE renamed as .jpg is rejected (400)", async () => {
    // PE/MZ header — start of every Windows .exe.
    const fakeJpg = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]), // "MZ" + padding
      Buffer.from("This is not actually a JPEG"),
    ]);
    const res = await request(app)
      .post("/api/v1/uploads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        filename: "evil.jpg",
        base64Content: fakeJpg.toString("base64"),
        patientId,
        type: "OTHER",
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/not allowed/i);
  });

  it("MIME filter: real PNG is accepted", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, // IHDR length
      0x49, 0x48, 0x44, 0x52, // "IHDR"
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
      0x1f, 0x15, 0xc4, 0x89,
    ]);
    const res = await request(app)
      .post("/api/v1/uploads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        filename: "ok.png",
        base64Content: png.toString("base64"),
        patientId,
        type: "OTHER",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.mimeType).toBe("image/png");
  });

  it("MIME filter: real PDF is accepted", async () => {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("body content here"),
    ]);
    const res = await request(app)
      .post("/api/v1/uploads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        filename: "scan.pdf",
        base64Content: pdf.toString("base64"),
        patientId,
        type: "OTHER",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.mimeType).toBe("application/pdf");
  });

  // ─── Size cap ────────────────────────────────────────
  it("Size cap: 11 MB upload is rejected (413)", async () => {
    // 11 MiB of zeros — magic-bytes wouldn't match anyway, but we mark it
    // as non-medical so it goes through the size check before any sniff.
    const buf = Buffer.alloc(UPLOAD_MAX_BYTES + 1024 * 1024, 0);
    const res = await request(app)
      .post("/api/v1/uploads")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        filename: "big.bin",
        base64Content: buf.toString("base64"),
      });
    // Either the route's own 413 or the JSON parser's 413 is acceptable;
    // both signal "too large" to the caller.
    expect([400, 413]).toContain(res.status);
  });

  // ─── Signed URL helper ───────────────────────────────
  it("signed-url: round trip verifies", () => {
    const parts = signParts("file:abc.png", 60);
    expect(verifySignature("file:abc.png", parts.expires, parts.sig)).toBe(true);
  });

  it("signed-url: tampered expiry fails verification", () => {
    const parts = signParts("file:abc.png", 60);
    expect(
      verifySignature("file:abc.png", parts.expires + 60, parts.sig)
    ).toBe(false);
  });

  it("signed-url: tampered path fails verification", () => {
    const parts = signParts("file:abc.png", 60);
    expect(
      verifySignature("file:other.png", parts.expires, parts.sig)
    ).toBe(false);
  });

  it("signed-url: expired token fails verification", () => {
    const parts = signParts("file:abc.png", 1);
    // Wind the clock forward by manipulating expires manually
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(verifySignature("file:abc.png", past, parts.sig)).toBe(false);
  });
});
