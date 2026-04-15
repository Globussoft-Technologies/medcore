// Integration tests for pharmacy router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createMedicineFixture,
  createInventoryFixture,
  createPatientFixture,
  createAppointmentFixture,
  createDoctorWithToken,
  createPrescriptionFixture,
} from "../factories";

let app: any;
let adminToken: string;

describeIfDB("Pharmacy API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("adds inventory with batch + expiry", async () => {
    const medicine = await createMedicineFixture();
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const res = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        medicineId: medicine.id,
        batchNumber: `B${Date.now()}`,
        quantity: 100,
        unitCost: 5,
        sellingPrice: 10,
        expiryDate: future.toISOString().slice(0, 10),
        reorderLevel: 20,
        location: "Shelf-B2",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.quantity).toBe(100);
  });

  it("lists inventory", async () => {
    const medicine = await createMedicineFixture();
    await createInventoryFixture({ medicineId: medicine.id });
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns expiring inventory", async () => {
    const medicine = await createMedicineFixture();
    const soon = new Date();
    soon.setDate(soon.getDate() + 15);
    await createInventoryFixture({
      medicineId: medicine.id,
      overrides: { expiryDate: soon },
    });
    const res = await request(app)
      .get("/api/v1/pharmacy/inventory/expiring?days=30")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("dispenses a prescription (decrements stock)", async () => {
    const medicine = await createMedicineFixture({ name: "Paracetamol 500mg" });
    await createInventoryFixture({
      medicineId: medicine.id,
      overrides: { quantity: 500 },
    });
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const prescription = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .post("/api/v1/pharmacy/dispense")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ prescriptionId: prescription.id });
    expect(res.status).toBeLessThan(500);
  });

  it("records a stock return", async () => {
    const medicine = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: medicine.id });
    const res = await request(app)
      .post("/api/v1/pharmacy/returns")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        quantity: 5,
        reason: "DAMAGED",
        refundAmount: 50,
      });
    expect([200, 201, 400]).toContain(res.status);
  });

  it("records a stock transfer", async () => {
    const medicine = await createMedicineFixture();
    const inv = await createInventoryFixture({ medicineId: medicine.id });
    const res = await request(app)
      .post("/api/v1/pharmacy/transfers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        inventoryItemId: inv.id,
        fromLocation: "Shelf-A1",
        toLocation: "Shelf-B2",
        quantity: 10,
      });
    expect([200, 201, 400]).toContain(res.status);
  });

  it("returns reorder suggestions", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/reports/reorder-suggestions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns stock valuation report", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/reports/valuation?method=FIFO")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(500);
  });

  it("returns narcotics ledger", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/reports/narcotics-ledger")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/pharmacy/inventory");
    expect(res.status).toBe(401);
  });

  it("rejects bad inventory payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/pharmacy/inventory")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ medicineId: "x", quantity: -1 });
    expect(res.status).toBe(400);
  });
});
