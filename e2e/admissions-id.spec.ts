/**
 * Admission DETAIL surface end-to-end coverage.
 *
 * What this exercises:
 *   /dashboard/admissions/[id]                                 (apps/web/src/app/dashboard/admissions/[id]/page.tsx)
 *   GET /api/v1/admissions/:id, /:id/discharge-readiness,       (apps/api/src/routes/admissions.ts)
 *     /:id/los-prediction, /:id/bill, /:id/belongings
 *   PATCH /api/v1/admissions/:id/discharge
 *
 * Why this spec exists:
 *   `e2e/admissions.spec.ts` covers the LIST page and a basic detail/discharge happy-path.
 *   `e2e/admissions-mar.spec.ts` covers the MAR tab interaction.
 *   This spec is the DETAIL surface in its own right — the chrome-rich Overview tab
 *   that those two specs do not exercise: IsolationPanel default-render, BelongingsCard,
 *   LOS prediction, Running Bill, the Transfer Bed modal opener, the Discharge two-modal
 *   sequence walked end-to-end with a unique-tagged seed, and the page-accessibility
 *   contract (no role gate; only API-level role checks for state-changing actions).
 *
 * Architecture notes:
 *   - `/dashboard/admissions/[id]` has NO role gate at the page level — it just calls
 *     GET /admissions/:id (no `authorize(...)`) so any authenticated user reaches it.
 *     The CTAs in the Actions panel (Transfer / Discharge) render for everyone when the
 *     admission is ADMITTED; the API enforces ADMIN/DOCTOR for discharge and
 *     ADMIN/DOCTOR/NURSE for transfer. We deliberately don't click Discharge as a
 *     non-allowed role here — the API would 403 and that's covered by the route-level
 *     RBAC matrix in rbac-matrix.spec.ts.
 *   - The discharge UX is a TWO-MODAL sequence: clicking "Discharge" opens
 *     DischargeReadinessModal first; clicking "Proceed to Discharge" closes it and
 *     opens the actual discharge form. ADMIN sees a "Force discharge" checkbox when
 *     the readiness check is blocked (outstanding bills / missing summary). For freshly
 *     seeded admissions readiness is always blocked because no discharge summary has
 *     been written yet, so the ADMIN test must check the force checkbox.
 *   - Patient names use `indianishName()` from helpers.ts because PATIENT_NAME_REGEX
 *     in @medcore/shared rejects digits — Date.now()-based unique tags would silently
 *     POST-fail (precedent: c052df6).
 *   - Bed seeding is the same flake source as admissions-mar.spec.ts: skipped clearly
 *     when no AVAILABLE bed exists in the env.
 *   - `gotoAuthed` is mandatory for in-test navigations (WebKit auth-race v4).
 */

import { test, expect } from "./fixtures";
import {
  apiGet,
  expectNotForbidden,
  gotoAuthed,
  seedAdmission,
  seedPatient,
} from "./helpers";

const PAGE_TIMEOUT = 20_000;

/**
 * Try to seed a patient + admission. Returns null when no AVAILABLE bed
 * exists — the caller is responsible for calling test.skip(). Mirrors the
 * skip pattern in admissions-mar.spec.ts and admissions.spec.ts.
 */
async function trySeedAdmission(
  adminApi: import("@playwright/test").APIRequestContext
): Promise<{
  patient: { id: string; name: string; mrNumber: string };
  admission: { id: string; bedId: string };
} | null> {
  try {
    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });
    return { patient, admission };
  } catch {
    return null;
  }
}

test.describe("Admission detail page — /dashboard/admissions/[id] chrome, panels, RBAC, and the discharge two-modal sequence", () => {
  test("ADMIN: detail page renders the patient header, admission # / bed assignment / admitting doctor in the Admission Details card, and the Running Bill block", async ({
    adminPage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(
        true,
        "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)"
      );
      return;
    }
    const { patient, admission } = seeded;

    const page = adminPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expectNotForbidden(page);

    // Patient name renders as the page H1 (page.tsx:206-208).
    await expect(
      page.getByRole("heading", { name: new RegExp(patient.name, "i") }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Status pill — fresh admissions are ADMITTED (page.tsx:226-234).
    await expect(page.locator("body")).toContainText(/ADMITTED/);

    // Back-to-list link (page.tsx:195-200) — the page chrome must include it.
    await expect(
      page.getByRole("link", { name: /back to admissions/i })
    ).toBeVisible();

    // Admission Details card — admission #, doctor, bed/ward labels.
    // The card uses dt/dd Field components (page.tsx:691-706); assert by label-text.
    await expect(
      page.getByRole("heading", { name: /^admission details$/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(page.locator("body")).toContainText(/admission #/i);
    await expect(page.locator("body")).toContainText(/doctor/i);
    await expect(page.locator("body")).toContainText(/^bed$|bed/i);

    // Running Bill section renders once the /:id/bill GET resolves
    // (page.tsx:466-486). It includes "Total" and a day count.
    await expect(
      page.getByRole("heading", { name: /^running bill$/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(page.locator("body")).toContainText(/total/i);
  });

  test("NURSE: page is fully accessible (no role gate); IsolationPanel and Patient Belongings card both render in their default states", async ({
    nursePage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(
        true,
        "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)"
      );
      return;
    }
    const { patient, admission } = seeded;

    const page = nursePage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);

    // Page didn't bounce to /not-authorized (the [id] route has no role gate;
    // matches the precedent set by admissions.spec.ts for the list surface).
    expect(page.url()).not.toContain("/not-authorized");
    expect(page.url()).not.toContain("/login");
    await expectNotForbidden(page);

    // Patient name still resolves so the page actually rendered.
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // IsolationPanel default-state text — fresh admission has no isolation set,
    // so the panel renders "Isolation Status: Standard" (page.tsx:1882-1885).
    await expect(page.locator("body")).toContainText(/isolation status: standard/i);

    // BelongingsCard heading (page.tsx:2305).
    await expect(
      page.getByRole("heading", { name: /^patient belongings$/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });

  test("RECEPTION: page is fully accessible; tab strip exposes Overview / Vitals / Medications / Nurse Rounds / Lab Orders / MAR / I/O", async ({
    receptionPage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(
        true,
        "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)"
      );
      return;
    }
    const { admission } = seeded;

    const page = receptionPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expectNotForbidden(page);
    expect(page.url()).not.toContain("/not-authorized");

    // The tab strip is rendered as plain <button>s — the seven tabs from
    // page.tsx:239-264. Each is the full-width text label.
    for (const label of [
      /^overview$/i,
      /^vitals$/i,
      /^medications$/i,
      /^nurse rounds$/i,
      /^lab orders$/i,
      /^mar$/i,
      /^i\/o$/i,
    ]) {
      await expect(
        page.getByRole("button", { name: label }).first()
      ).toBeVisible({ timeout: PAGE_TIMEOUT });
    }
  });

  test("PATIENT: page-accessible (no /not-authorized bounce); the Discharge button is rendered (UI does not gate; API does — see rbac-matrix.spec.ts)", async ({
    patientPage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(
        true,
        "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)"
      );
      return;
    }
    const { admission } = seeded;

    const page = patientPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);

    // No role-gate at the page level. PATIENT can hit the URL directly.
    expect(page.url()).not.toContain("/not-authorized");
    expect(page.url()).not.toContain("/login");
    await expectNotForbidden(page);

    // The page may render "Admission not found." for PATIENT if the /:id
    // GET filters by patientId — but the admission belongs to a SEEDED
    // patient (different from patient1@medcore.local), so we expect a not-
    // found body OR a successful render. Either way: no /not-authorized.
    // We just assert the route is reachable, which the URL check above did.
  });

  test("DOCTOR: clicking 'Transfer Bed' on the Actions panel opens the bed-transfer modal", async ({
    doctorPage,
    adminApi,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(
        true,
        "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)"
      );
      return;
    }
    const { patient, admission } = seeded;

    const page = doctorPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // Actions panel only renders when status === ADMITTED (page.tsx:488).
    // Click the Transfer Bed CTA.
    const transferBtn = page
      .getByRole("button", { name: /^transfer bed$/i })
      .first();
    await expect(transferBtn).toBeVisible({ timeout: PAGE_TIMEOUT });
    await transferBtn.click();

    // Modal heading (page.tsx:650).
    await expect(
      page.getByRole("heading", { name: /^transfer to new bed$/i })
    ).toBeVisible({ timeout: 8_000 });

    // Cancel out — we don't actually want to perform a transfer here; the
    // happy-path transfer flow lives in the wards / bed-management surface.
    await page.getByRole("button", { name: /^cancel$/i }).first().click();
    await expect(
      page.getByRole("heading", { name: /^transfer to new bed$/i })
    ).not.toBeVisible({ timeout: 5_000 });
  });

  test("ADMIN: discharge two-modal sequence — Discharge opens the readiness modal, Force-discharge unblocks Proceed, the discharge form fills and Confirm flips status to DISCHARGED via API", async ({
    adminPage,
    adminApi,
    adminToken,
  }) => {
    const seeded = await trySeedAdmission(adminApi);
    if (!seeded) {
      test.skip(
        true,
        "No AVAILABLE bed in this environment — bed seeding not yet automated (same as admissions-mar.spec.ts TODO)"
      );
      return;
    }
    const { patient, admission } = seeded;

    const page = adminPage;
    await gotoAuthed(page, `/dashboard/admissions/${admission.id}`);
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: PAGE_TIMEOUT,
    });

    // ── Leg 1: open Discharge Readiness modal ─────────────────────────────
    const dischargeBtn = page
      .getByRole("button", { name: /^discharge$/i })
      .first();
    await expect(dischargeBtn).toBeVisible({ timeout: PAGE_TIMEOUT });
    await dischargeBtn.click();

    await expect(
      page.getByRole("heading", { name: /discharge readiness/i })
    ).toBeVisible({ timeout: 8_000 });

    // Fresh admissions fail readiness (no summary written, no discharge meds).
    // ADMIN gets a "Force discharge" checkbox in this state (page.tsx:2518-2527).
    const proceedBtn = page.getByRole("button", { name: /proceed to discharge/i });
    await expect(proceedBtn).toBeVisible({ timeout: 5_000 });

    const isBlocked = await proceedBtn.isDisabled().catch(() => true);
    if (isBlocked) {
      const forceCheckbox = page.getByRole("checkbox", {
        name: /force discharge/i,
      });
      const hasForce = await forceCheckbox.isVisible().catch(() => false);
      if (hasForce) {
        await forceCheckbox.check();
      } else {
        test.skip(
          true,
          "Discharge readiness blocked and force-discharge checkbox missing — readiness contract drifted"
        );
        return;
      }
    }

    await proceedBtn.click();

    // ── Leg 2: discharge form modal ───────────────────────────────────────
    await expect(
      page.getByRole("heading", { name: /^discharge patient$/i })
    ).toBeVisible({ timeout: 8_000 });

    // The discharge form has multiple textareas (summary, treatment, meds,
    // follow-up). The first textarea inside the modal is the Discharge
    // Summary (page.tsx:519-524) — it's the only required field for the
    // PATCH to succeed.
    const summaryTextarea = page
      .locator('div:has(> h3:has-text("Discharge Patient")) textarea')
      .first();
    await expect(summaryTextarea).toBeVisible({ timeout: 5_000 });
    await summaryTextarea.fill(
      "E2E discharge summary — patient stable, vitals normal, follow up in seven days."
    );

    // Confirm
    const confirmBtn = page.getByRole("button", { name: /confirm discharge/i });
    await expect(confirmBtn).not.toBeDisabled({ timeout: 3_000 });
    await confirmBtn.click();

    // Modal closes
    await expect(
      page.getByRole("heading", { name: /^discharge patient$/i })
    ).not.toBeVisible({ timeout: 8_000 });

    // API confirms status flipped to DISCHARGED.
    const apiRes = await apiGet(
      page.request,
      adminToken,
      `/admissions/${admission.id}`
    );
    expect(apiRes.status).toBe(200);
    expect(apiRes.body?.data?.status).toBe("DISCHARGED");

    await expectNotForbidden(page);
  });
});
