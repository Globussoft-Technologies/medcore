import { test, expect } from "./fixtures";
import { loginAs, Role } from "./helpers";

/**
 * RBAC matrix spec — comprehensive (role × route) coverage of every
 * web-side role gate added in the issue #179 / #382 / #383 / #385 / #438
 * sweep, plus historical gates from #89 / #90 / #98 / #207.
 *
 * Source of truth: `docs/RBAC_AUDIT_2026-04-30.md` plus the `*_ALLOWED`
 * Set constants at the top of each `apps/web/src/app/dashboard/<m>/page.tsx`.
 *
 * Negative tests: log in as a blocked role, navigate to the route, assert
 * the redirect URL matches what the page actually does. Most pages bounce
 * to `/dashboard/not-authorized?from=<encoded-original>` (chrome-preserving
 * Access Denied surface introduced by #179). The two billing pages are
 * older code that still bounces straight to `/dashboard`.
 *
 * Positive tests: one allowed role per restricted route, asserting the
 * page loaded (URL stayed put, no redirect to /not-authorized or /login).
 *
 * NOTE: Some entries use a stable placeholder UUID for parameterized
 * routes — the role gate fires inside a useEffect on mount, BEFORE any
 * data fetch, so the ID never has to resolve.
 */

const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

type Outcome =
  | { kind: "denied"; redirect: "not-authorized" | "dashboard" }
  | { kind: "allowed" };

interface RbacCase {
  role: Role;
  route: string;
  outcome: Outcome;
  /** Optional override label for the test title. */
  label?: string;
}

/**
 * Master matrix. The "negative" rows enumerate every blocked role per
 * gated route; the trailing "positive" rows pick one allowed role per
 * route to prove the gate isn't over-strict. Universally-accessible
 * routes (profile, account) are smoke-tested across all 7 roles.
 */
export const RBAC_MATRIX: RbacCase[] = [
  // /dashboard/patients — PATIENTS_ALLOWED = {ADMIN, RECEPTION, DOCTOR, NURSE}
  { role: "PATIENT", route: "/dashboard/patients", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/patients", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PHARMACIST", route: "/dashboard/patients", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/queue — QUEUE_ALLOWED = {ADMIN, RECEPTION, DOCTOR, NURSE}
  { role: "PATIENT", route: "/dashboard/queue", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/queue", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PHARMACIST", route: "/dashboard/queue", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/billing — BILLING_ALLOWED = {ADMIN, RECEPTION, PATIENT}
  // (legacy gate: redirects to /dashboard, NOT /not-authorized)
  { role: "DOCTOR", route: "/dashboard/billing", outcome: { kind: "denied", redirect: "dashboard" } },
  { role: "NURSE", route: "/dashboard/billing", outcome: { kind: "denied", redirect: "dashboard" } },
  { role: "LAB_TECH", route: "/dashboard/billing", outcome: { kind: "denied", redirect: "dashboard" } },
  { role: "PHARMACIST", route: "/dashboard/billing", outcome: { kind: "denied", redirect: "dashboard" } },

  // /dashboard/billing/patient/[id] — BILLING_PATIENT_ALLOWED = {ADMIN, RECEPTION}
  // (legacy gate: also redirects to /dashboard)
  {
    role: "DOCTOR",
    route: `/dashboard/billing/patient/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "dashboard" },
    label: "DOCTOR cannot open bulk-billing patient page",
  },
  {
    role: "NURSE",
    route: `/dashboard/billing/patient/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "dashboard" },
    label: "NURSE cannot open bulk-billing patient page",
  },
  {
    role: "PATIENT",
    route: `/dashboard/billing/patient/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "dashboard" },
    label: "PATIENT cannot open bulk-billing patient page",
  },
  {
    role: "PHARMACIST",
    route: `/dashboard/billing/patient/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "dashboard" },
    label: "PHARMACIST cannot open bulk-billing patient page",
  },
  {
    role: "LAB_TECH",
    route: `/dashboard/billing/patient/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "dashboard" },
    label: "LAB_TECH cannot open bulk-billing patient page",
  },

  // /dashboard/lab — LAB_ALLOWED = {ADMIN, DOCTOR, NURSE, LAB_TECH, PATIENT}
  { role: "RECEPTION", route: "/dashboard/lab", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PHARMACIST", route: "/dashboard/lab", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/lab/[orderId] — same gate as /dashboard/lab
  {
    role: "RECEPTION",
    route: `/dashboard/lab/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "not-authorized" },
    label: "RECEPTION cannot open lab order detail",
  },
  {
    role: "PHARMACIST",
    route: `/dashboard/lab/${PLACEHOLDER_ID}`,
    outcome: { kind: "denied", redirect: "not-authorized" },
    label: "PHARMACIST cannot open lab order detail",
  },

  // /dashboard/prescriptions — RX_ALLOWED = {ADMIN, DOCTOR, NURSE, PHARMACIST, PATIENT}
  { role: "RECEPTION", route: "/dashboard/prescriptions", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/prescriptions", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/ambulance — AMBULANCE_ALLOWED = {ADMIN, RECEPTION, NURSE}
  { role: "DOCTOR", route: "/dashboard/ambulance", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PATIENT", route: "/dashboard/ambulance", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/ambulance", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PHARMACIST", route: "/dashboard/ambulance", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/controlled-substances — allowed = {ADMIN, PHARMACIST, DOCTOR}
  { role: "NURSE", route: "/dashboard/controlled-substances", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "RECEPTION", route: "/dashboard/controlled-substances", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PATIENT", route: "/dashboard/controlled-substances", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/controlled-substances", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/expenses — ALLOWED_ROLES = {ADMIN}
  { role: "DOCTOR", route: "/dashboard/expenses", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "NURSE", route: "/dashboard/expenses", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "RECEPTION", route: "/dashboard/expenses", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PATIENT", route: "/dashboard/expenses", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/expenses", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PHARMACIST", route: "/dashboard/expenses", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/feedback — FEEDBACK_ANALYTICS_ALLOWED = {ADMIN, DOCTOR, NURSE, RECEPTION}
  { role: "PATIENT", route: "/dashboard/feedback", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "LAB_TECH", route: "/dashboard/feedback", outcome: { kind: "denied", redirect: "not-authorized" } },
  { role: "PHARMACIST", route: "/dashboard/feedback", outcome: { kind: "denied", redirect: "not-authorized" } },

  // /dashboard/pharmacy — only RECEPTION is explicitly redirected client-side.
  { role: "RECEPTION", route: "/dashboard/pharmacy", outcome: { kind: "denied", redirect: "not-authorized" } },

  // ---- Positive sanity checks (one allowed role per restricted route) ----
  { role: "DOCTOR", route: "/dashboard/patients", outcome: { kind: "allowed" } },
  { role: "RECEPTION", route: "/dashboard/queue", outcome: { kind: "allowed" } },
  { role: "ADMIN", route: "/dashboard/billing", outcome: { kind: "allowed" } },
  { role: "LAB_TECH", route: "/dashboard/lab", outcome: { kind: "allowed" } },
  { role: "PHARMACIST", route: "/dashboard/prescriptions", outcome: { kind: "allowed" } },
  { role: "NURSE", route: "/dashboard/ambulance", outcome: { kind: "allowed" } },
  { role: "PHARMACIST", route: "/dashboard/controlled-substances", outcome: { kind: "allowed" } },
  { role: "ADMIN", route: "/dashboard/expenses", outcome: { kind: "allowed" } },
  { role: "DOCTOR", route: "/dashboard/feedback", outcome: { kind: "allowed" } },
  { role: "PHARMACIST", route: "/dashboard/pharmacy", outcome: { kind: "allowed" } },
];

const NOT_AUTH_RE = new RegExp("/dashboard/not-authorized");
const DASHBOARD_HOME_RE = new RegExp("/dashboard(?:/?($|\\?))");

function titleFor(c: RbacCase): string {
  if (c.label) return c.label;
  if (c.outcome.kind === "denied") {
    return `${c.role} BLOCKED on ${c.route} -> ${c.outcome.redirect}`;
  }
  return `${c.role} ALLOWED on ${c.route}`;
}

test.describe.parallel("RBAC matrix", () => {
  for (const c of RBAC_MATRIX) {
    test(titleFor(c), async ({ page, request }) => {
      await loginAs(page, request, c.role);
      await page.goto(c.route, { waitUntil: "domcontentloaded" });
      // Give the role-gate useEffect a tick to fire its redirect.
      await page.waitForTimeout(800);

      if (c.outcome.kind === "denied") {
        if (c.outcome.redirect === "not-authorized") {
          await expect(page).toHaveURL(NOT_AUTH_RE, { timeout: 10_000 });
          // The chrome-preserving Access Denied surface from #179.
          await expect(
            page.getByTestId("access-denied-page"),
          ).toBeVisible({ timeout: 10_000 });
        } else {
          // Legacy billing gates: bounce straight to /dashboard root.
          await expect(page).toHaveURL(DASHBOARD_HOME_RE, { timeout: 10_000 });
          // And specifically NOT the original gated route.
          expect(page.url()).not.toContain(c.route);
        }
      } else {
        // Positive case: we should still be on the requested route (not
        // bounced to /not-authorized or /login).
        await expect(page).not.toHaveURL(NOT_AUTH_RE);
        await expect(page).not.toHaveURL(/\/login(\?|$)/);
        // Best-effort: make sure the URL still contains the path we asked
        // for (parameter routes may redirect internally to a canonical
        // form, but the dashboard prefix should always survive).
        expect(page.url()).toContain("/dashboard/");
      }
    });
  }

  // Universally-accessible surfaces: every role should be able to open
  // their own profile + account settings without any redirect.
  const ALL_ROLES: Role[] = [
    "ADMIN",
    "DOCTOR",
    "NURSE",
    "RECEPTION",
    "PATIENT",
    "LAB_TECH",
    "PHARMACIST",
  ];
  for (const role of ALL_ROLES) {
    for (const route of ["/dashboard/profile", "/dashboard/account"]) {
      test(`${role} can open ${route}`, async ({ page, request }) => {
        await loginAs(page, request, role);
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(600);
        await expect(page).not.toHaveURL(NOT_AUTH_RE);
        await expect(page).not.toHaveURL(/\/login(\?|$)/);
        expect(page.url()).toContain(route.split("?")[0]);
      });
    }
  }
});
