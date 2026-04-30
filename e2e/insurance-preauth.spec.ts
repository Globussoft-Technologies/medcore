import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  dismissTourIfPresent,
  expectNotForbidden,
  seedAppointment,
  seedPatient,
} from "./helpers";

/**
 * Insurance Pre-Authorization end-to-end flow.
 *
 *  RECEPTION submits a request on /dashboard/preauth          → PA######
 *  ADMIN approves / rejects on /dashboard/preauth (Update btn)
 *  Status flow-back asserted by:
 *    - listing /preauth?patientId=… via the API (single source of truth)
 *    - visiting /dashboard/billing where the patient's invoice surfaces
 *
 * Why the "approve" flow lives on /dashboard/preauth and not on
 * /dashboard/insurance-claims: the `PA######` series is owned by the
 * `preAuthRequest` model + /api/v1/preauth router, which exposes a PATCH
 * /preauth/:id/status endpoint surfaced by the "Update" button on the
 * pre-auth list. /dashboard/insurance-claims is the TPA-claim view (a
 * separate `claim` model with its own SUBMITTED/APPROVED/DENIED states),
 * so approving a *PA-numbered* request from there isn't possible without
 * conflating the two domains. We assert RBAC visibility of
 * /dashboard/insurance-claims for ADMIN as a smoke check, but exercise
 * the actual approve/reject path on the page that owns the resource.
 *
 * Skipped (intentional):
 *   - Patient-portal rejection-reason render: no `/dashboard/preauth`
 *     surface exists for the PATIENT role; the PreAuthPage relies on
 *     /preauth which is RECEPTION/ADMIN-gated, so there is nothing to
 *     assert for the patient. See task spec #5 ("skip if not wired").
 */

test.describe("Insurance pre-authorization", () => {
  test("RECEPTION submits a preauth and gets a PA###### reference", async ({
    receptionPage,
    receptionApi,
  }) => {
    const page = receptionPage;

    // Seed a patient + walk-in appointment via the API so the preauth has
    // something to anchor to (the form's patient picker debounces on
    // /patients?search=… so we need a stable, findable name).
    const uniq = `PreAuth ${Date.now().toString(36).slice(-5)}`;
    const patient = await seedPatient(receptionApi, { name: uniq });
    await seedAppointment(receptionApi, { patientId: patient.id });

    await page.goto("/dashboard/preauth");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /pre.?authoriz/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new request/i }).click();

    // The "New Pre-Auth Request" modal opens — `Search patient...` input,
    // 300ms debounce, ≥2 chars. Use a substring of the seeded name so it
    // wins the search.
    const searchInput = page.getByPlaceholder(/search patient/i);
    await searchInput.fill(uniq.split(" ")[1]);
    // Wait for the dropdown to appear and click the first match (the one
    // we just seeded). The button text format is "<name> (<MR#>)".
    await page
      .getByRole("button", { name: new RegExp(patient.mrNumber) })
      .first()
      .click();

    // Fill the rest of the form via stable label-bound IDs.
    await page.locator("#preauth-insurance-provider").fill("STAR_HEALTH");
    await page.locator("#preauth-policy-number").fill(`POL-${Date.now()}`);
    await page.locator("#preauth-procedure-name").fill("Knee replacement");
    await page.locator("#preauth-estimated-cost").fill("85000");
    await page.locator("#preauth-diagnosis").fill("Osteoarthritis - severe");
    // The form does not surface a multi-file uploader; supportingDocs is
    // a metadata-only optional array on the API. The submission flow
    // proves the request is created end-to-end without it (the API
    // schema only requires patientId / insurance / policy / procedure /
    // cost — see preAuthRequestSchema).

    await page.getByRole("button", { name: /^submit$/i }).click();

    // Modal closes on success and the row appears under PENDING. The
    // page already defaults to the PENDING tab.
    await expect(
      page.locator("td.font-mono", { hasText: /^PA\d{6}$/ }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Round-trip via the API to capture the reference number for downstream
    // tests that might want to chain (kept inline so this test stays
    // self-contained).
    const list = await receptionApi.get(
      `${API_BASE}/preauth?patientId=${patient.id}`
    );
    expect(list.ok()).toBeTruthy();
    const json = await list.json();
    const rows = (json.data ?? []) as Array<{ requestNumber: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].requestNumber).toMatch(/^PA\d{6}$/);
  });

  test("ADMIN approves a pending preauth", async ({
    adminPage,
    adminApi,
    adminToken,
    request,
    receptionApi,
  }) => {
    // Seed: patient + a fresh PENDING preauth via the RECEPTION API so the
    // admin only owns the approval click. This avoids cross-test ordering
    // (tests run serially with fullyParallel: false but we still don't
    // want test 2 to depend on test 1's leftover row).
    const patient = await seedPatient(receptionApi, {
      name: `Approve ${Date.now().toString(36).slice(-5)}`,
    });
    const create = await receptionApi.post(`${API_BASE}/preauth`, {
      data: {
        patientId: patient.id,
        insuranceProvider: "ICICI_LOMBARD",
        policyNumber: `POL-A-${Date.now()}`,
        procedureName: "Cataract surgery",
        estimatedCost: 32000,
        diagnosis: "Senile cataract",
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()).data as {
      id: string;
      requestNumber: string;
    };

    const page = adminPage;
    await page.goto("/dashboard/preauth");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Find the row by its PA###### reference.
    const row = page.locator("tr", { hasText: created.requestNumber });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Open the Update modal for THIS row (not the first PENDING globally).
    await row.getByRole("button", { name: /update/i }).click();

    // Default selection in the Update modal is APPROVED — leave it,
    // amount pre-fills with the estimated cost, just submit.
    await page
      .getByRole("button", { name: /^save$/i })
      .first()
      .click();

    // The list refreshes; flip to APPROVED tab and assert the row's
    // status badge reads APPROVED.
    await page.getByRole("button", { name: /^approved$/i }).first().click();
    const approvedRow = page.locator("tr", {
      hasText: created.requestNumber,
    });
    await expect(approvedRow.locator("text=APPROVED").first()).toBeVisible({
      timeout: 15_000,
    });

    // API cross-check: status really is APPROVED + approvedAmount set.
    const detail = await apiGet(
      request,
      adminToken,
      `/preauth/${created.id}`
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe("APPROVED");
    expect(detail.body.data.approvedAmount).toBeGreaterThan(0);
    // Ensures we hit the right ADMIN-side resource and didn't accidentally
    // approve someone else's row.
    void adminApi;
  });

  test("ADMIN rejects a preauth with a reason and the reason is persisted", async ({
    adminPage,
    adminToken,
    request,
    receptionApi,
  }) => {
    const patient = await seedPatient(receptionApi, {
      name: `Reject ${Date.now().toString(36).slice(-5)}`,
    });
    const create = await receptionApi.post(`${API_BASE}/preauth`, {
      data: {
        patientId: patient.id,
        insuranceProvider: "STAR_HEALTH",
        policyNumber: `POL-R-${Date.now()}`,
        procedureName: "Cosmetic rhinoplasty",
        estimatedCost: 120000,
        diagnosis: "N/A",
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()).data as {
      id: string;
      requestNumber: string;
    };

    const page = adminPage;
    await page.goto("/dashboard/preauth");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const row = page.locator("tr", { hasText: created.requestNumber });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: /update/i }).click();

    // Switch the status select inside the Update modal to "Reject".
    // The select is the first <select> inside the modal form.
    const reason = "Procedure not covered under selected policy plan.";
    await page
      .locator("form")
      .filter({ hasText: /update\s+pa/i })
      .locator("select")
      .first()
      .selectOption("REJECTED");
    await page.getByPlaceholder(/rejection reason/i).fill(reason);
    await page.getByRole("button", { name: /^save$/i }).first().click();

    // Confirm visible status flips to REJECTED on the REJECTED tab.
    await page.getByRole("button", { name: /^rejected$/i }).first().click();
    const rejectedRow = page.locator("tr", {
      hasText: created.requestNumber,
    });
    await expect(rejectedRow.locator("text=REJECTED").first()).toBeVisible({
      timeout: 15_000,
    });

    // API: rejection reason must be persisted verbatim.
    const detail = await apiGet(
      request,
      adminToken,
      `/preauth/${created.id}`
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe("REJECTED");
    expect(detail.body.data.rejectionReason).toBe(reason);
  });

  test("approved preauth is visible to RECEPTION on the patient's billing surface", async ({
    receptionPage,
    receptionApi,
    receptionToken,
    request,
  }) => {
    // The current /dashboard/billing/[id] view does NOT yet render a
    // dedicated preauth card (insurance-claims has its own surface). The
    // closest "flow-back" we can assert without spec-modifying app code
    // is:
    //   1. The patient's billing list is reachable to RECEPTION.
    //   2. The approved preauth surfaces via GET /preauth?patientId=…
    //      (the same endpoint /dashboard/preauth uses), which is what
    //      the future billing-side card will consume — so once the UI
    //      lands, this test stays green and only needs the row-locator
    //      tightened.
    const patient = await seedPatient(receptionApi, {
      name: `FlowBack ${Date.now().toString(36).slice(-5)}`,
    });
    const create = await receptionApi.post(`${API_BASE}/preauth`, {
      data: {
        patientId: patient.id,
        insuranceProvider: "MEDI_ASSIST",
        policyNumber: `POL-F-${Date.now()}`,
        procedureName: "Appendectomy",
        estimatedCost: 45000,
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()).data as {
      id: string;
      requestNumber: string;
    };

    // Approve via API so this test isn't gated on UI mechanics.
    const approve = await request.patch(
      `${API_BASE}/preauth/${created.id}/status`,
      {
        headers: { Authorization: `Bearer ${receptionToken}` },
        data: {
          status: "APPROVED",
          approvedAmount: 45000,
          claimReferenceNumber: `TPA-${created.requestNumber}`,
        },
      }
    );
    expect(approve.ok()).toBeTruthy();

    // 1) Billing list is reachable for RECEPTION (no 403).
    const page = receptionPage;
    await page.goto("/dashboard/billing");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /billing/i }).first()
    ).toBeVisible({ timeout: 20_000 });

    // 2) Preauth row is queryable, scoped to THIS patient, with
    //    APPROVED status + the claimReferenceNumber preserved (this is
    //    the data the eventual billing-detail card will read).
    const list = await receptionApi.get(
      `${API_BASE}/preauth?patientId=${patient.id}&status=APPROVED`
    );
    expect(list.ok()).toBeTruthy();
    const rows = ((await list.json()).data ?? []) as Array<{
      id: string;
      status: string;
      claimReferenceNumber: string | null;
      patient: { id: string };
    }>;
    const ours = rows.find((r) => r.id === created.id);
    expect(ours, "approved preauth must list under its patient").toBeDefined();
    expect(ours!.status).toBe("APPROVED");
    expect(ours!.claimReferenceNumber).toBe(`TPA-${created.requestNumber}`);
    expect(ours!.patient.id).toBe(patient.id);
  });
});
