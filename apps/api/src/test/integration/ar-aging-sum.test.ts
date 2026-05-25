// AR-aging sum reconciliation regression — Pearl Stage 1 §6 row 333.
//
// What this exercises
// -------------------
// The Outstanding A/R Aging report (`GET /api/v1/billing/reports/outstanding`,
// apps/api/src/routes/billing.ts:2150) is the single source of truth that
// finance teams reconcile against — both the per-invoice rows AND the grand
// total are read off the SAME payload, so the contract MUST hold:
//
//   response.data.totalOutstanding === Σ response.data.rows[*].balance
//
// to the paise (no IEEE-754 drift). The recent Issue #901 migration moved
// Invoice money columns from Float to DECIMAL(12,2) precisely so this
// reconciliation survives aggregation of hundreds of partial-pay rows. This
// integration test exists so that any regression — a Float regression, a
// where-clause widening that pulls fully-paid invoices into the report, an
// aggregation shortcut that diverges from the per-row reduce, OR a tenant-
// scoping bypass that mixes tenants in one report — fails CI loudly instead
// of silently misstating the AR balance to the finance lead.
//
// Coverage matrix
// ---------------
//   Reconciliation
//     1. totalOutstanding == sum(rows.balance) to the paise (toFixed(2))
//     2. row count == seeded-outstanding count (fully-paid invoice is NOT in
//        the report — paymentStatus filter on PENDING|PARTIAL holds)
//     3. test-side aging buckets (0-30 / 31-60 / 61-90 / 90+) derived from
//        each row's daysOverdue sum back to the grand total (the endpoint
//        doesn't expose buckets itself; we assert that the report's data is
//        sufficient to compute them and that the sum is consistent — see
//        "Scope cuts" below)
//   Tenant isolation
//     4. Tenant B's invoices DO NOT appear in Tenant A's report
//     5. Symmetric — Tenant A's invoices DO NOT appear in Tenant B's report
//
// Scope cuts
// ----------
// The PRD gap-doc row 333 hinted at per-bucket totals on the response
// (bucket0_30, bucket31_60, etc.). The actual shipped endpoint returns
// `{ rows, totalOutstanding, count }` only — no server-computed buckets.
// Per the agent's allowlist, this test MUST NOT modify the route, so it
// asserts the reconciliation contract on what the endpoint actually returns
// + derives buckets test-side to confirm the row data is sufficient. If
// product later wants server-side bucket totals, that's a separate route
// change with its own assertion (would also need a new test row).
//
// Skipped unless DATABASE_URL_TEST is set.

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
let tenantAId: string;
let tenantBId: string;
let adminAUserId: string;
let adminBUserId: string;
let adminAToken: string;
let adminBToken: string;

// Seeded invoice IDs we expect to assert against in the report
const tenantAInvoices: Array<{
  id: string;
  totalAmount: number;
  paid: number;
  expectedBalance: number;
  daysOverdue: number; // approximate, matches the createdAt offset
  label: string;
}> = [];
let tenantAFullyPaidInvoiceId = "";
let tenantBInvoiceId = "";

function signAdmin(userId: string, email: string, tenantId: string | null) {
  return jwt.sign(
    { userId, email, role: "ADMIN", tenantId: tenantId ?? null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// Bucket boundaries match the conventional AR-aging buckets used elsewhere
// in finance reporting (0-30, 31-60, 61-90, 90+).
function bucketFor(days: number): "0-30" | "31-60" | "61-90" | "90+" {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

describeIfDB(
  "AR-aging report — sum-of-rows reconciliation + tenant isolation (Pearl §6 row 333)",
  () => {
    beforeAll(async () => {
      await resetDB();
      __resetTenantValidationCacheForTests();

      const prisma = await getPrisma();

      // ── Two tenants ────────────────────────────────────────
      const tenantA = await prisma.tenant.create({
        data: {
          name: "Tenant A Hospital — AR aging",
          subdomain: `tenant-a-ar-${Date.now()}`,
          plan: "BASIC",
          active: true,
        },
      });
      const tenantB = await prisma.tenant.create({
        data: {
          name: "Tenant B Hospital — AR aging",
          subdomain: `tenant-b-ar-${Date.now()}`,
          plan: "BASIC",
          active: true,
        },
      });
      tenantAId = tenantA.id;
      tenantBId = tenantB.id;

      // ── Per-tenant ADMIN users + tokens ────────────────────
      const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
      const adminAEmail = `admin-a-ar-${Date.now()}@test.local`;
      const adminBEmail = `admin-b-ar-${Date.now()}@test.local`;
      const adminA = await prisma.user.create({
        data: {
          email: adminAEmail,
          name: "Admin AR A",
          phone: "9210000001",
          passwordHash,
          role: "ADMIN",
          tenantId: tenantAId,
        },
      });
      const adminB = await prisma.user.create({
        data: {
          email: adminBEmail,
          name: "Admin AR B",
          phone: "9210000002",
          passwordHash,
          role: "ADMIN",
          tenantId: tenantBId,
        },
      });
      adminAUserId = adminA.id;
      adminBUserId = adminB.id;
      adminAToken = signAdmin(adminAUserId, adminAEmail, tenantAId);
      adminBToken = signAdmin(adminBUserId, adminBEmail, tenantBId);

      // ── Helper: create a patient + appointment + invoice with a
      // synthetic age (in days) and optional partial payment for Tenant A.
      // We use raw prisma directly with tenantId stamped so the seeded
      // createdAt timestamps stick (route-level createInvoice would stamp
      // createdAt to NOW and we'd lose the aging spread).
      async function seedInvoiceForA(args: {
        ageDays: number; // how old the invoice should appear
        totalAmount: number;
        paid: number;
        label: string;
      }) {
        const i = tenantAInvoices.length + 1;
        const patientUser = await prisma.user.create({
          data: {
            email: `pat-ar-a-${i}-${Date.now()}@test.local`,
            name: `Patient AR A ${i}`,
            phone: `9220${String(1000000 + i).slice(-7)}`,
            passwordHash,
            role: "PATIENT",
            tenantId: tenantAId,
          },
        });
        const patient = await prisma.patient.create({
          data: {
            userId: patientUser.id,
            mrNumber: `MR-AR-A-${i}-${Date.now()}`,
            dateOfBirth: new Date("1990-01-01"),
            gender: "MALE",
            tenantId: tenantAId,
          },
        });
        const doctorUser = await prisma.user.create({
          data: {
            email: `doc-ar-a-${i}-${Date.now()}@test.local`,
            name: `Dr AR A ${i}`,
            phone: `9230${String(1000000 + i).slice(-7)}`,
            passwordHash,
            role: "DOCTOR",
            tenantId: tenantAId,
          },
        });
        const doctor = await prisma.doctor.create({
          data: {
            userId: doctorUser.id,
            specialization: "General Medicine",
            qualification: "MBBS",
            tenantId: tenantAId,
          },
        });
        const apptDate = new Date(Date.now() - args.ageDays * 86400000);
        const appt = await prisma.appointment.create({
          data: {
            patientId: patient.id,
            doctorId: doctor.id,
            date: apptDate,
            tokenNumber: i,
            type: "WALK_IN",
            status: "BOOKED",
            priority: "NORMAL",
            tenantId: tenantAId,
          },
        });
        const ts = Date.now();
        const created = new Date(Date.now() - args.ageDays * 86400000);
        const status =
          args.paid === 0
            ? "PENDING"
            : args.paid >= args.totalAmount
              ? "PAID"
              : "PARTIAL";
        const invoice = await prisma.invoice.create({
          data: {
            invoiceNumber: `INV-AR-A-${i}-${ts}`,
            appointmentId: appt.id,
            patientId: patient.id,
            subtotal: args.totalAmount,
            taxAmount: 0,
            taxableAmount: args.totalAmount,
            cgstAmount: 0,
            sgstAmount: 0,
            discountAmount: 0,
            totalAmount: args.totalAmount,
            paymentStatus: status as any,
            createdAt: created,
            tenantId: tenantAId,
            items: {
              create: [
                {
                  description: args.label,
                  category: "CONSULTATION",
                  quantity: 1,
                  unitPrice: args.totalAmount,
                  amount: args.totalAmount,
                  cgst: 0,
                  sgst: 0,
                  gstRate: 0,
                  hsnSac: "9993",
                },
              ],
            },
          },
        });
        if (args.paid > 0) {
          await prisma.payment.create({
            data: {
              invoiceId: invoice.id,
              amount: args.paid,
              mode: "CASH",
              status: "CAPTURED",
              paidAt: new Date(),
            },
          });
        }
        if (status === "PAID") {
          tenantAFullyPaidInvoiceId = invoice.id;
        } else {
          tenantAInvoices.push({
            id: invoice.id,
            totalAmount: args.totalAmount,
            paid: args.paid,
            expectedBalance: Math.max(0, args.totalAmount - args.paid),
            daysOverdue: args.ageDays,
            label: args.label,
          });
        }
      }

      // 5 outstanding invoices for Tenant A across all 4 aging buckets,
      // plus 1 fully-paid that MUST NOT appear in the report.
      //
      // Mixed amounts + partial payments make the sum-of-paise assertion
      // meaningful (any IEEE-754 drift would produce a non-zero diff).
      // Picked amounts whose halves and tenths exercise the DECIMAL(12,2)
      // contract (e.g. 743.40 is the historical INV000406 case from #901).
      await seedInvoiceForA({
        ageDays: 5,
        totalAmount: 1500.5,
        paid: 0,
        label: "0-30 bucket — unpaid",
      });
      await seedInvoiceForA({
        ageDays: 45,
        totalAmount: 2400.75,
        paid: 1000.25,
        label: "31-60 bucket — partial",
      });
      await seedInvoiceForA({
        ageDays: 50,
        totalAmount: 743.4,
        paid: 100.0,
        label: "31-60 bucket — partial #901 shape",
      });
      await seedInvoiceForA({
        ageDays: 75,
        totalAmount: 3200.0,
        paid: 0,
        label: "61-90 bucket — unpaid",
      });
      await seedInvoiceForA({
        ageDays: 120,
        totalAmount: 999.99,
        paid: 0,
        label: "90+ bucket — unpaid",
      });
      // Fully-paid — must NOT appear in report rows.
      await seedInvoiceForA({
        ageDays: 20,
        totalAmount: 500.0,
        paid: 500.0,
        label: "fully-paid — must NOT appear",
      });

      // ── Tenant B — one outstanding invoice that MUST NOT leak ──
      const patientBUser = await prisma.user.create({
        data: {
          email: `pat-ar-b-${Date.now()}@test.local`,
          name: "Patient AR B",
          phone: "9240000001",
          passwordHash,
          role: "PATIENT",
          tenantId: tenantBId,
        },
      });
      const patientB = await prisma.patient.create({
        data: {
          userId: patientBUser.id,
          mrNumber: `MR-AR-B-${Date.now()}`,
          dateOfBirth: new Date("1985-01-01"),
          gender: "FEMALE",
          tenantId: tenantBId,
        },
      });
      const doctorBUser = await prisma.user.create({
        data: {
          email: `doc-ar-b-${Date.now()}@test.local`,
          name: "Dr AR B",
          phone: "9250000001",
          passwordHash,
          role: "DOCTOR",
          tenantId: tenantBId,
        },
      });
      const doctorB = await prisma.doctor.create({
        data: {
          userId: doctorBUser.id,
          specialization: "General Medicine",
          qualification: "MBBS",
          tenantId: tenantBId,
        },
      });
      const apptB = await prisma.appointment.create({
        data: {
          patientId: patientB.id,
          doctorId: doctorB.id,
          date: new Date(Date.now() - 10 * 86400000),
          tokenNumber: 1,
          type: "WALK_IN",
          status: "BOOKED",
          priority: "NORMAL",
          tenantId: tenantBId,
        },
      });
      const invB = await prisma.invoice.create({
        data: {
          invoiceNumber: `INV-AR-B-${Date.now()}`,
          appointmentId: apptB.id,
          patientId: patientB.id,
          subtotal: 5000.0,
          taxAmount: 0,
          taxableAmount: 5000.0,
          cgstAmount: 0,
          sgstAmount: 0,
          discountAmount: 0,
          totalAmount: 5000.0,
          paymentStatus: "PENDING",
          createdAt: new Date(Date.now() - 10 * 86400000),
          tenantId: tenantBId,
          items: {
            create: [
              {
                description: "Tenant B — MUST NOT leak",
                category: "CONSULTATION",
                quantity: 1,
                unitPrice: 5000.0,
                amount: 5000.0,
                cgst: 0,
                sgst: 0,
                gstRate: 0,
                hsnSac: "9993",
              },
            ],
          },
        },
      });
      tenantBInvoiceId = invB.id;

      // ── App (lazy import — picks up the test JWT_SECRET) ────
      const mod = await import("../../app");
      app = mod.app;
    });

    afterAll(async () => {
      __resetTenantValidationCacheForTests();
    });

    // ───────────────────────────────────────────────────────
    // 1. Reconciliation — totalOutstanding equals Σ rows.balance
    // ───────────────────────────────────────────────────────

    it("totalOutstanding equals the sum of every row.balance to the paise (DECIMAL(12,2) reconciliation contract)", async () => {
      const res = await request(app)
        .get("/api/v1/billing/reports/outstanding")
        .set("Authorization", `Bearer ${adminAToken}`);
      expect(res.status).toBe(200);
      const body = res.body?.data;
      expect(body).toBeTruthy();
      expect(Array.isArray(body.rows)).toBe(true);
      expect(typeof body.totalOutstanding).toBe("number");
      expect(typeof body.count).toBe("number");

      // Defense — body.rows must only carry tenant A's outstanding rows.
      const rowIds: string[] = body.rows.map((r: any) => r.invoiceId);
      for (const expected of tenantAInvoices) {
        expect(rowIds).toContain(expected.id);
      }

      // Sum-of-rows reconciliation — done with toFixed(2) so a single-
      // paise Float regression in the route's reduce would fail loudly.
      const sumBalances = body.rows.reduce(
        (s: number, r: any) => s + Number(r.balance),
        0,
      );
      expect(sumBalances.toFixed(2)).toBe(
        Number(body.totalOutstanding).toFixed(2),
      );

      // Spot-check vs the seeded expected balances — protects against a
      // future where-clause regression that returns the wrong row set.
      const expectedTotal = tenantAInvoices.reduce(
        (s, i) => s + i.expectedBalance,
        0,
      );
      expect(Number(body.totalOutstanding).toFixed(2)).toBe(
        expectedTotal.toFixed(2),
      );
    });

    // ───────────────────────────────────────────────────────
    // 2. Row count + fully-paid exclusion
    // ───────────────────────────────────────────────────────

    it("count equals seeded outstanding count and the fully-paid invoice does NOT appear in rows", async () => {
      const res = await request(app)
        .get("/api/v1/billing/reports/outstanding")
        .set("Authorization", `Bearer ${adminAToken}`);
      expect(res.status).toBe(200);
      const body = res.body?.data;

      // 5 outstanding seeded for Tenant A
      expect(body.count).toBe(tenantAInvoices.length);
      expect(body.rows.length).toBe(tenantAInvoices.length);

      // Fully-paid invoice MUST NOT be in the report.
      const rowIds: string[] = body.rows.map((r: any) => r.invoiceId);
      expect(rowIds).not.toContain(tenantAFullyPaidInvoiceId);
    });

    // ───────────────────────────────────────────────────────
    // 3. Aging buckets derived test-side sum back to grand total
    // ───────────────────────────────────────────────────────

    it("aging buckets derived from each row's daysOverdue sum back to totalOutstanding (no row dropped or double-counted)", async () => {
      const res = await request(app)
        .get("/api/v1/billing/reports/outstanding")
        .set("Authorization", `Bearer ${adminAToken}`);
      expect(res.status).toBe(200);
      const body = res.body?.data;

      const buckets: Record<string, number> = {
        "0-30": 0,
        "31-60": 0,
        "61-90": 0,
        "90+": 0,
      };
      for (const r of body.rows) {
        const b = bucketFor(Number(r.daysOverdue));
        buckets[b] += Number(r.balance);
      }
      const sumBuckets =
        buckets["0-30"] + buckets["31-60"] + buckets["61-90"] + buckets["90+"];
      expect(sumBuckets.toFixed(2)).toBe(
        Number(body.totalOutstanding).toFixed(2),
      );

      // Every bucket the seed targeted MUST be non-zero — protects against a
      // future where-clause regression that silently filters out a bucket.
      expect(buckets["0-30"]).toBeGreaterThan(0);
      expect(buckets["31-60"]).toBeGreaterThan(0);
      expect(buckets["61-90"]).toBeGreaterThan(0);
      expect(buckets["90+"]).toBeGreaterThan(0);
    });

    // ───────────────────────────────────────────────────────
    // 4. Tenant isolation — A's report must NOT contain B's invoice
    // ───────────────────────────────────────────────────────

    it("Tenant A's report MUST NOT include Tenant B's outstanding invoice (tenant-scoping contract)", async () => {
      const res = await request(app)
        .get("/api/v1/billing/reports/outstanding")
        .set("Authorization", `Bearer ${adminAToken}`);
      expect(res.status).toBe(200);
      const rowIds: string[] = res.body?.data?.rows?.map(
        (r: any) => r.invoiceId,
      ) ?? [];
      expect(rowIds).not.toContain(tenantBInvoiceId);
    });

    // ───────────────────────────────────────────────────────
    // 5. Tenant isolation — symmetric — B's report must NOT contain A's invoices
    // ───────────────────────────────────────────────────────

    it("Tenant B's report MUST NOT include any of Tenant A's outstanding invoices (symmetric tenant-scoping contract)", async () => {
      const res = await request(app)
        .get("/api/v1/billing/reports/outstanding")
        .set("Authorization", `Bearer ${adminBToken}`);
      expect(res.status).toBe(200);
      const rowIds: string[] = res.body?.data?.rows?.map(
        (r: any) => r.invoiceId,
      ) ?? [];
      // Tenant B's own invoice should be the ONLY row.
      expect(rowIds).toContain(tenantBInvoiceId);
      for (const a of tenantAInvoices) {
        expect(rowIds).not.toContain(a.id);
      }
      expect(rowIds).not.toContain(tenantAFullyPaidInvoiceId);

      // And the sum-reconciliation must still hold for Tenant B.
      const body = res.body?.data;
      const sumBalances = body.rows.reduce(
        (s: number, r: any) => s + Number(r.balance),
        0,
      );
      expect(sumBalances.toFixed(2)).toBe(
        Number(body.totalOutstanding).toFixed(2),
      );
    });
  },
);
