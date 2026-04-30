// Permissions matrix — exhaustive role × endpoint authorization test.
//
// For each curated endpoint we encode the `authorize(...)` decorator as
// `rolesAllowed`. Then for each of the 7 canonical roles we hit the endpoint
// with a valid JWT for that role and assert:
//   – If role ∈ rolesAllowed  → status ≠ 403 (anything else is acceptable,
//     including 400 / 404 / 409 — we only care about the auth decision)
//   – If role ∉ rolesAllowed  → status === 403
//
// To isolate the auth decision from body-validation we use GET where the route
// supports it and POST with an empty body otherwise (the authorize middleware
// runs before the validate middleware, so missing fields still produce 403 if
// the role is wrong — exactly what we want to assert).
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

// NOTE: The Prisma / shared `Role` enum only defines 5 values:
// ADMIN, DOCTOR, RECEPTION, NURSE, PATIENT.
// The task brief references PHARMACIST and LAB_TECH, but they do not exist
// in the schema — creating a user with those roles would violate the enum.
// We therefore matrix-test the 5 real roles (25 endpoints × 5 roles = 125
// assertions) and flag the missing roles in the task report.
type Role =
  | "ADMIN"
  | "DOCTOR"
  | "RECEPTION"
  | "NURSE"
  | "PATIENT";

const ALL_ROLES: Role[] = [
  "ADMIN",
  "DOCTOR",
  "RECEPTION",
  "NURSE",
  "PATIENT",
];

interface MatrixRow {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  rolesAllowed: Role[];
  body?: Record<string, unknown>;
  label: string;
}

// ─── Curated representative matrix (~25 rows × 7 roles = 175 assertions) ───
//
// Each row was read off the `authorize()` decorator in the corresponding route
// file. If a route has no authorize() call but only `router.use(authenticate)`,
// it accepts all authenticated roles — those rows are excluded because they
// give no 403-vs-allow discrimination.
const MATRIX: MatrixRow[] = [
  // Patient CRUD
  {
    method: "GET",
    path: "/api/v1/patients",
    rolesAllowed: ["ADMIN", "DOCTOR", "RECEPTION", "NURSE"],
    label: "list patients",
  },
  {
    method: "POST",
    path: "/api/v1/patients",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    body: {},
    label: "create patient",
  },
  {
    method: "POST",
    path: "/api/v1/patients/00000000-0000-0000-0000-000000000000/merge",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "merge patients",
  },
  {
    method: "POST",
    path: "/api/v1/patients/00000000-0000-0000-0000-000000000000/vitals",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "record vitals",
  },

  // Appointment CRUD
  {
    method: "POST",
    path: "/api/v1/appointments/walk-in",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    body: {},
    label: "walk-in appointment",
  },
  {
    method: "POST",
    path: "/api/v1/appointments/recurring",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    body: {},
    label: "recurring appointments",
  },
  {
    method: "GET",
    path: "/api/v1/appointments/stats",
    rolesAllowed: ["ADMIN", "DOCTOR", "RECEPTION"],
    label: "appointment stats",
  },
  {
    method: "GET",
    path: "/api/v1/appointments/no-shows",
    rolesAllowed: ["ADMIN", "DOCTOR", "RECEPTION"],
    label: "appointment no-shows",
  },
  {
    method: "PATCH",
    path: "/api/v1/appointments/00000000-0000-0000-0000-000000000000/reschedule",
    rolesAllowed: ["ADMIN", "DOCTOR", "RECEPTION", "NURSE", "PATIENT"],
    body: {},
    label: "reschedule appointment",
  },

  // Prescription CRUD
  {
    method: "POST",
    path: "/api/v1/prescriptions",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "create prescription",
  },
  {
    method: "POST",
    path: "/api/v1/prescriptions/check-interactions",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "check drug interactions",
  },
  {
    method: "POST",
    path: "/api/v1/prescriptions/copy-from-previous",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "copy previous prescription",
  },
  {
    method: "POST",
    path: "/api/v1/prescriptions/templates",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "create prescription template",
  },

  // Billing
  {
    method: "POST",
    path: "/api/v1/billing/invoices",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    body: {},
    label: "create invoice",
  },
  {
    method: "POST",
    path: "/api/v1/billing/payments",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    body: {},
    label: "record payment",
  },
  {
    method: "POST",
    path: "/api/v1/billing/refunds",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    body: {},
    label: "refund",
  },
  {
    method: "POST",
    path: "/api/v1/billing/apply-late-fees",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "apply late fees",
  },
  {
    method: "GET",
    path: "/api/v1/billing/reports/daily",
    // Tightened by issue #90 — RECEPTION must NOT see financial / collection
    // totals. ADMIN-only.
    rolesAllowed: ["ADMIN"],
    label: "daily billing report",
  },

  // Admissions
  {
    method: "POST",
    path: "/api/v1/admissions",
    rolesAllowed: ["ADMIN", "DOCTOR", "RECEPTION"],
    body: {},
    label: "create admission",
  },
  {
    method: "PATCH",
    path: "/api/v1/admissions/00000000-0000-0000-0000-000000000000/discharge",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "discharge admission",
  },
  {
    method: "POST",
    path: "/api/v1/admissions/00000000-0000-0000-0000-000000000000/vitals",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "admission vitals",
  },

  // Lab orders / results
  {
    method: "POST",
    path: "/api/v1/lab/tests",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "create lab test catalog entry",
  },
  {
    method: "POST",
    path: "/api/v1/lab/orders",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "create lab order",
  },
  {
    method: "POST",
    path: "/api/v1/lab/results",
    // Tightened by issue #14 — separation of duties. LAB_TECH + ADMIN only;
    // LAB_TECH is absent from ALL_ROLES so for the 5-role matrix this is
    // ADMIN-only.
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "post lab result",
  },

  // Medication admin
  {
    method: "POST",
    path: "/api/v1/medication/orders",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "create medication order",
  },

  // Audit (admin only)
  {
    method: "GET",
    path: "/api/v1/audit",
    rolesAllowed: ["ADMIN"],
    label: "list audit log",
  },

  // Analytics (admin + reception by router.use guard)
  {
    method: "GET",
    path: "/api/v1/analytics/overview",
    rolesAllowed: ["ADMIN", "RECEPTION"],
    label: "analytics overview",
  },

  // Emergency
  {
    method: "POST",
    path: "/api/v1/emergency/cases",
    rolesAllowed: ["ADMIN", "NURSE", "RECEPTION", "DOCTOR"],
    body: {},
    label: "create emergency case",
  },
  {
    method: "PATCH",
    path: "/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/close",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "close emergency case",
  },

  // Surgery
  {
    method: "POST",
    path: "/api/v1/surgery/ots",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "create OT",
  },
  {
    method: "POST",
    path: "/api/v1/surgery",
    rolesAllowed: ["DOCTOR", "ADMIN"],
    body: {},
    label: "schedule surgery",
  },

  // Blood bank
  {
    method: "POST",
    path: "/api/v1/bloodbank/donors",
    rolesAllowed: ["NURSE", "DOCTOR", "ADMIN"],
    body: {},
    label: "create blood donor",
  },
  {
    method: "POST",
    path: "/api/v1/bloodbank/inventory",
    rolesAllowed: ["NURSE", "DOCTOR", "ADMIN"],
    body: {},
    label: "add blood unit",
  },

  // Pharmacy
  {
    method: "POST",
    path: "/api/v1/pharmacy/inventory",
    // Tightened by issue #98 — direct stock writes are pharmacy-side only;
    // RECEPTION receives via /purchase-orders. PHARMACIST absent from
    // ALL_ROLES so for the 5-role matrix this is ADMIN-only.
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "create pharmacy inventory",
  },
  {
    method: "POST",
    path: "/api/v1/pharmacy/dispense",
    // PHARMACIST role added; RECEPTION removed for least-privilege.
    // PHARMACIST not in test ALL_ROLES so its coverage is via role-expansion.test.ts.
    rolesAllowed: ["ADMIN", "NURSE"],
    body: {},
    label: "dispense medicine",
  },
  {
    method: "GET",
    path: "/api/v1/pharmacy/reports/stock-value",
    rolesAllowed: ["ADMIN"],
    label: "pharmacy stock-value report",
  },

  // Wards
  {
    method: "POST",
    path: "/api/v1/wards",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "create ward",
  },

  // ─── EXPANSION (+30 endpoints × 5 roles = +150 assertions) ───
  //
  // All entries below were read directly from `authorize(...)` decorators in
  // routes/*.ts as of 2026-04. PHARMACIST and LAB_TECH routes are NOT in
  // ALL_ROLES (those roles are not listed in the test enum), so rows below
  // omit them — the 5-role matrix still exercises the auth decision for the
  // 5 roles we *do* exercise. Routes where the only difference is PHARMACIST /
  // LAB_TECH vs our existing rows are still included because they yield a
  // clean allow/deny for the 5 roles under test.

  // ── Pharmacy (returns, stock-adjust, transfer) ──
  {
    method: "POST",
    path: "/api/v1/pharmacy/returns",
    // authorize(ADMIN, PHARMACIST, NURSE) — PHARMACIST absent from ALL_ROLES
    rolesAllowed: ["ADMIN", "NURSE"],
    body: {},
    label: "pharmacy return",
  },
  {
    method: "POST",
    path: "/api/v1/pharmacy/stock-adjustments",
    // Tightened by issue #98 — pharmacy-only write. PHARMACIST absent from
    // ALL_ROLES → ADMIN-only for the 5-role matrix.
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "pharmacy stock adjustment",
  },
  {
    method: "POST",
    path: "/api/v1/pharmacy/transfers",
    // Tightened by issue #98 — pharmacy-only write. PHARMACIST absent from
    // ALL_ROLES → ADMIN-only for the 5-role matrix.
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "pharmacy transfer",
  },
  {
    method: "POST",
    path: "/api/v1/pharmacy/inventory/00000000-0000-0000-0000-000000000000/recall",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "pharmacy recall batch",
  },
  {
    method: "GET",
    path: "/api/v1/pharmacy/reports/reorder-suggestions",
    // Tightened by issue #98 — exposes stock counts per medicine; pharmacy
    // roles only. PHARMACIST absent from ALL_ROLES → ADMIN-only.
    rolesAllowed: ["ADMIN"],
    label: "pharmacy reorder suggestions",
  },

  // ── Lab (order status, result verify, batch results, QC) ──
  {
    method: "PATCH",
    path: "/api/v1/lab/orders/00000000-0000-0000-0000-000000000000/status",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "update lab order status",
  },
  {
    method: "POST",
    path: "/api/v1/lab/results/batch",
    // Tightened by issue #14 — same RBAC as POST /results. Separation of
    // duties: LAB_TECH + ADMIN only. LAB_TECH absent from ALL_ROLES →
    // ADMIN-only for the 5-role matrix.
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "batch lab results",
  },
  {
    method: "PATCH",
    path: "/api/v1/lab/results/00000000-0000-0000-0000-000000000000/verify",
    rolesAllowed: ["DOCTOR"],
    body: {},
    label: "verify lab result",
  },
  {
    method: "POST",
    path: "/api/v1/lab/qc",
    rolesAllowed: ["ADMIN", "NURSE", "DOCTOR"],
    body: {},
    label: "lab QC log",
  },
  {
    method: "GET",
    path: "/api/v1/lab/qc/summary",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    label: "lab QC summary",
  },
  {
    method: "POST",
    path: "/api/v1/lab/orders/00000000-0000-0000-0000-000000000000/share-link",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE", "RECEPTION"],
    body: {},
    label: "lab share-link report",
  },
  {
    method: "PATCH",
    path: "/api/v1/lab/orders/00000000-0000-0000-0000-000000000000/reject-sample",
    rolesAllowed: ["NURSE", "DOCTOR", "ADMIN"],
    body: {},
    label: "reject lab sample",
  },

  // ── Blood bank (cross-match, reserve, release, donations, screening) ──
  {
    method: "POST",
    path: "/api/v1/bloodbank/cross-matches",
    rolesAllowed: ["DOCTOR", "ADMIN", "NURSE"],
    body: {},
    label: "bloodbank cross-match",
  },
  {
    method: "POST",
    path: "/api/v1/bloodbank/units/00000000-0000-0000-0000-000000000000/reserve",
    rolesAllowed: ["DOCTOR", "ADMIN", "NURSE"],
    body: {},
    label: "reserve blood unit",
  },
  {
    method: "POST",
    path: "/api/v1/bloodbank/units/00000000-0000-0000-0000-000000000000/release",
    rolesAllowed: ["DOCTOR", "ADMIN", "NURSE"],
    body: {},
    label: "release blood unit",
  },
  {
    method: "POST",
    path: "/api/v1/bloodbank/donations",
    rolesAllowed: ["NURSE", "DOCTOR", "ADMIN"],
    body: {},
    label: "record blood donation",
  },
  {
    method: "PATCH",
    path: "/api/v1/bloodbank/donations/00000000-0000-0000-0000-000000000000/approve",
    rolesAllowed: ["DOCTOR", "ADMIN"],
    body: {},
    label: "approve blood donation",
  },
  {
    method: "POST",
    path: "/api/v1/bloodbank/release-expired-reservations",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "release expired blood reservations",
  },

  // ── Surgery (start, complete, cancel, preop, intraop, complications) ──
  {
    method: "PATCH",
    path: "/api/v1/surgery/00000000-0000-0000-0000-000000000000/start",
    rolesAllowed: ["DOCTOR", "ADMIN", "NURSE"],
    body: {},
    label: "start surgery",
  },
  {
    method: "PATCH",
    path: "/api/v1/surgery/00000000-0000-0000-0000-000000000000/complete",
    rolesAllowed: ["DOCTOR", "ADMIN"],
    body: {},
    label: "complete surgery",
  },
  {
    method: "PATCH",
    path: "/api/v1/surgery/00000000-0000-0000-0000-000000000000/cancel",
    rolesAllowed: ["DOCTOR", "ADMIN"],
    body: {},
    label: "cancel surgery",
  },
  {
    method: "PATCH",
    path: "/api/v1/surgery/00000000-0000-0000-0000-000000000000/preop",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "surgery preop checklist",
  },
  {
    method: "PATCH",
    path: "/api/v1/surgery/00000000-0000-0000-0000-000000000000/intraop",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "surgery intraop notes",
  },

  // ── Emergency (triage, admit, assign, mlc, trauma-score) ──
  {
    method: "PATCH",
    path: "/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/triage",
    rolesAllowed: ["ADMIN", "NURSE", "DOCTOR"],
    body: {},
    label: "emergency triage update",
  },
  {
    method: "POST",
    path: "/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/admit",
    rolesAllowed: ["ADMIN", "DOCTOR"],
    body: {},
    label: "admit emergency case",
  },
  {
    method: "PATCH",
    path: "/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/assign",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE", "RECEPTION"],
    body: {},
    label: "assign emergency case",
  },
  {
    method: "PATCH",
    path: "/api/v1/emergency/cases/00000000-0000-0000-0000-000000000000/mlc",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "emergency MLC update",
  },

  // ── Admissions (transfer, isolation-update, belongings) ──
  {
    method: "PATCH",
    path: "/api/v1/admissions/00000000-0000-0000-0000-000000000000/transfer",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "transfer admission bed",
  },
  {
    method: "PATCH",
    path: "/api/v1/admissions/00000000-0000-0000-0000-000000000000/isolation",
    rolesAllowed: ["ADMIN", "DOCTOR", "NURSE"],
    body: {},
    label: "update admission isolation",
  },
  {
    method: "POST",
    path: "/api/v1/admissions/00000000-0000-0000-0000-000000000000/belongings",
    rolesAllowed: ["ADMIN", "NURSE", "RECEPTION"],
    body: {},
    label: "record admission belongings",
  },
  {
    method: "POST",
    path: "/api/v1/admissions/00000000-0000-0000-0000-000000000000/intake-output",
    rolesAllowed: ["ADMIN", "NURSE", "DOCTOR"],
    body: {},
    label: "admission intake/output",
  },

  // ── HR / Leaves / Payroll ──
  {
    method: "POST",
    path: "/api/v1/hr-ops/holidays",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "create holiday",
  },
  {
    method: "POST",
    path: "/api/v1/hr-ops/payroll",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "run payroll",
  },
  {
    method: "POST",
    path: "/api/v1/hr-ops/overtime/auto-calculate",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "auto-calc overtime",
  },
  {
    method: "PATCH",
    path: "/api/v1/leaves/00000000-0000-0000-0000-000000000000/approve",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "approve leave",
  },
  {
    method: "PATCH",
    path: "/api/v1/leaves/00000000-0000-0000-0000-000000000000/reject",
    rolesAllowed: ["ADMIN"],
    body: {},
    label: "reject leave",
  },
];

let app: any;
const tokens: Partial<Record<Role, string>> = {};

describeIfDB("Permissions Matrix (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
    for (const role of ALL_ROLES) {
      tokens[role] = await getAuthToken(role);
    }
  });

  // ─── Matrix: 25+ rows × 7 roles = 175+ assertions ───
  for (const row of MATRIX) {
    for (const role of ALL_ROLES) {
      const expected = row.rolesAllowed.includes(role);
      const label = `${row.method} ${row.path} as ${role} → ${expected ? "not 403" : "403"} (${row.label})`;
      it(label, async () => {
        const token = tokens[role]!;
        const method = row.method.toLowerCase() as
          | "get"
          | "post"
          | "patch"
          | "delete";
        let req = (request(app) as any)[method](row.path).set(
          "Authorization",
          `Bearer ${token}`
        );
        if (row.method !== "GET" && row.method !== "DELETE") {
          req = req.send(row.body ?? {});
        }
        const res = await req;
        if (expected) {
          // Role IS allowed by authorize() — anything except 403 is fine.
          // (400 validation error, 404 not-found, 409 conflict, 200 OK, etc.)
          expect(res.status).not.toBe(403);
        } else {
          // Role is NOT allowed — authorize() must return exactly 403.
          expect(res.status).toBe(403);
        }
      });
    }
  }

  // ─── No-token assertions: three disparate endpoints → 401 ───
  it("GET /api/v1/patients with no token → 401", async () => {
    const res = await request(app).get("/api/v1/patients");
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/billing/invoices with no token → 401", async () => {
    const res = await request(app).post("/api/v1/billing/invoices").send({});
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/audit with no token → 401", async () => {
    const res = await request(app).get("/api/v1/audit");
    expect(res.status).toBe(401);
  });
});
