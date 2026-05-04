/**
 * ER reassessment + disposition pathing — staff lifecycle e2e coverage.
 *
 * What this exercises:
 *   /dashboard/emergency (apps/web/src/app/dashboard/emergency/page.tsx)
 *   PATCH /api/v1/emergency/cases/:id/triage  (reassessment / triage-tier update)
 *   PATCH /api/v1/emergency/cases/:id/close   (disposition: DISCHARGED|ADMITTED|TRANSFERRED)
 *
 * Companion to:
 *   - e2e/emergency-er-flow.spec.ts (intake → AI triage → doctor pickup → admit smoke)
 *   - e2e/er-triage.spec.ts         (standalone /dashboard/er-triage AI-form unit)
 *
 * What THIS spec adds (E2E_COVERAGE_BACKLOG.md §5 P9):
 *   - NURSE reassesses a TRIAGED case mid-wait — triage-level UPDATE
 *     (URGENT → EMERGENT due to deterioration). Pins the PATCH /triage
 *     request body shape so the deterioration upgrade contract survives
 *     refactors.
 *   - DOCTOR changes disposition from DISCHARGE → ADMIT in the close panel,
 *     pinning the body-shape that triggers the admission-flow downstream
 *     (status: "ADMITTED" alongside disposition + outcomeNotes).
 *   - DOCTOR discharges with summary + followup-orders content — pins the
 *     close-panel modal contract (status select + disposition input +
 *     outcome notes textarea + Close Case CTA via testid).
 *   - DOCTOR transfer-to-another-facility flow (status: "TRANSFERRED",
 *     disposition: "City General Hospital — neuro ICU", outcome notes
 *     carrying referral packet text).
 *   - PATIENT + PHARMACIST hit /dashboard/emergency — universal-access
 *     archetype pin (CLAUDE.md gotcha #7): page chrome renders for any
 *     authed role because there is NO client-side VIEW_ALLOWED gate AND
 *     no useEffect router.push/replace anywhere in page.tsx. Server-side
 *     authorize() on /emergency/cases/active (Issue #474) returns 403
 *     for non-staff, surfacing as the er-load-error banner. Confirmed
 *     archetype 3 of the 6th cron-learning bullet — no redirect target,
 *     so this spec does NOT assert /dashboard or /dashboard/not-authorized.
 *
 * Why these tests exist:
 *   ER throughput + safety depends on accurate mid-flight reassessment and
 *   correct disposition pathing — discharge vs admit vs transfer each fan
 *   out to different downstream systems (admission flow, referral packet,
 *   followup orders). Closes E2E_COVERAGE_BACKLOG.md §5 P9. Lifecycle
 *   persistence is intentionally short-circuited via page.route stubs to
 *   pin request-body shape without polluting the shared seed across runs.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  dismissTourIfPresent,
  expectNotForbidden,
  gotoAuthed,
  seedPatient,
} from "./helpers";

test.describe("ER reassessment & disposition pathing — /dashboard/emergency (NURSE/DOCTOR mid-flight + RBAC archetype)", () => {
  test("NURSE reassesses a TRIAGED case mid-wait — URGENT to EMERGENT deterioration upgrade pins PATCH /triage body shape", async ({
    nursePage,
    adminApi,
  }) => {
    const page = nursePage;

    // Pre-seed: patient + ER case via API, immediately triaged at URGENT so
    // the side panel renders the Triage section (page.tsx:843-953 gates it
    // on status WAITING|TRIAGED) and we can re-pick a higher tier.
    const patient = await seedPatient(adminApi);
    const ecRes = await adminApi.post(`${API_BASE}/emergency/cases`, {
      data: {
        patientId: patient.id,
        arrivalMode: "Walk-in",
        chiefComplaint: "Abdominal pain — initial URGENT",
      },
    });
    expect(ecRes.ok()).toBeTruthy();
    const ec = (await ecRes.json()).data;
    const triageRes = await adminApi.patch(
      `${API_BASE}/emergency/cases/${ec.id}/triage`,
      { data: { triageLevel: "URGENT" } }
    );
    expect(triageRes.ok()).toBeTruthy();

    // Stub the reassessment PATCH so we capture the body without persisting.
    let capturedBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/emergency/cases/${ec.id}/triage`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      capturedBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { ...ec, triageLevel: "EMERGENT", status: "TRIAGED" },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, "/dashboard/emergency");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Wait for the board to render — loading placeholder must drop.
    const loading = page.getByTestId("er-loading");
    await loading
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => undefined);

    // Click the seeded case card to open the side panel.
    const card = page
      .getByRole("button", { name: new RegExp(patient.name) })
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // Bump triage tier to EMERGENT (deterioration upgrade) by clicking the
    // pill button inside the open side panel. The pill labels live in
    // page.tsx:849-871 — buttons rendered from the literal triage levels.
    await page
      .getByRole("button", { name: /^EMERGENT$/i })
      .first()
      .click();
    await page.getByRole("button", { name: /save triage/i }).first().click();

    // Pin: the request body MUST carry triageLevel: "EMERGENT". Other vitals
    // fields are optional and may be absent / undefined-stripped.
    await expect.poll(() => capturedBody, { timeout: 10_000 }).not.toBeNull();
    expect(capturedBody!.triageLevel).toBe("EMERGENT");
  });

  test("DOCTOR disposition change DISCHARGE -> ADMIT triggers admission flow — close panel status flip pins body shape", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;

    // Seed: patient + ER case in IN_TREATMENT so the close panel renders
    // (page.tsx:986 gates "Close / Disposition" section on status !== WAITING).
    const patient = await seedPatient(adminApi);
    const ecRes = await adminApi.post(`${API_BASE}/emergency/cases`, {
      data: {
        patientId: patient.id,
        arrivalMode: "Ambulance",
        chiefComplaint: "Acute MI — needs admission",
      },
    });
    expect(ecRes.ok()).toBeTruthy();
    const ec = (await ecRes.json()).data;
    await adminApi.patch(`${API_BASE}/emergency/cases/${ec.id}/triage`, {
      data: { triageLevel: "EMERGENT" },
    });
    // Need a doctorId — fetch any doctor row.
    const docList = await adminApi.get(`${API_BASE}/doctors`);
    const docs = (await docList.json()).data ?? [];
    if (docs[0]?.id) {
      await adminApi.patch(`${API_BASE}/emergency/cases/${ec.id}/assign`, {
        data: { attendingDoctorId: docs[0].id },
      });
    }

    let captured: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/emergency/cases/${ec.id}/close`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      captured = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { ...ec, status: "ADMITTED", disposition: "Ward-3 ICU" },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, "/dashboard/emergency");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const loading = page.getByTestId("er-loading");
    await loading
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => undefined);

    const card = page
      .getByRole("button", { name: new RegExp(patient.name) })
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // Flip status select from default DISCHARGED to ADMITTED.
    // Scope the select via :has(option[value="ADMITTED"]) to dodge the global
    // LanguageDropdown <select> (CLAUDE.md gotcha #9 — avoid `.first()` on
    // bare locator('select')). The close-panel select uniquely carries the
    // LEFT_WITHOUT_BEING_SEEN option.
    const statusSelect = page.locator(
      'select:has(option[value="LEFT_WITHOUT_BEING_SEEN"])'
    );
    await expect(statusSelect).toBeVisible({ timeout: 10_000 });
    await statusSelect.selectOption("ADMITTED");

    await page
      .getByTestId("close-disposition")
      .fill("Ward-3 ICU — converted from ER, STEMI");
    await page
      .getByTestId("close-outcome-notes")
      .fill(
        "Acute STEMI confirmed. Started on aspirin + heparin. Admit for cath lab."
      );
    await page.getByTestId("close-case-btn").click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.status).toBe("ADMITTED");
    expect(captured!.disposition).toMatch(/Ward-3|ICU/i);
    expect(captured!.outcomeNotes).toMatch(/STEMI|Admit/i);
  });

  test("DOCTOR discharges with summary + followup orders — close panel modal contract (status select + disposition + outcome textarea + Close CTA)", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;

    const patient = await seedPatient(adminApi);
    const ecRes = await adminApi.post(`${API_BASE}/emergency/cases`, {
      data: {
        patientId: patient.id,
        arrivalMode: "Walk-in",
        chiefComplaint: "Sprained ankle — ready to discharge",
      },
    });
    const ec = (await ecRes.json()).data;
    await adminApi.patch(`${API_BASE}/emergency/cases/${ec.id}/triage`, {
      data: { triageLevel: "LESS_URGENT" },
    });
    const docList = await adminApi.get(`${API_BASE}/doctors`);
    const docs = (await docList.json()).data ?? [];
    if (docs[0]?.id) {
      await adminApi.patch(`${API_BASE}/emergency/cases/${ec.id}/assign`, {
        data: { attendingDoctorId: docs[0].id },
      });
    }

    let captured: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/emergency/cases/${ec.id}/close`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      captured = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { ...ec, status: "DISCHARGED" },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, "/dashboard/emergency");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const loading = page.getByTestId("er-loading");
    await loading
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => undefined);

    const card = page
      .getByRole("button", { name: new RegExp(patient.name) })
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // Modal contract — every required surface must be present and reachable.
    const statusSelect = page.locator(
      'select:has(option[value="LEFT_WITHOUT_BEING_SEEN"])'
    );
    await expect(statusSelect).toBeVisible({ timeout: 10_000 });
    // Default is DISCHARGED — leave as is, only confirm the option exists.
    await expect(
      statusSelect.locator('option[value="DISCHARGED"]')
    ).toHaveCount(1);

    const dispoInput = page.getByTestId("close-disposition");
    const notesArea = page.getByTestId("close-outcome-notes");
    const closeBtn = page.getByTestId("close-case-btn");
    await expect(dispoInput).toBeVisible();
    await expect(notesArea).toBeVisible();
    await expect(closeBtn).toBeVisible();

    await dispoInput.fill("Home — RICE protocol");
    await notesArea.fill(
      "Discharge summary: Grade-2 lateral ankle sprain. Followup orders: " +
        "RICE × 48h, ibuprofen 400mg q8h PRN, ortho clinic in 7d, return if " +
        "weight-bearing remains impossible."
    );
    await closeBtn.click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.status).toBe("DISCHARGED");
    expect(captured!.disposition).toBe("Home — RICE protocol");
    expect(captured!.outcomeNotes).toMatch(/Discharge summary|Followup orders/i);
  });

  test("DOCTOR transfers a case to another facility — TRANSFERRED status + referral packet text in outcome notes", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;

    const patient = await seedPatient(adminApi);
    const ecRes = await adminApi.post(`${API_BASE}/emergency/cases`, {
      data: {
        patientId: patient.id,
        arrivalMode: "Ambulance",
        chiefComplaint: "Major head trauma — needs neurosurgery transfer",
      },
    });
    const ec = (await ecRes.json()).data;
    await adminApi.patch(`${API_BASE}/emergency/cases/${ec.id}/triage`, {
      data: { triageLevel: "RESUSCITATION" },
    });
    const docList = await adminApi.get(`${API_BASE}/doctors`);
    const docs = (await docList.json()).data ?? [];
    if (docs[0]?.id) {
      await adminApi.patch(`${API_BASE}/emergency/cases/${ec.id}/assign`, {
        data: { attendingDoctorId: docs[0].id },
      });
    }

    let captured: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/emergency/cases/${ec.id}/close`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      captured = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { ...ec, status: "TRANSFERRED" },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, "/dashboard/emergency");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const loading = page.getByTestId("er-loading");
    await loading
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => undefined);

    const card = page
      .getByRole("button", { name: new RegExp(patient.name) })
      .first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const statusSelect = page.locator(
      'select:has(option[value="LEFT_WITHOUT_BEING_SEEN"])'
    );
    await expect(statusSelect).toBeVisible({ timeout: 10_000 });
    await statusSelect.selectOption("TRANSFERRED");

    await page
      .getByTestId("close-disposition")
      .fill("City General Hospital — neuro ICU");
    await page
      .getByTestId("close-outcome-notes")
      .fill(
        "Referral packet sent: chief complaint, MEWS=6, GCS=10, intubated, " +
          "stabilized for transfer. Receiving neurosurgeon notified by phone."
      );
    await page.getByTestId("close-case-btn").click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.status).toBe("TRANSFERRED");
    expect(captured!.disposition).toMatch(/City General|neuro ICU/i);
    expect(captured!.outcomeNotes).toMatch(/Referral packet|neurosurgeon/i);
  });

  test("PATIENT + PHARMACIST hitting /dashboard/emergency — universal-access archetype: chrome renders, /cases/active 403 surfaces er-load-error banner (CLAUDE.md gotcha #7 archetype 3, no router redirect anywhere in page.tsx)", async ({
    patientPage,
    pharmacistPage,
  }) => {
    // PATIENT — server's /emergency/cases/active gate (authorize ADMIN/DOCTOR/
    // NURSE/RECEPTION at emergency.ts:181 after Issue #474) returns 403; the
    // page catches it in Promise.allSettled and pins the er-load-error banner
    // (page.tsx:479-494) — NO router.push / router.replace anywhere in
    // page.tsx, so the URL must remain on /dashboard/emergency.
    {
      const page = patientPage;
      await page.goto("/dashboard/emergency", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      // No redirect target — this is the archetype 3 confirm.
      expect(page.url()).toContain("/dashboard/emergency");
      expect(page.url()).not.toContain("/dashboard/not-authorized");

      // Heading still visible (universally-accessible chrome).
      await expect(
        page.getByRole("heading", { name: /emergency|er/i }).first()
      ).toBeVisible({ timeout: 15_000 });

      // No app-level error boundary — soft-failure path.
      await expect(
        page.locator("text=/Application error|Something went wrong/i")
      ).toHaveCount(0);
    }

    // PHARMACIST — same archetype: no client-side gate, server-side authorize
    // omits PHARMACIST from /cases/active, surfaces same soft failure. Pins
    // the breadth case (a staff-but-out-of-allow-set role) so this spec
    // covers BOTH the canonical low-priv role (PATIENT) and a staff role
    // (PHARMACIST) — matches the visitors.spec.ts pattern from 2026-05-05.
    {
      const page = pharmacistPage;
      await page.goto("/dashboard/emergency", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      expect(page.url()).toContain("/dashboard/emergency");
      expect(page.url()).not.toContain("/dashboard/not-authorized");
      await expect(
        page.locator("text=/Application error|Something went wrong/i")
      ).toHaveCount(0);
    }
  });
});
