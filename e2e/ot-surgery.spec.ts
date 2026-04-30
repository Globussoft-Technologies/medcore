import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  seedPatient,
  stubAi,
} from "./helpers";

/**
 * Operating-theater surgery flow — multi-role end-to-end coverage.
 *
 *   ADMIN  → creates an OT and schedules a surgery slot.
 *   NURSE  → completes the pre-op checklist on the surgery detail page.
 *   DOCTOR → starts the surgery, then completes it with post-op notes.
 *   NURSE  → raises a blood-bank requisition tied to the same patient.
 *   ADMIN  → reopens the OT calendar and confirms the case is marked
 *            COMPLETED in the week view.
 *
 * Scoped to `--project=full` only. The flow depends on a freshly-seeded
 * patient + a freshly-created OT so it's safe to run repeatedly without
 * leaking state into the smoke/regression slices.
 *
 * Notes on assumptions (challenge these if they regress):
 *  - `/dashboard/operating-theaters` is a hard redirect to `/dashboard/ot`
 *    (issue #158). We assert the destination URL after redirect rather
 *    than the redirect stub, so the test still passes if the redirect
 *    target moves.
 *  - The "/dashboard/surgery/[id]/pre-op" path doesn't exist — pre-op
 *    lives inline on the surgery detail page (PreOpChecklistCard). We
 *    use that surface and assert checkbox toggling persists via API.
 *  - BloodRequest has no FK to Surgery. Linkage is asserted via the
 *    shared patientId + by including the case number in the request
 *    `reason` field, which is what the UI surfaces in the requests list.
 */

const SHARED_OT_NAME = `OT-E2E-${Date.now()}`;

test.describe("OT surgery flow — admin schedules → nurse pre-op → doctor runs → blood-bank → calendar", () => {
  // Stub any AI explainer hits so the test never depends on Sarvam creds.
  test.beforeEach(async ({ adminPage, doctorPage, nursePage }) => {
    for (const p of [adminPage, doctorPage, nursePage]) {
      await stubAi(p, /\/api\/v1\/ai\/.*/, { success: true, data: null });
    }
  });

  test("ADMIN schedules an OT slot and the row appears in the surgery list + OT week calendar", async ({
    adminPage,
    adminApi,
    adminToken,
  }) => {
    const page = adminPage;

    // 1. Seed a fresh patient.
    const patient = await seedPatient(adminApi);

    // 2. Make sure we have an OT to schedule against. Reuse if a previous
    //    test in the same worker already created one, otherwise create.
    const ot = await ensureOT(adminApi);

    // 3. Pick a doctor row to use as `surgeonId`.
    const doctorId = await firstDoctorId(adminApi);

    // 4. Schedule a surgery via API. The schedule modal on /dashboard/surgery
    //    is a long form with an ICD-10 autocomplete — driving it through the
    //    UI is fragile. We schedule via API and then assert the row shows up
    //    in the calendar/list, which is the contract under test for case (1).
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const create = await apiPost(page.request, adminToken, "/surgery", {
      patientId: patient.id,
      surgeonId: doctorId,
      otId: ot.id,
      procedure: "E2E test laparoscopic appendectomy",
      scheduledAt,
      durationMin: 60,
      preOpNotes: "Seeded by ot-surgery.spec.ts",
    });
    expect(create.status, "POST /surgery should succeed").toBe(201);
    const surgeryId: string = create.body.data.id;
    const caseNumber: string = create.body.data.caseNumber;
    expect(surgeryId).toBeTruthy();
    expect(caseNumber).toBeTruthy();

    // 5. Land on the canonical OT page (the hyphen alias just redirects).
    await page.goto("/dashboard/operating-theaters");
    await expect(page).toHaveURL(/\/dashboard\/ot\b/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /operating theaters/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Click our OT row to open the week calendar.
    await page.getByRole("cell", { name: ot.name }).first().click();

    // The week calendar renders the procedure string for each scheduled case.
    await expect(page.locator("body")).toContainText(
      "E2E test laparoscopic appendectomy",
      { timeout: 15_000 }
    );
    // Patient name also surfaces in the day cell.
    await expect(page.locator("body")).toContainText(patient.name);

    // 6. The surgery list page shows the row too — keyed by case number.
    await page.goto("/dashboard/surgery");
    await expect(
      page.getByRole("heading", { name: /surgery/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Clear the date filter so the row (which may be later today) isn't
    // hidden by the default "from today" guard.
    const fromInput = page.locator('[data-testid="surgery-filter-from"]');
    if (await fromInput.isVisible().catch(() => false)) {
      await fromInput.fill("");
    }
    await expect(page.locator("body")).toContainText(caseNumber, {
      timeout: 15_000,
    });
    await expectNotForbidden(page);

    // Stash the IDs on the test info so a follow-up flow could chain.
    test.info().annotations.push({
      type: "seeded-surgery",
      description: `surgeryId=${surgeryId} caseNumber=${caseNumber} otId=${ot.id} patientId=${patient.id}`,
    });
  });

  test("NURSE toggles a pre-op checklist item and the change persists via API", async ({
    nursePage,
    adminApi,
    adminToken,
    nurseToken,
  }) => {
    const page = nursePage;

    const surgeryId = await scheduleFreshSurgery(page.request, adminApi, adminToken);

    // Pre-op surface lives on the surgery detail page (PreOpChecklistCard).
    // No dedicated /dashboard/surgery/[id]/pre-op route exists today.
    await page.goto(`/dashboard/surgery/${surgeryId}`);
    await expect(
      page.getByRole("heading", { name: /pre-op checklist/i })
    ).toBeVisible({ timeout: 15_000 });

    // The checklist exposes 5 native checkboxes. Tick the first unchecked
    // one ("Consent signed" etc.) — no surrogate UI to fight with.
    const checkboxes = page.locator(
      'label:has-text("Consent signed") input[type="checkbox"], ' +
        'label:has-text("Allergies verified") input[type="checkbox"], ' +
        'label:has-text("Surgical site marked") input[type="checkbox"]'
    );
    const first = checkboxes.first();
    await expect(first).toBeVisible({ timeout: 10_000 });
    expect(await first.isChecked()).toBe(false);
    await first.check();

    // The card PATCHes /surgery/:id/preop on toggle. Wait for the in-page
    // "X/5 complete" counter to tick (means the API round-trip landed and
    // the page re-fetched).
    await expect(page.locator("body")).toContainText(/[1-5]\/5 complete/, {
      timeout: 10_000,
    });

    // Verify via API GET that at least one of the boolean flags is set.
    const after = await apiGet(page.request, nurseToken, `/surgery/${surgeryId}`);
    expect(after.status).toBe(200);
    const s = after.body?.data;
    const anyToggled =
      !!s?.consentSigned || !!s?.allergiesVerified || !!s?.siteMarked;
    expect(anyToggled, "at least one preop flag should be set").toBe(true);
    await expectNotForbidden(page);
  });

  test("DOCTOR starts then completes a surgery — status transitions persist via API", async ({
    doctorPage,
    adminApi,
    adminToken,
    doctorToken,
  }) => {
    const page = doctorPage;

    const surgeryId = await scheduleFreshSurgery(page.request, adminApi, adminToken);

    // Satisfy pre-op via API so /start doesn't 400 on the checklist guard.
    // The /:id/start endpoint requires consentSigned, npoSince,
    // allergiesVerified, siteMarked.
    const npoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const preop = await page.request.patch(
      `${API_BASE}/surgery/${surgeryId}/preop`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: {
          consentSigned: true,
          npoSince: npoIso,
          allergiesVerified: true,
          siteMarked: true,
        },
      }
    );
    expect(preop.status(), "preop seed should succeed").toBe(200);

    await page.goto(`/dashboard/surgery/${surgeryId}`);
    await expect(
      page.getByRole("heading", { name: /pre-op checklist/i })
    ).toBeVisible({ timeout: 15_000 });

    // Click the visible "Start Surgery" action.
    const startBtn = page.getByRole("button", { name: /start surgery/i }).first();
    await expect(startBtn).toBeVisible({ timeout: 10_000 });
    await startBtn.click();

    // Status pill should flip to "IN PROGRESS".
    await expect(
      page.locator('[data-testid="surgery-detail-status"]')
    ).toHaveText(/in progress/i, { timeout: 15_000 });

    // Verify via API that the row is IN_PROGRESS with actualStartAt set.
    const inProgress = await apiGet(
      page.request,
      doctorToken,
      `/surgery/${surgeryId}`
    );
    expect(inProgress.body?.data?.status).toBe("IN_PROGRESS");
    expect(inProgress.body?.data?.actualStartAt).toBeTruthy();

    // Complete via API — the in-page Complete button opens a prompt dialog
    // that's awkward to fill from a detail-page Complete with notes; the
    // API path lets us send postOpNotes deterministically. The detail page
    // posts the same payload.
    const complete = await page.request.patch(
      `${API_BASE}/surgery/${surgeryId}/complete`,
      {
        headers: { Authorization: `Bearer ${doctorToken}` },
        data: {
          postOpNotes: "E2E completion — vitals stable, transferred to PACU.",
          diagnosis: "K35.80 — Acute appendicitis (E2E)",
        },
      }
    );
    expect(complete.status(), "complete should succeed").toBe(200);

    // Re-load and assert the pill is COMPLETED in the UI.
    await page.reload();
    await expect(
      page.locator('[data-testid="surgery-detail-status"]')
    ).toHaveText(/completed/i, { timeout: 15_000 });

    // API double-check.
    const completed = await apiGet(
      page.request,
      doctorToken,
      `/surgery/${surgeryId}`
    );
    expect(completed.body?.data?.status).toBe("COMPLETED");
    expect(completed.body?.data?.actualEndAt).toBeTruthy();
    expect(completed.body?.data?.postOpNotes).toContain("E2E completion");
    await expectNotForbidden(page);
  });

  test("Blood-bank requisition raised against the surgery patient appears in the requests list", async ({
    nursePage,
    adminApi,
    adminToken,
    nurseToken,
  }) => {
    const page = nursePage;

    const patient = await seedPatient(adminApi);
    const ot = await ensureOT(adminApi);
    const doctorId = await firstDoctorId(adminApi);

    // Schedule the surgery so we can tag the requisition's `reason` with
    // its case number — the only place to surface a surgery↔request link
    // in the current data model (BloodRequest has no surgeryId FK).
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sx = await apiPost(page.request, adminToken, "/surgery", {
      patientId: patient.id,
      surgeonId: doctorId,
      otId: ot.id,
      procedure: "E2E procedure for blood requisition",
      scheduledAt,
      durationMin: 90,
    });
    expect(sx.status).toBe(201);
    const caseNumber: string = sx.body.data.caseNumber;

    // NURSE creates the blood request via API. The UI form lives on
    // /dashboard/bloodbank → "+ New Request" but it's a multi-step modal;
    // the API contract is the actual artifact under test.
    const reqRes = await apiPost(page.request, nurseToken, "/bloodbank/requests", {
      patientId: patient.id,
      bloodGroup: "O_POS",
      component: "PACKED_RED_CELLS",
      unitsRequested: 2,
      reason: `Pre-op crossmatch for ${caseNumber} (E2E)`,
      urgency: "URGENT",
    });
    expect(reqRes.status, "POST /bloodbank/requests should succeed").toBe(201);
    const requestNumber: string = reqRes.body.data.requestNumber;
    expect(requestNumber).toBeTruthy();

    // Hit the hyphenated alias to also cover the redirect — the canonical
    // page is /dashboard/bloodbank.
    await page.goto("/dashboard/blood-bank");
    await expect(page).toHaveURL(/\/dashboard\/bloodbank\b/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /blood bank/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Open the Requests tab. The page renders four tabs labelled
    // Inventory / Donors / Donations / Requests.
    const requestsTab = page.getByRole("button", { name: /^requests$/i }).first();
    if (await requestsTab.isVisible().catch(() => false)) {
      await requestsTab.click();
    }

    // The new request row should be reachable by request number AND by the
    // case-number string we threaded into `reason`.
    await expect(page.locator("body")).toContainText(requestNumber, {
      timeout: 15_000,
    });
    await expect(page.locator("body")).toContainText(caseNumber);

    // Cross-check the API directly: the request row carries the same
    // patientId as our surgery, which is the canonical linkage.
    const list = await apiGet(page.request, nurseToken, "/bloodbank/requests?limit=50");
    expect(list.status).toBe(200);
    const rows: Array<{
      id: string;
      requestNumber: string;
      patient?: { id?: string };
      reason?: string;
    }> = list.body?.data ?? [];
    const ours = rows.find((r) => r.requestNumber === requestNumber);
    expect(ours, "freshly created request should be in the list").toBeTruthy();
    expect(ours?.patient?.id).toBe(patient.id);
    expect(ours?.reason).toContain(caseNumber);
    await expectNotForbidden(page);
  });

  test("OT calendar reflects status: a COMPLETED case appears in the week view", async ({
    adminPage,
    adminApi,
    adminToken,
  }) => {
    const page = adminPage;

    // Seed + schedule + drive to COMPLETED via API so this test owns its
    // entire lifecycle (no dependency on the doctor-flow test ordering).
    const patient = await seedPatient(adminApi);
    const ot = await ensureOT(adminApi);
    const doctorId = await firstDoctorId(adminApi);

    const scheduledAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sx = await apiPost(page.request, adminToken, "/surgery", {
      patientId: patient.id,
      surgeonId: doctorId,
      otId: ot.id,
      procedure: "E2E completion-status calendar check",
      scheduledAt,
      durationMin: 30,
    });
    expect(sx.status).toBe(201);
    const surgeryId: string = sx.body.data.id;
    const caseNumber: string = sx.body.data.caseNumber;

    // Satisfy pre-op + start + complete in three API hops.
    const headers = { Authorization: `Bearer ${adminToken}` };
    const npoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const preop = await page.request.patch(
      `${API_BASE}/surgery/${surgeryId}/preop`,
      {
        headers,
        data: {
          consentSigned: true,
          npoSince: npoIso,
          allergiesVerified: true,
          siteMarked: true,
        },
      }
    );
    expect(preop.status()).toBe(200);
    const start = await page.request.patch(
      `${API_BASE}/surgery/${surgeryId}/start`,
      { headers, data: {} }
    );
    expect(start.status()).toBe(200);
    const complete = await page.request.patch(
      `${API_BASE}/surgery/${surgeryId}/complete`,
      {
        headers,
        data: {
          postOpNotes: "E2E completion for calendar status check",
        },
      }
    );
    expect(complete.status()).toBe(200);

    // Open the OT calendar and pick our OT.
    await page.goto("/dashboard/ot");
    await expect(
      page.getByRole("heading", { name: /operating theaters/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("cell", { name: ot.name }).first().click();

    // The week calendar renders the procedure inside the day cell.
    await expect(page.locator("body")).toContainText(
      "E2E completion-status calendar check",
      { timeout: 15_000 }
    );

    // Status is the source of truth — verify on the surgery list page where
    // the per-row status badge has a stable testid.
    await page.goto("/dashboard/surgery");
    // Switch to the COMPLETED tab so the row is in scope.
    await page.getByRole("button", { name: /^completed$/i }).first().click();
    // Clear the date filter so a future-dated scheduledAt isn't filtered out.
    const fromInput = page.locator('[data-testid="surgery-filter-from"]');
    if (await fromInput.isVisible().catch(() => false)) {
      await fromInput.fill("");
    }
    await expect(page.locator("body")).toContainText(caseNumber, {
      timeout: 15_000,
    });
    await expect(
      page.locator(`[data-testid="surgery-status-${surgeryId}"]`)
    ).toHaveText(/completed/i, { timeout: 10_000 });
    await expectNotForbidden(page);
  });
});

// ─── Local helpers (file-scoped) ─────────────────────────────────────────

async function ensureOT(
  api: import("@playwright/test").APIRequestContext
): Promise<{ id: string; name: string }> {
  // Try to find any active OT first; otherwise create one. The list endpoint
  // is GET /surgery/ots and accepts an `includeInactive` flag (default off).
  const list = await api.get(`${API_BASE}/surgery/ots`);
  if (list.ok()) {
    const json = await list.json();
    const ots: Array<{ id: string; name: string; isActive: boolean }> =
      json.data ?? [];
    const active = ots.find((o) => o.isActive);
    if (active) return { id: active.id, name: active.name };
  }
  // None active — create a fresh one. Idempotency-of-name isn't required
  // because the schema only enforces min(1).
  const create = await api.post(`${API_BASE}/surgery/ots`, {
    data: { name: SHARED_OT_NAME, floor: "1", dailyRate: 0 },
  });
  if (!create.ok()) {
    throw new Error(
      `ensureOT: cannot create OT: ${create.status()} ${(await create.text()).slice(
        0,
        200
      )}`
    );
  }
  const cj = await create.json();
  return { id: cj.data.id, name: cj.data.name };
}

async function firstDoctorId(
  api: import("@playwright/test").APIRequestContext
): Promise<string> {
  const res = await api.get(`${API_BASE}/doctors`);
  if (!res.ok()) {
    throw new Error(
      `firstDoctorId: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const list = json.data ?? json;
  const first = Array.isArray(list) ? list[0] : list?.doctors?.[0];
  if (!first?.id) throw new Error("firstDoctorId: no doctor available");
  return first.id;
}

async function scheduleFreshSurgery(
  pageRequest: import("@playwright/test").APIRequestContext,
  adminApi: import("@playwright/test").APIRequestContext,
  adminToken: string
): Promise<string> {
  const patient = await seedPatient(adminApi);
  const ot = await ensureOT(adminApi);
  const doctorId = await firstDoctorId(adminApi);
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const create = await apiPost(pageRequest, adminToken, "/surgery", {
    patientId: patient.id,
    surgeonId: doctorId,
    otId: ot.id,
    procedure: "E2E surgery for downstream test",
    scheduledAt,
    durationMin: 60,
  });
  if (create.status !== 201) {
    throw new Error(
      `scheduleFreshSurgery: POST /surgery returned ${create.status} ${JSON.stringify(
        create.body
      ).slice(0, 200)}`
    );
  }
  return create.body.data.id;
}
