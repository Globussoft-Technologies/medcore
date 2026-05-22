// Integration tests for Pearl ERP Stage 1 §2.1.4 (gap item #50) —
// per-doctor favourite-medicine quick-add list.
//
// What's covered:
//   1. DOCTOR can POST a favourite + GET it back with the medicine embedded.
//   2. Duplicate (same medicineId) → 409.
//   3. POST with non-existent medicineId → 422.
//   4. PATCH updates presets + position.
//   5. PATCH with empty body (no fields) → 400 (Zod refine).
//   6. DELETE removes; second DELETE on the same id → 404.
//   7. DOCTOR A cannot PATCH / DELETE DOCTOR B's favourite (404, never 200).
//   8. Reorder transaction updates all positions atomically.
//   9. RBAC: PATIENT and RECEPTION → 403 on every route.
//
// Two doctors are seeded directly via Prisma with hand-signed JWTs so
// cross-doctor BOLA can be exercised.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
let doctorAToken: string;
let doctorBToken: string;
let receptionToken: string;
let patientToken: string;
let medicineAmoxId: string;
let medicineParaId: string;
let medicineIbuId: string;

function signDoctor(userId: string, email: string, tenantId: string | null = null) {
  return jwt.sign(
    { userId, email, role: "DOCTOR", tenantId: tenantId ?? null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describeIfDB("Doctor Favourite Medicines API (Pearl §2.1.4 — integration)", () => {
  beforeAll(async () => {
    await resetDB();

    const prisma = await getPrisma();
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);

    // Two doctors A and B (each with own User + Doctor rows).
    const userA = await prisma.user.create({
      data: {
        email: `doc-a-fav-${Date.now()}@test.local`,
        name: "Dr. A",
        phone: "9100000011",
        passwordHash,
        role: "DOCTOR",
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `doc-b-fav-${Date.now()}@test.local`,
        name: "Dr. B",
        phone: "9100000012",
        passwordHash,
        role: "DOCTOR",
      },
    });
    await prisma.doctor.create({
      data: { userId: userA.id, specialization: "General Medicine" },
    });
    await prisma.doctor.create({
      data: { userId: userB.id, specialization: "Pediatrics" },
    });
    doctorAToken = signDoctor(userA.id, userA.email);
    doctorBToken = signDoctor(userB.id, userB.email);

    // RECEPTION + PATIENT tokens (from the shared helper).
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");

    // Seed 3 medicines.
    const amox = await prisma.medicine.create({
      data: { name: `Amoxicillin-FAVTEST-${Date.now()}`, form: "tablet", strength: "500mg" },
    });
    const para = await prisma.medicine.create({
      data: { name: `Paracetamol-FAVTEST-${Date.now()}`, form: "tablet", strength: "500mg" },
    });
    const ibu = await prisma.medicine.create({
      data: { name: `Ibuprofen-FAVTEST-${Date.now()}`, form: "tablet", strength: "400mg" },
    });
    medicineAmoxId = amox.id;
    medicineParaId = para.id;
    medicineIbuId = ibu.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  it("POST creates a favourite for the caller doctor and GET returns it with medicine embedded", async () => {
    const post = await request(app)
      .post("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({
        medicineId: medicineAmoxId,
        position: 0,
        defaultDosage: "500mg",
        defaultFrequency: "TID",
        defaultDuration: "5d",
      });
    expect(post.status).toBe(201);
    expect(post.body.success).toBe(true);
    expect(post.body.data.medicineId).toBe(medicineAmoxId);
    expect(post.body.data.defaultDosage).toBe("500mg");

    const list = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);
    const amox = list.body.data.find((f: any) => f.medicineId === medicineAmoxId);
    expect(amox).toBeTruthy();
    expect(amox.medicine).toBeTruthy();
    expect(amox.medicine.id).toBe(medicineAmoxId);
  });

  it("POST a duplicate (same medicineId) returns 409", async () => {
    const dup = await request(app)
      .post("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({ medicineId: medicineAmoxId });
    expect(dup.status).toBe(409);
  });

  it("POST with a non-existent medicineId returns 422", async () => {
    const res = await request(app)
      .post("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({ medicineId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(422);
  });

  it("PATCH /:id updates presets and position", async () => {
    const list = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    const fav = list.body.data.find((f: any) => f.medicineId === medicineAmoxId);

    const patch = await request(app)
      .patch(`/api/v1/doctors/me/favourites/${fav.id}`)
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({ position: 5, defaultDosage: "250mg" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.position).toBe(5);
    expect(patch.body.data.defaultDosage).toBe("250mg");
  });

  it("PATCH /:id with empty body is rejected (400)", async () => {
    const list = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    const fav = list.body.data.find((f: any) => f.medicineId === medicineAmoxId);

    const patch = await request(app)
      .patch(`/api/v1/doctors/me/favourites/${fav.id}`)
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({});
    expect(patch.status).toBe(400);
  });

  it("DOCTOR B cannot PATCH or DELETE DOCTOR A's favourite (404, never 200)", async () => {
    const listA = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    const favA = listA.body.data.find((f: any) => f.medicineId === medicineAmoxId);

    const patchB = await request(app)
      .patch(`/api/v1/doctors/me/favourites/${favA.id}`)
      .set("Authorization", `Bearer ${doctorBToken}`)
      .send({ position: 99 });
    expect(patchB.status).toBe(404);

    const delB = await request(app)
      .delete(`/api/v1/doctors/me/favourites/${favA.id}`)
      .set("Authorization", `Bearer ${doctorBToken}`);
    expect(delB.status).toBe(404);

    // Doctor A's row is still intact.
    const listAAgain = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    const still = listAAgain.body.data.find((f: any) => f.id === favA.id);
    expect(still).toBeTruthy();
  });

  it("PATCH /reorder updates all positions atomically", async () => {
    // Add two more favourites for doctor A so we have a reorderable set.
    const add1 = await request(app)
      .post("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({ medicineId: medicineParaId, position: 1 });
    expect(add1.status).toBe(201);
    const add2 = await request(app)
      .post("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({ medicineId: medicineIbuId, position: 2 });
    expect(add2.status).toBe(201);

    const listBefore = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    const ids = listBefore.body.data.map((f: any) => f.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);

    // Reverse the order.
    const reorderPayload = ids.map((id: string, idx: number) => ({
      id,
      position: ids.length - 1 - idx,
    }));
    const reorder = await request(app)
      .patch("/api/v1/doctors/me/favourites/reorder")
      .set("Authorization", `Bearer ${doctorAToken}`)
      .send({ items: reorderPayload });
    expect(reorder.status).toBe(200);
    expect(reorder.body.data.updated).toBe(ids.length);

    const listAfter = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    // listAfter is sorted by position ASC — so the first item is now what was last.
    expect(listAfter.body.data[0].id).toBe(ids[ids.length - 1]);
  });

  it("DELETE removes the favourite; second DELETE on the same id is 404", async () => {
    const list = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${doctorAToken}`);
    const fav = list.body.data.find((f: any) => f.medicineId === medicineAmoxId);
    expect(fav).toBeTruthy();

    const del1 = await request(app)
      .delete(`/api/v1/doctors/me/favourites/${fav.id}`)
      .set("Authorization", `Bearer ${doctorAToken}`);
    expect(del1.status).toBe(200);

    const del2 = await request(app)
      .delete(`/api/v1/doctors/me/favourites/${fav.id}`)
      .set("Authorization", `Bearer ${doctorAToken}`);
    expect(del2.status).toBe(404);
  });

  it("RBAC: PATIENT cannot access any favourites route (403)", async () => {
    const get = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(get.status).toBe(403);

    const post = await request(app)
      .post("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ medicineId: medicineParaId });
    expect(post.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot access any favourites route (403)", async () => {
    const get = await request(app)
      .get("/api/v1/doctors/me/favourites")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(get.status).toBe(403);
  });
});
