// Deep branch-coverage tests for pharmacy router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createMedicineFixture,
  createInventoryFixture,
} from "../factories";

let app: any;
let adminToken: string;
let pharmacistToken: string;
let nurseToken: string;
let doctorToken: string;

async function setupDispensable(opts: { quantityOnHand?: number; narcotic?: boolean } = {}) {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const med = await createMedicineFixture({
    name: "Paracetamol 500mg",
    requiresRegister: opts.narcotic === true,
    isNarcotic: opts.narcotic === true,
  });
  const inv = await createInventoryFixture({
    medicineId: med.id,
    overrides: { quantity: opts.quantityOnHand ?? 100 },
  });
  const prisma = await getPrisma();
  const rx = await prisma.prescription.create({
    data: {
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
      diagnosis: "Fever",
      items: {
        create: [
          {
            medicineName: "Paracetamol 500mg",
            dosage: "500mg",
            frequency: "TID",
            duration: "5 days",
          },
        ],
      },
    },
  });
  return { patient, doctor, med, inv, rx };
}

describeIfDB("Pharmacy API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("inventory add (new) creates item + PURCHASE movement", async () => {
    const med = await createMedicineFixture();
    const res = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        medicineId: med.id,
        batchNumber: `BN-${Date.now()}`,
        quantity: 50,
        unitCost: 5,
        sellingPrice: 8,
        expiryDate: "2027-12-31",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.quantity).toBe(50);
  });

  it("inventory upsert add on existing batch increments quantity", async () => {
    const med = await createMedicineFixture();
    const body = {
      medicineId: med.id,
      batchNumber: "SAME-BATCH",
      quantity: 20,
      unitCost: 5,
      sellingPrice: 8,
      expiryDate: "2027-12-31",
    };
    const r1 = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    const r2 = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    expect(r2.status).toBe(201);
    expect(r2.body.data.quantity).toBe(40);
    expect(r2.body.data.id).toBe(r1.body.data.id);
  });

  it("inventory add invalid expiryDate (400)", async () => {
    const med = await createMedicineFixture();
    const res = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        medicineId: med.id,
        batchNumber: "X",
        quantity: 10,
        unitCost: 1,
        sellingPrice: 2,
        expiryDate: "Jan 2027",
      });
    expect(res.status).toBe(400);
  });

  it("NURSE cannot add inventory (403)", async () => {
    const med = await createMedicineFixture();
    const res = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        medicineId: med.id,
        batchNumber: "X",
        quantity: 10,
        unitCost: 1,
        sellingPrice: 2,
        expiryDate: "2027-12-31",
      });
    expect(res.status).toBe(403);
  });

  it("stock-movement outbound (DISPENSED) decrements qty", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 50 },
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/stock-movements")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        type: "DISPENSED",
        quantity: 10,
        reason: "Manual dispense",
      });
    expect(res.status).toBe(201);
    const prisma = await getPrisma();
    const item = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(item!.quantity).toBe(40);
  });

  it("stock-movement insufficient stock → 400 or 500", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 5 },
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/stock-movements")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        type: "DISPENSED",
        quantity: 100,
      });
    expect([400, 500]).toContain(res.status);
  });

  it("dispense prescription: FEFO batch selection + stock decrement", async () => {
    const { inv, rx } = await setupDispensable({ quantityOnHand: 100 });
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(200);
    expect(res.body.data.dispensed.length).toBeGreaterThanOrEqual(1);
    const prisma = await getPrisma();
    const after = await prisma.inventoryItem.findUnique({
      where: { id: inv.id },
    });
    expect(after!.quantity).toBeLessThan(100);
  });

  it("dispense: insufficient stock → warning, dispensed empty", async () => {
    const { rx } = await setupDispensable({ quantityOnHand: 0 });
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(200);
    expect(res.body.data.warnings.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.dispensed.length).toBe(0);
  });

  it("dispense 404 unknown prescription", async () => {
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("dispense with controlled substance auto-creates CSR entry", async () => {
    const { rx } = await setupDispensable({ narcotic: true });
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ prescriptionId: rx.id });
    expect(res.status).toBe(200);
    expect(res.body.data.controlledCreated.length).toBeGreaterThanOrEqual(1);
    const prisma = await getPrisma();
    const entries = await prisma.controlledSubstanceEntry.findMany({
      where: { prescriptionId: rx.id },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("inventory/expiring returns items expiring in window", async () => {
    const med = await createMedicineFixture();
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    await createInventoryFixture({
      medicineId: med.id,
      overrides: { expiryDate: soon, quantity: 5 },
    });
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory/expiring?days=30")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("inventory list with lowStock=true", async () => {
    const med = await createMedicineFixture();
    await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 5, reorderLevel: 20 },
    });
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory?lowStock=true")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((i: any) => i.quantity <= i.reorderLevel)).toBe(
      true
    );
  });

  it("batch recall zeros stock + sets recalled=true", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 30 },
    });
    const res = await request(app)
      .post(`/api/v1/pharmacy/inventory/${inv.id}/recall`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Contamination" });
    expect(res.status).toBe(200);
    const prisma = await getPrisma();
    const after = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(after!.recalled).toBe(true);
    expect(after!.quantity).toBe(0);
  });

  it("batch recall rejects missing reason (400)", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: med.id });
    const res = await request(app)
      .post(`/api/v1/pharmacy/inventory/${inv.id}/recall`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("batch recall non-admin (403)", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: med.id });
    const res = await request(app)
      .post(`/api/v1/pharmacy/inventory/${inv.id}/recall`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ reason: "X" });
    expect(res.status).toBe(403);
  });

  it("substitutes returns same-generic alternatives", async () => {
    const base = await createMedicineFixture({
      name: "BrandA",
      genericName: "GenericQ",
      strength: "10mg",
      form: "tablet",
    });
    const alt = await createMedicineFixture({
      name: "BrandB",
      genericName: "GenericQ",
      strength: "10mg",
      form: "tablet",
    });
    await createInventoryFixture({ medicineId: alt.id });
    const res = await request(app)
      .get(`/api/v1/pharmacy/substitutes/${base.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((m: any) => m.id === alt.id)).toBe(true);
  });

  it("substitutes 404 for unknown medicine", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/substitutes/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("stock-adjustments records reason code (EXPIRY)", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 30 },
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/stock-adjustments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        quantity: -5,
        reasonCode: "EXPIRY",
        reason: "Batch expired",
      });
    expect(res.status).toBe(201);
    const prisma = await getPrisma();
    const item = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(item!.quantity).toBe(25);
  });

  it("stock-adjustments invalid reasonCode (400)", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: med.id });
    const res = await request(app)
      .post("/api/v1/pharmacy/stock-adjustments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        quantity: 5,
        reasonCode: "NONSENSE",
      });
    expect(res.status).toBe(400);
  });

  it("pharmacy return PATIENT_RETURNED restocks", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 20 },
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/returns")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        inventoryItemId: inv.id,
        quantity: 3,
        reason: "PATIENT_RETURNED",
        refundAmount: 15,
      });
    expect(res.status).toBe(201);
    const prisma = await getPrisma();
    const item = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(item!.quantity).toBe(23);
  });

  it("pharmacy return EXPIRED does NOT restock", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 20 },
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/returns")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        inventoryItemId: inv.id,
        quantity: 2,
        reason: "EXPIRED",
      });
    expect(res.status).toBe(201);
    const prisma = await getPrisma();
    const item = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(item!.quantity).toBe(20);
  });

  it("pharmacy return 404 unknown inventory", async () => {
    const res = await request(app)
      .post("/api/v1/pharmacy/returns")
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({
        inventoryItemId: "00000000-0000-0000-0000-000000000000",
        quantity: 1,
        reason: "EXPIRED",
      });
    expect(res.status).toBe(404);
  });

  it("stock transfer updates location", async () => {
    const med = await createMedicineFixture();
    const inv = await createInventoryFixture({
      medicineId: med.id,
      overrides: { quantity: 100, location: "Shelf A1" },
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/transfers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        fromLocation: "Shelf A1",
        toLocation: "Shelf B2",
        quantity: 20,
      });
    expect(res.status).toBe(201);
    const prisma = await getPrisma();
    const item = await prisma.inventoryItem.findUnique({ where: { id: inv.id } });
    expect(item!.location).toBe("Shelf B2");
  });

  it("reorder-suggestions endpoint ADMIN+RECEPTION", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/reports/reorder-suggestions?days=30&leadTime=7")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.suggestions)).toBe(true);
  });

  it("valuation with invalid method (400)", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/reports/valuation?method=RANDOM")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("valuation FIFO/LIFO/WEIGHTED_AVG all valid", async () => {
    for (const m of ["FIFO", "LIFO", "WEIGHTED_AVG"]) {
      const res = await request(app)
        .get(`/api/v1/pharmacy/reports/valuation?method=${m}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    }
  });

  it("stock-value report ADMIN-only (403 for nurse)", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/reports/stock-value")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("barcode lookup 404 when not found", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory/barcode/NONEXISTENT-XYZ")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("narcotics-ledger requires ADMIN or DOCTOR", async () => {
    const ok = await request(app)
      .get("/api/v1/pharmacy/reports/narcotics-ledger")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(ok.status).toBe(200);
    const denied = await request(app)
      .get("/api/v1/pharmacy/reports/narcotics-ledger")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(denied.status).toBe(403);
  });
});
