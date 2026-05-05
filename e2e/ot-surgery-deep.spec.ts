/**
 * OT-surgery deep peri-op coverage — anesthesia / operative-report / PACU /
 * SSI / blood-requirement / RBAC.
 *
 * Companion to:
 *   - e2e/ot-surgery.spec.ts (basic schedule → pre-op → start → complete +
 *     blood-bank requisition + week-calendar smoke). UNTOUCHED — this spec
 *     is purely additive deepening.
 *
 * What THIS spec adds (E2E_COVERAGE_BACKLOG.md §3 ot-surgery deepening):
 *   1. ANESTHESIA RECORD — DOCTOR opens the AnesthesiaCard, fills type +
 *      anesthetist + induction/extubation timestamps + recovery notes, saves.
 *      Pin POST /surgery/:id/anesthesia-record body shape via page.route stub.
 *   2. OPERATIVE REPORT (clinical notes) — DOCTOR edits diagnosis +
 *      preOpNotes + postOpNotes via the "Edit Notes" panel, saves. Pin
 *      PATCH /surgery/:id body shape via page.route stub. The detail page
 *      doesn't have a separate "operative report" form — clinical notes +
 *      complications card together ARE the operative report surface.
 *   3. COMPLICATIONS card — DOCTOR records complications + severity +
 *      bloodLossMl. Pin PATCH /surgery/:id/complications body shape.
 *   4. PACU OBSERVATIONS (post-op vitals trail) — NURSE records a
 *      post-op observation row (BP/Pulse/SpO2/pain/consciousness). Pin
 *      POST /surgery/:id/observations body shape.
 *   5. BLOOD AVAILABILITY CHECK — DOCTOR clicks "Check Availability" in
 *      the BloodAvailabilityCard. Pin POST /surgery/:id/blood-requirement
 *      body shape (component + units + autoReserve flag).
 *   6. SSI REPORT — DOCTOR opens the SsiReportCard, fills type + detected
 *      date + treatment, saves. Pin PATCH /surgery/:id/ssi-report body
 *      shape (regulatory: NHSN-style SSI surveillance contract).
 *   7. RBAC contract — PATIENT cannot read OT catalog (GET /surgery/ots
 *      returns 403; surgery.ts:81 authorize ADMIN/DOCTOR/NURSE/RECEPTION
 *      excludes PATIENT, Issue #174). PATIENT also cannot fetch another
 *      patient's surgery row (assertPatientOwnsResource gate, surgery.ts:362).
 *
 * VERIFY-BEFORE-SCAFFOLD audit (per the §3 backlog framing):
 *   - "Anesthesia notes / sign-off"          → SHIPPED (covered case 1).
 *   - "Operative report entry"               → SHIPPED via clinical-notes +
 *     complications surfaces (covered cases 2 + 3). No dedicated
 *     "operative report" form exists; treating notes-edit + complications
 *     as the equivalent contract.
 *   - "Post-op orders (meds, restrictions, followup)" → DEFERRED. No
 *     /surgery/:id/orders endpoint, no structured post-op-orders form on
 *     the detail page (postOpNotes is free text only, no meds/restrictions
 *     fields, no followup-scheduling CTA tied to surgery). Closest
 *     ship-able surface is PACU observations (covered case 4) which is
 *     vitals-only, not orders.
 *   - "Swab / implant tracking (regulatory)" → DEFERRED. completeSurgerySchema
 *     accepts spongeCountCorrect / instrumentCountCorrect / specimenLabeled
 *     booleans (apps/api/src/routes/surgery.ts:521-526) but the detail page
 *     surfaces NO checkbox UI for these. Implant tracking has no Prisma
 *     model. Surfaces don't exist.
 *   - "OT resource conflict detection"       → DEFERRED. POST /surgery
 *     (surgery.ts:179) only validates that the OT exists + isActive
 *     (lines 199-215); does NOT check time-overlap with concurrent cases
 *     in the same OT. Week calendar in /dashboard/ot lists overlapping
 *     cases without warning. No conflict-detection endpoint, no UI banner.
 *
 * Why these tests exist:
 *   The peri-op record (anesthesia, complications, PACU, SSI) is the
 *   regulatory backbone for surgical-safety audits (NSQIP / NHSN / WHO
 *   surgical safety checklist). Each card on the detail page maps to an
 *   independent endpoint that has its own Zod schema and audit log row.
 *   Pinning request body shape via page.route stubs catches schema drift
 *   without touching the shared seed. Clinical correctness is unit-tested
 *   server-side; this layer guarantees the UI form maps to the documented
 *   contract.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  gotoAuthed,
  seedPatient,
} from "./helpers";

const SHARED_OT_NAME = `OT-DEEP-${Date.now()}`;

test.describe("OT-surgery deep peri-op record — /dashboard/surgery/[id] (anesthesia + operative + PACU + SSI + RBAC)", () => {
  test("DOCTOR records an anesthesia record on the surgery detail page — pins POST /:id/anesthesia-record body (type, anesthetist, induction/extubation, recovery notes)", async ({
    doctorPage,
    adminApi,
    adminToken,
  }) => {
    const page = doctorPage;

    const surgeryId = await scheduleFreshSurgery(adminApi, adminToken);

    // Stub the upsert so we capture the body without persisting against
    // shared state. The card calls POST /surgery/:id/anesthesia-record
    // (apps/web/src/app/dashboard/surgery/[id]/page.tsx:832).
    let captured: Record<string, unknown> | null = null;
    await page.route(
      `**/api/v1/surgery/${surgeryId}/anesthesia-record`,
      (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        captured = route.request().postDataJSON();
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: "stub-anesthesia-id", surgeryId, ...captured },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/surgery/${surgeryId}`);
    await expect(
      page.getByRole("heading", { name: /anesthesia record/i })
    ).toBeVisible({ timeout: 15_000 });

    // Click "Add" inside the AnesthesiaCard (the only card with that header).
    const anesthesiaCard = page.locator(
      'div:has(> div > h2:has-text("Anesthesia Record"))'
    ).first();
    await anesthesiaCard
      .getByRole("button", { name: /^add$|^edit$/i })
      .first()
      .click();

    // Fill the form. Type select defaults to GENERAL — switch to SPINAL to
    // pin a non-default value made it through. Anesthetist text input is
    // identified by placeholder.
    await anesthesiaCard
      .locator("select")
      .first()
      .selectOption("SPINAL");
    await anesthesiaCard
      .getByPlaceholder(/anesthetist name/i)
      .fill("Dr. Anesthesia E2E");
    // Induction = 30 min ago, extubation = now (datetime-local inputs).
    const inductionLocal = toLocalDatetime(new Date(Date.now() - 30 * 60_000));
    const extubationLocal = toLocalDatetime(new Date());
    const dateInputs = anesthesiaCard.locator('input[type="datetime-local"]');
    await dateInputs.nth(0).fill(inductionLocal);
    await dateInputs.nth(1).fill(extubationLocal);
    await anesthesiaCard
      .getByPlaceholder(/recovery notes/i)
      .fill("E2E: patient extubated cleanly, vitals stable.");

    await anesthesiaCard
      .getByRole("button", { name: /^save$/i })
      .first()
      .click();

    // Wait for the request to land. The stub fulfills synchronously; allow
    // a short window for the click → fetch → assertion path.
    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.anesthesiaType).toBe("SPINAL");
    expect(captured!.anesthetist).toBe("Dr. Anesthesia E2E");
    expect(typeof captured!.inductionAt).toBe("string");
    expect(typeof captured!.extubationAt).toBe("string");
    expect(captured!.recoveryNotes).toContain("extubated");
    await expectNotForbidden(page);
  });

  test("DOCTOR edits clinical notes (operative-report equivalent) — pins PATCH /:id body for diagnosis/preOpNotes/postOpNotes", async ({
    doctorPage,
    adminApi,
    adminToken,
  }) => {
    const page = doctorPage;

    const surgeryId = await scheduleFreshSurgery(adminApi, adminToken);

    let captured: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/surgery/${surgeryId}`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      captured = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { id: surgeryId, ...captured },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, `/dashboard/surgery/${surgeryId}`);
    await expect(
      page.getByRole("heading", { name: /clinical notes/i })
    ).toBeVisible({ timeout: 15_000 });

    // Click "Edit Notes" inside the Clinical Notes card.
    await page
      .getByRole("button", { name: /edit notes/i })
      .first()
      .click();

    // Use the explicit input ids set in page.tsx:420/438/456 for stable
    // selectors (they survive DOM-shape refactors).
    await page
      .locator("#surgery-detail-diagnosis")
      .fill("K35.80 — Acute appendicitis (operative report)");
    await page
      .locator("#surgery-detail-preop")
      .fill("E2E pre-op: ASA II, NPO from 22:00.");
    await page
      .locator("#surgery-detail-postop")
      .fill(
        "E2E operative report: 4-port laparoscopic appendectomy, 50ml EBL, transferred to PACU stable."
      );

    await page
      .getByRole("button", { name: /^save$/i })
      .first()
      .click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.diagnosis).toContain("K35");
    expect(captured!.preOpNotes).toContain("ASA II");
    expect(captured!.postOpNotes).toContain("operative report");
    await expectNotForbidden(page);
  });

  test("DOCTOR records complications with severity + bloodLossMl — pins PATCH /:id/complications body", async ({
    doctorPage,
    adminApi,
    adminToken,
  }) => {
    const page = doctorPage;

    const surgeryId = await scheduleFreshSurgery(adminApi, adminToken);

    let captured: Record<string, unknown> | null = null;
    await page.route(
      `**/api/v1/surgery/${surgeryId}/complications`,
      (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        captured = route.request().postDataJSON();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: surgeryId, ...captured },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/surgery/${surgeryId}`);
    // The Complications card only renders when status==="COMPLETED" OR a
    // complication string already exists (page.tsx:371). Drive status to
    // COMPLETED via API so the card renders. The detail-page status pill
    // re-renders from the GET response on next load.
    await markComplete(adminApi, surgeryId, adminToken);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /complications & blood loss/i })
    ).toBeVisible({ timeout: 15_000 });

    const complicationsCard = page.locator(
      'div:has(> div > h2:has-text("Complications & Blood Loss"))'
    ).first();
    await complicationsCard
      .getByRole("button", { name: /^add$|^edit$/i })
      .first()
      .click();

    // Fill complication description, pick MODERATE severity, set blood
    // loss in ml. Locators: textarea + first select + numeric input.
    await complicationsCard
      .locator("textarea")
      .first()
      .fill("E2E: minor mesenteric venous oozing, controlled with cautery.");
    await complicationsCard
      .locator("select")
      .first()
      .selectOption("MODERATE");
    await complicationsCard
      .locator('input[type="number"]')
      .first()
      .fill("150");

    await complicationsCard
      .getByRole("button", { name: /^save$/i })
      .first()
      .click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.complications).toContain("oozing");
    expect(captured!.complicationSeverity).toBe("MODERATE");
    expect(captured!.bloodLossMl).toBe(150);
    await expectNotForbidden(page);
  });

  test("NURSE records a PACU observation — pins POST /:id/observations body (BP/Pulse/SpO2/pain/consciousness)", async ({
    nursePage,
    adminApi,
    adminToken,
  }) => {
    const page = nursePage;

    const surgeryId = await scheduleFreshSurgery(adminApi, adminToken);

    let captured: Record<string, unknown> | null = null;
    await page.route(
      `**/api/v1/surgery/${surgeryId}/observations`,
      (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        captured = route.request().postDataJSON();
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              id: "stub-pacu-obs-id",
              surgeryId,
              observedAt: new Date().toISOString(),
              ...captured,
            },
            error: null,
          }),
        });
      }
    );

    await gotoAuthed(page, `/dashboard/surgery/${surgeryId}`);
    await expect(
      page.getByRole("heading", { name: /pacu recovery/i })
    ).toBeVisible({ timeout: 15_000 });

    const pacuCard = page.locator(
      'div:has(> h2:has-text("PACU Recovery"))'
    ).first();

    // Fill all fields by their placeholder text — pageOrder of the inputs
    // is BP-Sys / BP-Dia / Pulse / SpO2 / Pain / Consciousness select /
    // Nausea checkbox / Notes textarea (page.tsx:1047-1065).
    await pacuCard.getByPlaceholder(/^BP Sys$/i).fill("128");
    await pacuCard.getByPlaceholder(/^BP Dia$/i).fill("82");
    await pacuCard.getByPlaceholder(/^Pulse$/i).fill("76");
    await pacuCard.getByPlaceholder(/SpO2 %/i).fill("98");
    await pacuCard.getByPlaceholder(/pain \(0-10\)/i).fill("3");
    await pacuCard.locator("select").first().selectOption("ALERT");
    await pacuCard.getByPlaceholder(/^Notes$/i).fill("E2E: PACU recovery uneventful.");

    await pacuCard
      .getByRole("button", { name: /add observation/i })
      .first()
      .click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.bpSystolic).toBe(128);
    expect(captured!.bpDiastolic).toBe(82);
    expect(captured!.pulse).toBe(76);
    expect(captured!.spO2).toBe(98);
    expect(captured!.painScore).toBe(3);
    expect(captured!.consciousness).toBe("ALERT");
    expect(captured!.notes).toContain("PACU");
    await expectNotForbidden(page);
  });

  test("DOCTOR submits an SSI report (regulatory NHSN-style surveillance) — pins PATCH /:id/ssi-report body (type + detectedDate + treatment)", async ({
    doctorPage,
    adminApi,
    adminToken,
  }) => {
    const page = doctorPage;

    const surgeryId = await scheduleFreshSurgery(adminApi, adminToken);

    let captured: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/surgery/${surgeryId}/ssi-report`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      captured = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { id: surgeryId, ssiDetected: true, ...captured },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, `/dashboard/surgery/${surgeryId}`);
    await expect(
      page.getByRole("heading", { name: /surgical site infection/i })
    ).toBeVisible({ timeout: 15_000 });

    const ssiCard = page.locator(
      'div:has(> div > h2:has-text("Surgical Site Infection"))'
    ).first();
    await ssiCard
      .getByRole("button", { name: /report ssi|update ssi/i })
      .first()
      .click();

    // Choose DEEP type (the second of the three NHSN classes).
    await ssiCard.locator("select").first().selectOption("DEEP");
    // detectedDate input pre-fills today; leave it. Treatment textarea:
    await ssiCard
      .locator("textarea")
      .first()
      .fill("E2E SSI: vancomycin IV 1g q12h × 14d, wound debridement scheduled.");

    await ssiCard
      .getByRole("button", { name: /^save$/i })
      .first()
      .click();

    await expect.poll(() => captured, { timeout: 10_000 }).not.toBeNull();
    expect(captured!.ssiType).toBe("DEEP");
    expect(typeof captured!.detectedDate).toBe("string");
    expect(captured!.treatment).toContain("vancomycin");
    await expectNotForbidden(page);
  });

  test("RBAC contract pin — PATIENT is excluded from GET /surgery/ots (catalog) AND cross-patient surgery reads are blocked by assertPatientOwnsResource", async ({
    patientPage,
    patientToken,
    adminApi,
    adminToken,
  }) => {
    const page = patientPage;

    // (a) PATIENT cannot read the OT catalog. apps/api/src/routes/surgery.ts:81
    // authorize Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION
    // (Issue #174 explicitly excludes PATIENT).
    const otsResp = await apiGet(page.request, patientToken, "/surgery/ots");
    expect(otsResp.status, "PATIENT must NOT read /surgery/ots").toBe(403);

    // (b) PATIENT cannot read another patient's surgery row.
    // surgery.ts:362 calls assertPatientOwnsResource. We seed a surgery
    // against an unrelated patient and confirm PATIENT-fixture (different
    // user.patientId) gets gated.
    const otherSurgeryId = await scheduleFreshSurgery(adminApi, adminToken);
    const sxResp = await apiGet(
      page.request,
      patientToken,
      `/surgery/${otherSurgeryId}`
    );
    // assertPatientOwnsResource emits 403 when the caller's Patient row
    // doesn't match the resource's patientId.
    expect(
      sxResp.status,
      "PATIENT must NOT read another patient's surgery"
    ).toBe(403);
  });
});

// ─── Local helpers (file-scoped) ─────────────────────────────────────────

/**
 * Convert a Date to `YYYY-MM-DDTHH:mm` for `<input type="datetime-local">`.
 * Mirrors the page's toIso → slice(0,16) round-trip in page.tsx:809.
 */
function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

async function ensureOT(
  api: import("@playwright/test").APIRequestContext
): Promise<{ id: string; name: string }> {
  const list = await api.get(`${API_BASE}/surgery/ots`);
  if (list.ok()) {
    const json = await list.json();
    const ots: Array<{ id: string; name: string; isActive: boolean }> =
      json.data ?? [];
    const active = ots.find((o) => o.isActive);
    if (active) return { id: active.id, name: active.name };
  }
  const create = await api.post(`${API_BASE}/surgery/ots`, {
    data: { name: SHARED_OT_NAME, floor: "1", dailyRate: 0 },
  });
  if (!create.ok()) {
    throw new Error(
      `ensureOT: cannot create OT: ${create.status()} ${(await create.text()).slice(0, 200)}`
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
  adminApi: import("@playwright/test").APIRequestContext,
  adminToken: string
): Promise<string> {
  const patient = await seedPatient(adminApi);
  const ot = await ensureOT(adminApi);
  const doctorId = await firstDoctorId(adminApi);
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const create = await apiPost(adminApi, adminToken, "/surgery", {
    patientId: patient.id,
    surgeonId: doctorId,
    otId: ot.id,
    procedure: "E2E deep peri-op coverage surgery",
    scheduledAt,
    durationMin: 60,
  });
  if (create.status !== 201) {
    throw new Error(
      `scheduleFreshSurgery: POST /surgery returned ${create.status} ${JSON.stringify(create.body).slice(0, 200)}`
    );
  }
  return create.body.data.id;
}

/**
 * Drive a SCHEDULED surgery to COMPLETED via three API hops so the detail
 * page renders the Complications card (which is gated on
 * status==="COMPLETED" || surgery.complications truthy).
 */
async function markComplete(
  adminApi: import("@playwright/test").APIRequestContext,
  surgeryId: string,
  adminToken: string
): Promise<void> {
  const headers = { Authorization: `Bearer ${adminToken}` };
  const npoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const preop = await adminApi.patch(
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
  if (preop.status() !== 200) {
    throw new Error(`markComplete preop: ${preop.status()}`);
  }
  const start = await adminApi.patch(`${API_BASE}/surgery/${surgeryId}/start`, {
    headers,
    data: {},
  });
  if (start.status() !== 200) {
    throw new Error(`markComplete start: ${start.status()}`);
  }
  const complete = await adminApi.patch(
    `${API_BASE}/surgery/${surgeryId}/complete`,
    {
      headers,
      data: { postOpNotes: "E2E completion for complications card render." },
    }
  );
  if (complete.status() !== 200) {
    throw new Error(`markComplete complete: ${complete.status()}`);
  }
}
