import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  seedAdmission,
  seedPatient,
  stubAi,
} from "./helpers";

/**
 * Inpatient Medication Administration Record (MAR) end-to-end coverage.
 *
 * Multi-role flow:
 *   - DOCTOR places an inpatient medication order on the admission detail page.
 *   - NURSE opens the medication dashboard / MAR view, sees the dose, and
 *     marks it as administered. Status flip is verified via API.
 *   - Overdue badges and the vitals chart on the admission detail page are
 *     also exercised.
 *
 * This spec is intentionally NOT in the regression project — it lives only
 * in `--project=full` because it depends on a freshly-seeded admission
 * record (and thus a writable bed) which is not guaranteed in the smoke /
 * regression slices.
 */

test.describe("Admissions MAR — multi-role workflow", () => {
  test("DOCTOR places inpatient med order and order persists on the admission", async ({
    doctorPage,
    adminApi,
    doctorToken,
  }) => {
    const page = doctorPage;

    // Seed a brand-new patient + admission via API so the test owns its own
    // state. We never reuse `patient1@medcore.local` for IPD because state
    // (active admissions, prior orders) leaks across runs.
    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });

    // Block any AI explainer calls the admission detail page may fire so the
    // test never depends on Sarvam credentials.
    await stubAi(page, /\/api\/v1\/ai\/.*/, { success: true, data: null });

    // Place the medication order via API as DOCTOR. The admission detail
    // page's "+ Add Order" form does an async medicine-search before it can
    // submit, which is fragile in CI; the API is the contract under test
    // here. We still assert the persisted order shows up on the page via
    // the in-page list once we re-load.
    const orderRes = await apiPost(
      page.request,
      doctorToken,
      "/medication/orders",
      {
        admissionId: admission.id,
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "TID",
        route: "ORAL",
        instructions: "E2E seeded med order",
      }
    );
    expect(orderRes.status, "med order POST should succeed").toBe(201);
    expect(orderRes.body?.data?.id, "order returns an id").toBeTruthy();
    const orderId: string = orderRes.body.data.id;

    // Re-fetch and assert it's there: GET /medication/orders?admissionId=
    const list = await apiGet(
      page.request,
      doctorToken,
      `/medication/orders?admissionId=${admission.id}`
    );
    expect(list.status).toBe(200);
    const orders: Array<{ id: string; medicineName?: string }> =
      list.body?.data ?? [];
    expect(orders.find((o) => o.id === orderId)).toBeTruthy();

    // Sanity: the in-page Medications list updates too. Use the existing
    // `medication-orders-list` testid (already in the codebase).
    await page.goto(`/dashboard/admissions/${admission.id}`);
    await expect(
      page.getByRole("button", { name: /medication/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /^medication/i }).first().click();
    await expect(
      page.locator('[data-testid="medication-orders-list"]')
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("body")).toContainText(/paracetamol/i);
    await expectNotForbidden(page);
  });

  test("NURSE opens MAR dashboard and sees a due dose for the seeded patient", async ({
    nursePage,
    adminApi,
    doctorToken,
    nurseToken,
  }) => {
    const page = nursePage;

    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });

    // Place an order whose first dose is due immediately so the
    // /medication/administrations/due endpoint (now-15m … now+30m window)
    // picks it up.
    const startNow = new Date().toISOString();
    const orderRes = await apiPost(
      page.request,
      doctorToken,
      "/medication/orders",
      {
        admissionId: admission.id,
        medicineName: "Amoxicillin",
        dosage: "250mg",
        frequency: "QID",
        route: "ORAL",
        startDate: startNow,
      }
    );
    expect(orderRes.status).toBe(201);

    // Confirm at least one administration is in the "due" window via API
    // first — if the API doesn't return it, no UI assertion would help.
    const due = await apiGet(
      page.request,
      nurseToken,
      "/medication/administrations/due"
    );
    expect(due.status).toBe(200);
    const dueRows: Array<{ id: string; order: { admission: { id: string } } }> =
      due.body?.data ?? [];
    const ourRow = dueRows.find(
      (r) => r?.order?.admission?.id === admission.id
    );
    expect(ourRow, "seeded dose should appear in due list").toBeTruthy();

    await page.goto("/dashboard/medication-dashboard");
    await expect(
      page.getByRole("heading", { name: /medication administration/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The dashboard groups by patient — the seeded patient name should
    // render at least once. Use a string match because the page also
    // includes "Patient" in chrome.
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: 15_000,
    });
    await expectNotForbidden(page);
  });

  test("NURSE marks a dose ADMINISTERED and the audit row records administeredAt", async ({
    nursePage,
    adminApi,
    doctorToken,
    nurseToken,
  }) => {
    const page = nursePage;

    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });

    const orderRes = await apiPost(
      page.request,
      doctorToken,
      "/medication/orders",
      {
        admissionId: admission.id,
        medicineName: "Ibuprofen",
        dosage: "400mg",
        frequency: "TID",
        route: "ORAL",
        startDate: new Date().toISOString(),
      }
    );
    expect(orderRes.status).toBe(201);
    const administrations: Array<{ id: string; status: string }> =
      orderRes.body?.data?.administrations ?? [];
    expect(administrations.length).toBeGreaterThan(0);
    const firstDoseId = administrations[0].id;

    // Navigate the nurse to /dashboard/medication — the canonical short
    // URL redirects to /medication-dashboard (per src/app/dashboard/
    // medication/page.tsx). We just need an authed nurse page so the
    // PATCH carries the right tenant context; the actual flip is via API
    // since the dashboard list is filtered to a 30-min window and the
    // exact dose row is easier to address by id.
    await page.goto("/dashboard/medication");
    await expect(page).toHaveURL(/medication-dashboard/, { timeout: 10_000 });

    const patchRes = await page.request.patch(
      `${API_BASE}/medication/administrations/${firstDoseId}`,
      {
        headers: { Authorization: `Bearer ${nurseToken}` },
        data: { status: "ADMINISTERED" },
      }
    );
    expect(patchRes.status()).toBe(200);

    // Verify via API GET that administeredAt is now set on the dose.
    const after = await apiGet(
      page.request,
      nurseToken,
      `/medication/administrations?admissionId=${admission.id}`
    );
    expect(after.status).toBe(200);
    const rows: Array<{
      id: string;
      status: string;
      administeredAt?: string | null;
    }> = after.body?.data ?? [];
    const flipped = rows.find((r) => r.id === firstDoseId);
    expect(flipped?.status).toBe("ADMINISTERED");
    expect(flipped?.administeredAt).toBeTruthy();
    await expectNotForbidden(page);
  });

  test("Overdue dose surfaces an escalation marker on the dashboard", async ({
    nursePage,
    adminApi,
    doctorToken,
    nurseToken,
  }) => {
    const page = nursePage;

    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });

    // Backdated startDate so the first scheduled dose is already in the
    // past. /medication/administrations/due returns rows from the
    // (now - 15min, now + 30min) window — schedule 10 minutes ago so it
    // still falls into the window but renders as "Overdue".
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const orderRes = await apiPost(
      page.request,
      doctorToken,
      "/medication/orders",
      {
        admissionId: admission.id,
        medicineName: "Cefixime",
        dosage: "200mg",
        frequency: "BID",
        route: "ORAL",
        startDate: tenMinAgo,
      }
    );
    expect(orderRes.status).toBe(201);

    // Sanity: the administration row exists in the due window.
    const due = await apiGet(
      page.request,
      nurseToken,
      "/medication/administrations/due"
    );
    expect(due.status).toBe(200);
    const dueRows: Array<{
      scheduledAt: string;
      order: { admission: { id: string } };
    }> = due.body?.data ?? [];
    const ours = dueRows.find((r) => r.order.admission.id === admission.id);
    expect(ours, "overdue dose should still appear in due window").toBeTruthy();

    await page.goto("/dashboard/medication-dashboard");
    await expect(
      page.getByRole("heading", { name: /medication administration/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The dashboard renders an "Overdue" pill (see urgencyClass() in
    // medication-dashboard/page.tsx → label "Overdue" when scheduledAt is
    // in the past). Match case-insensitively because the badge text is
    // the literal "Overdue".
    await expect(page.locator("body")).toContainText(/overdue/i, {
      timeout: 15_000,
    });
    await expectNotForbidden(page);
  });

  test("Vitals tab on admission detail renders nurse-recorded series", async ({
    nursePage,
    adminApi,
    nurseToken,
  }) => {
    const page = nursePage;

    const patient = await seedPatient(adminApi);
    const admission = await seedAdmission(adminApi, { patientId: patient.id });

    // Seed two readings via API so the chart/table has a series to render.
    // The admissions vitals route accepts NURSE/DOCTOR/ADMIN.
    for (const reading of [
      {
        bloodPressureSystolic: 122,
        bloodPressureDiastolic: 78,
        pulseRate: 76,
        temperature: 36.7,
        temperatureUnit: "C" as const,
      },
      {
        bloodPressureSystolic: 118,
        bloodPressureDiastolic: 74,
        pulseRate: 72,
        temperature: 36.9,
        temperatureUnit: "C" as const,
      },
    ]) {
      const r = await apiPost(
        page.request,
        nurseToken,
        `/admissions/${admission.id}/vitals`,
        { admissionId: admission.id, ...reading }
      );
      expect(r.status, "vitals POST should succeed").toBe(201);
    }

    await page.goto(`/dashboard/admissions/${admission.id}`);
    // Wait for the detail page header (patient name) before flipping tabs.
    await expect(page.locator("body")).toContainText(patient.name, {
      timeout: 15_000,
    });

    // Flip to the Vitals tab. The admission detail renders a chart/table
    // container — there is no dedicated chart SVG today (the Vitals tab
    // is a table), so we assert on the rendered series instead of SVG
    // geometry, per the task brief.
    await page.getByRole("button", { name: /^vitals$/i }).first().click();

    // Two distinct readings should both render (BP "122/78" and "118/74"
    // are unique strings from the seed).
    await expect(page.locator("body")).toContainText("122/78", {
      timeout: 15_000,
    });
    await expect(page.locator("body")).toContainText("118/74");
    await expectNotForbidden(page);
  });
});
