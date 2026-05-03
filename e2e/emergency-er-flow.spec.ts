import { test, expect } from "./fixtures";
import {
  API_BASE,
  dismissTourIfPresent,
  expectNotForbidden,
  seedPatient,
  stubAi,
} from "./helpers";

/**
 * Emergency Room end-to-end flow — multi-role.
 *
 * Covers the full ER intake → AI triage → doctor pickup → admission conversion
 * pipeline plus a smoke check on ambulance dispatch. Builds on top of
 * `er-triage.spec.ts` (which only covers the standalone AI form) by
 * exercising the actual ER board at /dashboard/emergency end to end.
 *
 * Conventions:
 *   - All AI calls (POST /ai/er-triage/assess + POST /ai/er-triage/:id/assess)
 *     are stubbed via `stubAi` — Sarvam is forbidden in CI.
 *   - Patients are pre-seeded via `seedPatient` so the "Search by name" lookup
 *     in the intake modal returns a deterministic row.
 *   - ER cases are created via the API (POST /emergency/cases) when the test
 *     needs the row to exist; the UI walk-through covers steps 1 & 2 only —
 *     pickup/admit/ambulance use targeted UI assertions because the fully
 *     manual click-path is brittle and already exercised at the API layer.
 *
 * Project: runs under `--project=full`. No regression-tier inclusion.
 */

// Stub payload that mimics the ER triage assistant returning an ESI 2.
const STUB_ASSESSMENT = {
  success: true,
  data: {
    suggestedTriageLevel: 2,
    triageLevelLabel: "Emergent",
    disposition: "Resuscitation bay — immediate physician eval",
    immediateActions: ["Attach cardiac monitor", "IV access x2"],
    suggestedInvestigations: ["12-lead ECG", "Troponin"],
    redFlags: ["Radiation to left arm"],
    calculatedMEWS: 4,
    aiReasoning: "Concerning for acute coronary syndrome.",
    disclaimer: "AI-assisted — final triage decision with clinician.",
  },
};

test.describe("Emergency Room flow (multi-role)", () => {
  test("NURSE registers an ER walk-in via /dashboard/emergency", async ({
    nursePage,
    adminApi,
  }) => {
    const page = nursePage;
    // Pre-create a deterministic patient so the search field finds something
    // the test can click — the ER intake modal hard-blocks submission unless
    // a registered patient is selected.
    const patient = await seedPatient(adminApi);

    await page.goto("/dashboard/emergency");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /emergency|er/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Open intake modal.
    await page
      .getByRole("button", { name: /register new case|register|new case/i })
      .first()
      .click();

    // Search for the seeded patient by MR number — guaranteed unique even when
    // other tests churn similar names through the same DB.
    const search = page.getByTestId("er-patient-search");
    await expect(search).toBeVisible({ timeout: 10_000 });
    await search.fill(patient.mrNumber);
    // The result row renders inside an absolute-positioned dropdown; click the
    // first matching button.
    const result = page
      .getByRole("button", { name: new RegExp(patient.mrNumber, "i") })
      .first();
    await result.click({ timeout: 10_000 });

    // Confirm the patient pill is visible (data-testid added in #171).
    await expect(page.getByTestId("er-patient-selected")).toBeVisible();

    // Chief complaint is the only other required field. Scope via testid so we
    // don't collide with the close-disposition modal's textarea on this page.
    const complaint = "Sudden onset chest pain — radiating to left arm";
    await page.getByTestId("er-intake-complaint").fill(complaint);

    // Submit the intake form.
    await page.getByRole("button", { name: /^Register$/ }).click();

    // The intake modal closes and the ER board reloads — assert via the API
    // that an ER case for this patient now exists. Using the API instead of
    // scraping the kanban DOM keeps the test resilient to async refresh
    // timing on the dashboard. adminApi already carries the bearer header.
    await page.waitForTimeout(1500);
    const direct = await adminApi.get(
      `${API_BASE}/emergency/cases/active`
    );
    expect(direct.ok()).toBeTruthy();
    const json = await direct.json();
    const cases = json.data ?? [];
    const found = cases.find(
      (c: any) => c.patientId === patient.id && c.chiefComplaint === complaint
    );
    expect(found).toBeTruthy();
  });

  test("NURSE assigns ESI level using the AI triage assistant (stubbed)", async ({
    nursePage,
  }) => {
    const page = nursePage;

    // Stub BOTH er-triage routes so any path the UI takes resolves to the
    // deterministic ESI 2 payload.
    await stubAi(page, "**/api/v1/ai/er-triage/assess", STUB_ASSESSMENT);
    await stubAi(
      page,
      /\/api\/v1\/ai\/er-triage\/[^/]+\/assess$/,
      STUB_ASSESSMENT
    );

    await page.goto("/dashboard/er-triage");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /er triage assistant/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page
      .getByPlaceholder(/sudden onset chest pain|chief complaint/i)
      .first()
      .fill("Crushing substernal chest pain for 20 minutes");

    await page.getByRole("button", { name: /assess patient/i }).first().click();

    // The result panel renders the literal "ESI Level" copy + the
    // triage-level label from the stub. The numeric badge uses class-based
    // styling so we anchor on text instead.
    await expect(page.getByText(/esi level/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/emergent/i).first()).toBeVisible();
    // Persistence proxy: the disposition text ("Resuscitation bay …") is
    // sourced directly from the assessment payload — its presence proves
    // the ESI assignment was rendered and is what the clinician would copy
    // into the case.
    await expect(page.getByText(/resuscitation bay/i).first()).toBeVisible();
  });

  test("DOCTOR picks up the case from /dashboard/er-triage queue list", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;

    // Seed a patient + register an ER case via API so a row is guaranteed
    // visible to the doctor regardless of board churn from sibling tests.
    const patient = await seedPatient(adminApi);
    const created = await adminApi.post(`${API_BASE}/emergency/cases`, {
      data: {
        patientId: patient.id,
        arrivalMode: "Walk-in",
        chiefComplaint: "Severe abdominal pain — for doctor pickup",
      },
    });
    expect(created.ok()).toBeTruthy();

    // The /er-triage page is the AI assessment form, but the queue/list view
    // for active cases lives on /dashboard/emergency (the kanban board).
    // Doctors hit that surface to "pick up" cases. We assert both:
    //   1. They can land on /er-triage without RBAC bounce.
    //   2. The seeded case row is visible + clickable on /dashboard/emergency.
    await page.goto("/dashboard/er-triage");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /er triage assistant/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.goto("/dashboard/emergency");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Wait for the "Loading…" placeholder to disappear before scanning rows.
    const loading = page.getByTestId("er-loading");
    await loading.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {
      /* may already be detached */
    });

    // The case-card button shows the patient's name; click it to confirm the
    // side panel opens (chief complaint visible there).
    const card = page.getByRole("button", { name: new RegExp(patient.name) }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();
    await expect(
      page.getByText(/severe abdominal pain — for doctor pickup/i).first()
    ).toBeVisible();
  });

  // TODO: bed seeding — same as admissions-mar

  test.skip("DOCTOR converts ER case to admission and the row appears in /admissions", async ({
    doctorPage,
    adminApi,
    doctorToken,
  }) => {
    const page = doctorPage;

    // Pre-seed: patient + ER case + look up an AVAILABLE bed and a doctorId.
    const patient = await seedPatient(adminApi);
    const ecRes = await adminApi.post(`${API_BASE}/emergency/cases`, {
      data: {
        patientId: patient.id,
        arrivalMode: "Walk-in",
        chiefComplaint: "Acute MI — admit",
      },
    });
    expect(ecRes.ok()).toBeTruthy();
    const ec = (await ecRes.json()).data;

    // Find an AVAILABLE bed.
    const bedRes = await adminApi.get(`${API_BASE}/beds?status=AVAILABLE`);
    expect(bedRes.ok()).toBeTruthy();
    const bedJson = await bedRes.json();
    const bedList = bedJson.data ?? bedJson.beds ?? [];
    const bed = Array.isArray(bedList) ? bedList[0] : bedList?.beds?.[0];
    test.skip(!bed?.id, "No AVAILABLE bed in the seed — skip admission convert");

    // Resolve the doctor's own id (route requires ADMIN/DOCTOR; doctor admits
    // under their own profile).
    const meRes = await adminApi.get(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(meRes.ok()).toBeTruthy();
    const me = (await meRes.json()).data;
    const doctorId = me?.doctor?.id ?? me?.doctorId;
    test.skip(!doctorId, "Doctor user has no linked doctor row — skip");

    // Convert the ER case to an admission via the documented endpoint.
    // /dashboard/admissions/new doesn't exist in this build — admissions are
    // created via the modal on /dashboard/admissions or via the
    // /emergency/cases/:id/admit API the page issues internally.
    const convert = await adminApi.post(
      `${API_BASE}/emergency/cases/${ec.id}/admit`,
      {
        headers: { Authorization: `Bearer ${doctorToken}` },
        data: {
          doctorId,
          bedId: bed.id,
          reason: "Converted from ER — STEMI",
          diagnosis: "Acute STEMI",
        },
      }
    );
    expect(convert.ok()).toBeTruthy();

    // Verify via API GET /admissions?patientId=... that the row exists.
    const listRes = await adminApi.get(
      `${API_BASE}/admissions?patientId=${patient.id}`
    );
    expect(listRes.ok()).toBeTruthy();
    const listJson = await listRes.json();
    const admissions = listJson.data ?? [];
    expect(Array.isArray(admissions)).toBeTruthy();
    expect(admissions.some((a: any) => a.patientId === patient.id)).toBeTruthy();

    // Final UI sanity check — the doctor sees the admissions board without
    // RBAC bounce and the seeded patient name surfaces somewhere in the table.
    await page.goto("/dashboard/admissions");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /admission/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(patient.name).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Ambulance dispatch page loads and exposes a Dispatch Trip control", async ({
    nursePage,
  }) => {
    // /dashboard/ambulance is RBAC-restricted to ADMIN/NURSE/RECEPTION
    // (Issue #89 — DOCTOR is intentionally blocked). NURSE is the right
    // fixture for an ER-adjacent flow.
    const page = nursePage;
    await page.goto("/dashboard/ambulance");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /ambulance/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Smoke-level only: the "Dispatch Trip" button is the entry point to the
    // create-dispatch form. Asserting it's reachable + clickable is enough
    // for this coverage tier — full dispatch flow is non-trivial and out of
    // scope here.
    const dispatchBtn = page
      .getByRole("button", { name: /dispatch trip|new dispatch|dispatch/i })
      .first();
    await expect(dispatchBtn).toBeVisible({ timeout: 10_000 });
    await dispatchBtn.click().catch(() => undefined);

    // After clicking, either a modal opens (form fields render) or the page
    // stays put. Either way we should not see a generic error boundary.
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
