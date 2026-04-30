// RBAC hardening — regression tests for GitHub issues #89 and #90.
//
// Issue #89 (Critical): DOCTOR role was leaking financial + ops data:
//   * Could GET /expenses (₹9.29 lakh staff salaries visible)
//   * Could GET /billing/invoices, /billing/invoices/:id (all invoices)
//   * Could write to /ambulance/trips by direct URL
//
// Issue #90 (High): RECEPTION role was leaking clinical data:
//   * Could view prescriptions (clinical diagnoses)
//   * Could open lab orders + result-entry UI (form rendered, even though
//     POST /lab/results correctly 403'd)
//   * Could see "Today's Revenue" KPI tile via /billing/reports/daily +
//     /analytics/revenue + reports page
//
// These tests assert each role gets 403 on routes they should NOT access.
// They are not exhaustive — paired with the existing rbac-negative.test.ts
// which covers lab-result entry, nurse-rounds contracts, etc.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;
let nurseToken: string;
let labTechToken: string;

describeIfDB("RBAC hardening — issues #89 (DOCTOR leak) + #90 (RECEPTION leak)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    nurseToken = await getAuthToken("NURSE");
    labTechToken = await getAuthToken("LAB_TECH");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Issue #89 — DOCTOR must NOT read financial endpoints ───

  it("issue #89: DOCTOR cannot GET /expenses (403)", async () => {
    const res = await request(app)
      .get("/api/v1/expenses")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #89: DOCTOR cannot GET /expenses/summary (403)", async () => {
    const res = await request(app)
      .get("/api/v1/expenses/summary")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #89: ADMIN can still GET /expenses (200)", async () => {
    const res = await request(app)
      .get("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #89: DOCTOR cannot GET /billing/invoices (403)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #89: DOCTOR cannot GET /billing/invoices/:id (403)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/invoices/some-fake-id")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #89: DOCTOR cannot GET /billing/reports/revenue (403)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/reports/revenue")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #89: DOCTOR cannot POST /ambulance/trips (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ambulanceId: "fake",
        callerName: "X",
        callerPhone: "+919999999999",
        pickupAddress: "Anywhere",
        priority: "ROUTINE",
      });
    expect(res.status).toBe(403);
  });

  it("issue #89: DOCTOR cannot PATCH /ambulance/trips/:id/dispatch (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/ambulance/trips/fake-id/dispatch")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #89: DOCTOR cannot PATCH /ambulance/trips/:id/complete (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/ambulance/trips/fake-id/complete")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ distanceKm: 10, cost: 500 });
    expect(res.status).toBe(403);
  });

  it("issue #89: RECEPTION can still POST /ambulance/trips (not 403)", async () => {
    // Will likely 404 (fake ambulanceId) or 400 (validation) — but never 403.
    const res = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        ambulanceId: "fake",
        callerName: "X",
        callerPhone: "+919999999999",
        pickupAddress: "Anywhere",
        priority: "ROUTINE",
      });
    expect(res.status).not.toBe(403);
  });

  // ─── Issue #90 — RECEPTION must NOT read clinical endpoints ───

  it("issue #90: RECEPTION cannot GET /prescriptions (403)", async () => {
    const res = await request(app)
      .get("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: RECEPTION cannot GET /prescriptions/:id (403)", async () => {
    const res = await request(app)
      .get("/api/v1/prescriptions/some-fake-id")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: DOCTOR can still GET /prescriptions (200)", async () => {
    const res = await request(app)
      .get("/api/v1/prescriptions")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #90: RECEPTION cannot GET /lab/orders (403)", async () => {
    const res = await request(app)
      .get("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: RECEPTION cannot GET /lab/orders/:id (403)", async () => {
    const res = await request(app)
      .get("/api/v1/lab/orders/some-fake-id")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: RECEPTION cannot GET /lab/results/:orderItemId (403)", async () => {
    const res = await request(app)
      .get("/api/v1/lab/results/some-fake-item")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: LAB_TECH can still GET /lab/orders (200)", async () => {
    const res = await request(app)
      .get("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${labTechToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #90: NURSE can still GET /lab/orders (200) — clinical role", async () => {
    const res = await request(app)
      .get("/api/v1/lab/orders")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #90: RECEPTION cannot GET /billing/reports/daily (today's revenue) (403)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/reports/daily")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: RECEPTION cannot GET /billing/reports/revenue (403)", async () => {
    const res = await request(app)
      .get("/api/v1/billing/reports/revenue")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: RECEPTION cannot GET /analytics/revenue (403)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/revenue")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #90: ADMIN can GET /analytics/revenue (200)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/revenue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #90: /analytics/overview strips totalRevenue for RECEPTION", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    // RECEPTION should still get operational counters, but no money keys.
    expect(res.body.data).not.toHaveProperty("totalRevenue");
    expect(res.body.data).not.toHaveProperty("revenueByMode");
  });

  it("issue #90: /analytics/overview keeps totalRevenue for ADMIN", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("totalRevenue");
    expect(res.body.data).toHaveProperty("revenueByMode");
  });

  // ─── Issue #174 — DOCTOR/NURSE/PATIENT must NOT reach admin/ops modules ───
  // Bug: page-level RBAC was sidebar-only. Direct URL bypass let any
  // authenticated role read suppliers, purchase orders, assets, ambulance
  // trips, OT schedules, fuel logs, and the staff roster — modules with
  // vendor PII, financial data, and operational state.

  // Suppliers (procurement PII: gstNumber, contact persons, outstanding $)

  it("issue #174: DOCTOR cannot GET /suppliers (403)", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: NURSE cannot GET /suppliers (403)", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: ADMIN can still GET /suppliers (200)", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #174: DOCTOR cannot GET /suppliers/:id/payments (403)", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/some-fake-id/payments")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // Purchase Orders (financial state, GST, line items)

  it("issue #174: DOCTOR cannot GET /purchase-orders (403)", async () => {
    const res = await request(app)
      .get("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: NURSE cannot GET /purchase-orders (403)", async () => {
    const res = await request(app)
      .get("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: ADMIN can still GET /purchase-orders (200)", async () => {
    const res = await request(app)
      .get("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #174: DOCTOR cannot GET /purchase-orders/:id/grns (403)", async () => {
    const res = await request(app)
      .get("/api/v1/purchase-orders/fake-id/grns")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // Assets (serial numbers, purchase costs, depreciation)

  it("issue #174: DOCTOR cannot GET /assets (403)", async () => {
    const res = await request(app)
      .get("/api/v1/assets")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: NURSE cannot GET /assets (403)", async () => {
    const res = await request(app)
      .get("/api/v1/assets")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: ADMIN can still GET /assets (200)", async () => {
    const res = await request(app)
      .get("/api/v1/assets")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #174: DOCTOR cannot GET /assets/maintenance/due (403)", async () => {
    const res = await request(app)
      .get("/api/v1/assets/maintenance/due")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: DOCTOR cannot GET /assets/:id/depreciation (403)", async () => {
    const res = await request(app)
      .get("/api/v1/assets/fake-id/depreciation")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // Ambulance (caller PII, pickup address, chief complaint)

  it("issue #174: PATIENT cannot GET /ambulance (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/ambulance")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: PATIENT cannot GET /ambulance/trips (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: NURSE can still GET /ambulance/trips (200) — clinical role", async () => {
    const res = await request(app)
      .get("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #174: DOCTOR cannot GET /ambulance/fuel-logs (403)", async () => {
    const res = await request(app)
      .get("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // Surgery / OT (schedule reveals patient PII)

  it("issue #174: PATIENT cannot GET /surgery/ots (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: ADMIN can GET /surgery/ots (200)", async () => {
    const res = await request(app)
      .get("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("issue #174: PATIENT cannot GET /surgery/ots/:id/schedule (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/surgery/ots/fake-id/schedule")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // Pharmacy movements (batch numbers + inventory)

  it("issue #174: PATIENT cannot GET /pharmacy/movements (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/pharmacy/movements")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: RECEPTION cannot GET /pharmacy/movements (403)", async () => {
    const res = await request(app)
      .get("/api/v1/pharmacy/movements")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // Blood bank donor registry (donor PII)

  it("issue #174: RECEPTION cannot GET /bloodbank/donors (403)", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: PATIENT cannot GET /bloodbank/donors (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: NURSE can still GET /bloodbank/donors (200)", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/donors")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  // Staff roster (every staff member's email + role)

  it("issue #174: PATIENT cannot GET /shifts/roster (403)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/shifts/roster?date=2026-04-30")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #174: ADMIN can GET /shifts/roster (200)", async () => {
    const res = await request(app)
      .get("/api/v1/shifts/roster?date=2026-04-30")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  // ─── Issue #262 — RECEPTION must NOT drive PO workflow ───
  // Wave-2 (#174) gated GET endpoints. This wave (#262) gates the
  // state-transition POSTs: submit / receive / cancel. Reception is now
  // read-only on POs. ADMIN + PHARMACIST own the procurement workflow
  // (cancel stays ADMIN-only because it kills an approved liability).

  it("issue #262: RECEPTION cannot POST /purchase-orders/:id/submit (403)", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-orders/fake-po-id/submit")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #262: RECEPTION cannot POST /purchase-orders/:id/receive (403)", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-orders/fake-po-id/receive")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("issue #262: RECEPTION cannot POST /purchase-orders/:id/cancel (403)", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-orders/fake-po-id/cancel")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  it("issue #262: RECEPTION cannot POST /purchase-orders/:id/grns (403)", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-orders/fake-po-id/grns")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ items: [] });
    expect(res.status).toBe(403);
  });
});
