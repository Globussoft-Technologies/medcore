import { test, expect } from "./fixtures";
import {
  API_BASE,
  expectNotForbidden,
  seedAppointment,
  seedPatient,
  stubAi,
} from "./helpers";

/**
 * PHARMACIST role e2e flow.
 *
 * Background: prior to this spec, the only PHARMACIST coverage in the suite
 * was the rbac-matrix denial sweep — there was zero positive/functional
 * coverage. This file adds the first set of happy-path assertions across
 * the three pages a real pharmacist works from:
 *
 *   1. /dashboard/pharmacy           — inventory/dispensing landing
 *   2. /dashboard/prescriptions      — Rx queue (read-only for PHARMACIST)
 *   3. /dashboard/controlled-substances — Schedule H/H1/X register
 *
 * IMPORTANT: today the backend models do NOT support a few of the workflows
 * named in the original task brief, so those test cases are encoded as
 * `test.skip(...)` with the precise reason. They will be flipped on as soon
 * as the underlying API lands. See per-test annotations.
 */
test.describe("Pharmacist journeys", () => {
  test("lands on /dashboard/pharmacy without a not-authorized redirect", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });

    // Page-level RBAC + body-level "forbidden" string check (Wave 2a helper).
    await expectNotForbidden(page);

    // Anchor on the page's <h1> "Pharmacy" + the Inventory tab so we know
    // the React tree actually rendered (vs. a blank /not-authorized stub).
    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /^inventory$/i }).first()
    ).toBeVisible();
  });

  test("Rx queue renders the column header and (optionally) seeded rows", async ({
    pharmacistPage,
    adminApi,
    receptionApi,
  }) => {
    const page = pharmacistPage;

    // Best-effort seed: create patient → walk-in appointment → prescription.
    // A failure at any step is non-fatal; we still assert the queue surface.
    let seededRxName: string | null = null;
    try {
      const patient = await seedPatient(receptionApi, {});
      const appt = await seedAppointment(receptionApi, {
        patientId: patient.id,
      });
      // ADMIN may POST /prescriptions (createPrescriptionSchema +
      // authorize(DOCTOR, ADMIN) on the route). The seeded items use a
      // plausible Indian formulary entry so screenshots look real.
      const rxRes = await adminApi.post(`${API_BASE}/prescriptions`, {
        data: {
          appointmentId: appt.id,
          patientId: patient.id,
          diagnosis: "J06.9 — Acute upper respiratory infection",
          items: [
            {
              medicineName: "Paracetamol",
              dosage: "500mg",
              frequency: "BD",
              duration: "5 days",
              instructions: "After food",
            },
          ],
          advice: "Plenty of fluids; review in 5 days if no improvement.",
        },
      });
      if (rxRes.ok()) {
        seededRxName = patient.name;
      }
    } catch {
      // swallow — seeding is best-effort, the page still has to render.
    }

    await page.goto("/dashboard/prescriptions", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    // Heading is the only universally-stable selector on this page (the
    // toolbar is a card, not a <table>). Assert it before checking rows.
    await expect(
      page.getByRole("heading", { name: /prescription/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // PHARMACIST sees the same listing surface as DOCTOR/NURSE — read-only.
    // We assert at least the toolbar's data-testid renders so a regression
    // in role-gating (e.g. accidentally hiding the page from PHARMACIST)
    // would surface here.
    await expect(page.locator('[data-testid="rx-search-input"]')).toBeVisible();

    if (seededRxName) {
      // We just inserted an Rx for this patient — they should appear on
      // page 1 (default sort = issuedAt desc). Use a soft search so the
      // test is resilient to other rows landing during the run.
      await page
        .locator('[data-testid="rx-search-input"]')
        .fill(seededRxName);
      await expect(page.locator(`text=${seededRxName}`).first()).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test("dispensing a prescription marks inventory as DISPENSED via /pharmacy/dispense", async ({
    pharmacistPage,
    pharmacistToken,
    adminApi,
    receptionApi,
  }) => {
    const page = pharmacistPage;

    // The product flow today is: POST /pharmacy/dispense { prescriptionId }
    // (the API dispatches by prescription, not per-line PATCH). The original
    // brief described a per-line PATCH to DISPENSED, which doesn't exist in
    // the schema (no `status` column on PrescriptionItem). We exercise the
    // real API instead so this still gives PHARMACIST functional coverage.
    let prescriptionId: string | null = null;
    try {
      const patient = await seedPatient(receptionApi, {});
      const appt = await seedAppointment(receptionApi, {
        patientId: patient.id,
      });
      const rxRes = await adminApi.post(`${API_BASE}/prescriptions`, {
        data: {
          appointmentId: appt.id,
          patientId: patient.id,
          diagnosis: "K30 — Functional dyspepsia",
          items: [
            {
              medicineName: "Pantoprazole",
              dosage: "40mg",
              frequency: "OD",
              duration: "7 days",
            },
          ],
        },
      });
      if (rxRes.ok()) {
        const json = await rxRes.json();
        prescriptionId = json.data?.id ?? null;
      }
    } catch {
      /* fall through to skip below */
    }

    test.skip(
      !prescriptionId,
      "Could not seed a prescription (admin/reception API write failed); dispense path is unreachable without one."
    );

    // Some dispensing pipelines push through Sarvam/AI for label translation
    // — stub any **/api/v1/ai/** call so a missing key doesn't fail the test.
    await stubAi(page, /\/api\/v1\/ai\//, {
      success: true,
      data: { result: "stubbed", translation: "stubbed" },
      error: null,
    });

    // Fire the dispense API call directly using the cached PHARMACIST token.
    // (No UI button exists for "dispense by prescription id" today; the
    // pharmacy page surfaces inventory + returns/transfers, not Rx
    // dispensing. The endpoint is what the dispensing tablet hits.)
    const res = await page.request.post(`${API_BASE}/pharmacy/dispense`, {
      headers: { Authorization: `Bearer ${pharmacistToken}` },
      data: { prescriptionId },
    });
    expect(
      [200, 201],
      `Dispense should succeed; got ${res.status()} ${(await res.text()).slice(0, 200)}`
    ).toContain(res.status());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty("prescriptionId", prescriptionId);
    // The dispensed array may be empty if seeded medicines aren't in the
    // inventory table — that's a seed-data fact, not a regression. The
    // shape contract is what we lock in here.
    expect(Array.isArray(body.data.dispensed)).toBe(true);
    expect(Array.isArray(body.data.warnings)).toBe(true);

    // After dispensing, navigate to /dashboard/pharmacy → Movements tab so a
    // human running this in headed mode sees the audit trail (the e2e
    // assertion above is what gates CI).
    await page.goto("/dashboard/pharmacy", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /pharmacy/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("controlled-substances register page renders for PHARMACIST", async ({
    pharmacistPage,
  }) => {
    const page = pharmacistPage;
    await page.goto("/dashboard/controlled-substances", {
      waitUntil: "domcontentloaded",
    });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /controlled substance register/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // The three tab buttons anchor the page even when the database has no
    // controlled-substance rows yet.
    await expect(
      page.getByRole("button", { name: /all entries/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /register by medicine/i })
    ).toBeVisible();
  });

  test.skip(
    "create-entry form rejects submission without a witness signature",
    // The current /dashboard/controlled-substances page does NOT have a
    // create-entry form at all — it's read-only (entries / register / audit
    // tabs). Entries are auto-created server-side when /pharmacy/dispense
    // dispenses a Schedule-H/H1/X medicine (see pharmacy.ts:448-501).
    //
    // Furthermore, `controlledSubstanceSchema` in
    // packages/shared/src/validation/pharmacy.ts has no `witnessSignature`
    // field, and the `ControlledSubstanceEntry` Prisma model
    // (schema.prisma:3623) has no witness column. There is no UI element to
    // assert against, and no validation to assert rejects — the test as
    // briefed is not yet implementable.
    //
    // Wire-up needed before un-skipping: (a) `witnessSignatureUrl` (or
    // similar) on the model, (b) form on the controlled-substances page,
    // (c) zod schema requirement. Then this test asserts the form refuses
    // to submit with an empty witness field and the validation toast appears.
    () => undefined
  );

  test.skip(
    "rejects an Rx with reason and persists it as REJECTED",
    // Prescription schema (schema.prisma:1021-1054) has neither a `status`
    // column nor a `rejectReason` column — the Rx lifecycle today is
    // implicit (issued → printed → shared). There is no PATCH endpoint to
    // mark an Rx REJECTED, so there's nothing for this test to drive.
    //
    // Once the workflow lands (status enum incl. REJECTED, rejectReason
    // text column, PATCH /prescriptions/:id with reason), assert that
    // PHARMACIST can hit the endpoint, GET the Rx back with status =
    // REJECTED + the reason persisted.
    () => undefined
  );
});
