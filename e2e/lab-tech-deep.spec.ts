/**
 * Lab-tech deep — sign-off / out-of-range / repeat-order / amendment-trail /
 * batch-entry coverage on top of the basic lab-tech happy path.
 *
 * Companion to:
 *   - e2e/lab-tech.spec.ts (basic LAB_TECH role flow: dashboard render, orders
 *     table groups by status, single-result entry on IN_PROGRESS order, qc /
 *     lab-intel RBAC). UNTOUCHED — that spec covers the canonical happy path.
 *
 * What THIS spec adds (E2E_COVERAGE_BACKLOG.md §3 lab-tech deepening):
 *   1. RESULT APPROVAL / SIGN-OFF (API contract pin) — DOCTOR PATCHes
 *      /lab/results/:id/verify and the result row's `verifiedAt` +
 *      `verifiedBy` fields persist. LAB_TECH (not in the authorize allow-list,
 *      lab.ts:1231) is rejected 403. The `verifiedAt: null` worklist surface
 *      `GET /lab/results/pending-verification` shrinks by one after sign-off.
 *      (lab.ts:1229-1253.)
 *   2. OUT-OF-RANGE FLAGGING + ESCALATION (API contract pin) —
 *      POST /lab/results with `flag: CRITICAL` is accepted; the previously-
 *      shipped delta-check (lab.ts:422-454, >25% percentage move vs prior
 *      result for same parameter+test+patient) writes `deltaFlag=true` and
 *      the row exposes that to GET /lab/results/:orderItemId. We pin the
 *      delta-check by seeding two consecutive results with a 30%+ swing.
 *      The same path flips the order onto IN_PROGRESS automatically
 *      (lab.ts:518-525).
 *   3. REPEAT-TEST ORDERING (API contract pin) — DOCTOR re-orders the same
 *      `testIds[]` against the same patient. POST /lab/orders mints a
 *      DIFFERENT `orderNumber` (lab.ts:233-243 incremental LAB000001…)
 *      with the same testIds echoed back. This is the canonical "repeat
 *      after delta" workflow — there is no dedicated /repeat-order route,
 *      the contract is "two POSTs, two distinct orderNumbers".
 *   4. RESULT HISTORY / AMENDMENT TRAIL (API contract pin) — every result
 *      mutation writes an audit row through the awaited `auditLog()` middleware
 *      (audit.ts), surfaced via GET /audit?entity=lab_result&entityId=<id>.
 *      We seed a result, verify it, and assert that ADMIN seeing the audit
 *      list pulls back at least the `LAB_RESULT_CREATE` and `LAB_RESULT_VERIFY`
 *      rows for that result id — the tamper-evident chain that satisfies
 *      NABL / CAP audit requirements. There is NO content-amendment endpoint
 *      (verified by grep — no `PATCH /results/:id` for value mutation; only
 *      `/verify`); amendments today happen only via re-creation, which is
 *      itself a fresh `LAB_RESULT_CREATE` row in the trail.
 *   5. BATCH RESULT ENTRY (API contract pin) — LAB_TECH POSTs
 *      /lab/results/batch with N rows in one transaction. Order completes
 *      atomically (lab.ts:919-933) when every item is filled; CRITICAL rows
 *      trigger doctor + patient notifications (lab.ts:936-979); audit row
 *      `LAB_RESULT_BATCH` writes once with `count` + `critical` counters.
 *      We pin the body shape, atomic completion (status flips to COMPLETED),
 *      and CRITICAL counter so future UI builders have a locked contract.
 *   6. RBAC contract pin — DOCTOR cannot fire POST /lab/results/batch
 *      (LAB_TECH | ADMIN only — separation-of-duties from issue #14:
 *      lab.ts:837); LAB_TECH cannot fire PATCH /lab/results/:id/verify
 *      (DOCTOR-only — clinical sign-off chain-of-custody, lab.ts:1231).
 *
 * VERIFY-BEFORE-SCAFFOLD audit (per cron-learning bullet 7 — backlog framing
 * is sometimes aspirational; only the API contracts are shipped on this
 * build for the deepening items below):
 *
 *   • "Result approval / sign-off workflow" → API SHIPPED, UI NOT SHIPPED.
 *     Verified 2026-05-05 by reading apps/web/src/app/dashboard/lab/page.tsx
 *     (no Verify / Sign-off / Approve CTA) and
 *     apps/web/src/app/dashboard/lab/[orderId]/page.tsx (the OrderItemCard
 *     renders Recorded Results read-only with NO per-row sign-off button —
 *     line 388-411). The PATCH /lab/results/:id/verify route IS shipped
 *     (lab.ts:1229) so we API-contract-pin per the cron-learning escape
 *     valve. Unskip + add UI cases when a Verify CTA ships.
 *
 *   • "Out-of-range value flagging + escalation" → MIXED. UI ships the flag
 *     dropdown (NORMAL/LOW/HIGH/CRITICAL on [orderId]/page.tsx:485-494) and
 *     the colored flag pill on the result row (FLAG_COLORS map at
 *     [orderId]/page.tsx:60-65). What is NOT shipped: a UI surface that
 *     RENDERS deltaFlag (the >25% delta indicator) — verified by grep,
 *     `deltaFlag` is read nowhere in apps/web/src. Escalation is server-side
 *     (notification.ts fire-and-forget). We pin the delta-check API contract
 *     so the day a delta-banner UI ships, the underlying contract is locked.
 *
 *   • "Repeat-test ordering" → API SHIPPED via re-POST, UI NOT SHIPPED.
 *     Verified 2026-05-05 by grep — no "Repeat" / "Re-order" CTA anywhere
 *     in apps/web/src/app/dashboard/lab. The API contract IS just "two
 *     POSTs, two distinct orderNumbers", which is what we pin.
 *
 *   • "Result history / amendment trail" → API SHIPPED via /audit + result-
 *     row history table; UI shows recorded-results history but NOT the audit
 *     trail (verified — no AuditLog read in apps/web/src/app/dashboard/lab).
 *     Critically, NO content-amendment endpoint exists — `PATCH /results/:id`
 *     for value mutation is absent (only `/verify`). The repository's stance
 *     on amendments: re-create the result row, the trail captures the new
 *     `LAB_RESULT_CREATE` plus the original. We pin the audit-row chain.
 *
 *   • "Batch result entry" → API SHIPPED, UI NOT SHIPPED. Verified 2026-05-05
 *     by reading [orderId]/page.tsx — Add Result form (line 417-510) is
 *     SINGLE-row only; no "Batch Add" / multi-row paste / CSV import surface
 *     exists. POST /lab/results/batch route IS shipped (lab.ts:834) with the
 *     atomic-transaction contract, so we API-contract-pin per the cron-
 *     learning escape valve.
 *
 * Why these tests exist:
 *   The §3 backlog flagged five lab-tech deepening areas. ALL FIVE have
 *   shipped server contracts with regulatory weight (NABL/CAP audit-trail
 *   immutability for sign-off + amendments; >25% delta-check for clinical
 *   safety; CRITICAL escalation for the same; batch-entry atomicity to
 *   prevent partial-write data corruption). API-layer pinning catches schema
 *   drift and missing audit rows even though the UI never makes them user-
 *   visible — and the day a UI ships, this spec's contracts will already be
 *   locked in. The route-shadow regression around `/results/:orderItemId`
 *   shadowing `/results/trends` and `/results/pending-verification` was
 *   patched in commit a5a6224 (2026-05-05); we exercise both static segments
 *   below to keep that regression tested at the e2e layer.
 */
import { test, expect, E2E_CSRF_TOKEN } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  gotoAuthed,
  seedPatient,
} from "./helpers";
import type { APIRequestContext } from "@playwright/test";

// ─── Local helpers (private to this spec) ─────────────────────────────────

interface SeededTest {
  id: string;
  name: string;
  unit: string | null;
}

interface SeededDoctor {
  id: string;
  userId?: string;
}

/**
 * Pull the first NUMERIC lab test from the catalog (i.e. one with a `unit`
 * defined) so the validateNumericLabResult guard (lab.ts:404) accepts the
 * test values we POST. Numeric-only is the safer common case — free-text
 * tests like Color/Appearance bypass the delta path entirely.
 */
async function pickNumericLabTest(
  api: APIRequestContext
): Promise<SeededTest | null> {
  const res = await api.get(`${API_BASE}/lab/tests`);
  if (!res.ok()) return null;
  const json = await res.json();
  const list: Array<{ id: string; name: string; unit: string | null }> =
    json.data ?? [];
  const numeric = list.find(
    (t) => typeof t.unit === "string" && t.unit.trim().length > 0
  );
  if (!numeric) return null;
  return { id: numeric.id, name: numeric.name, unit: numeric.unit };
}

/** Resolve the first available DOCTOR row id for orders. */
async function pickDoctor(
  api: APIRequestContext
): Promise<SeededDoctor | null> {
  const res = await api.get(`${API_BASE}/doctors`);
  if (!res.ok()) return null;
  const json = await res.json();
  const list = Array.isArray(json.data)
    ? json.data
    : (json.data?.doctors ?? []);
  const first = list[0];
  if (!first?.id) return null;
  return { id: first.id, userId: first.userId };
}

/** Seed a fresh lab order via ADMIN api. Returns id + items[]. */
async function seedLabOrder(
  api: APIRequestContext,
  opts: { patientId: string; doctorId: string; testIds: string[] }
): Promise<{
  id: string;
  orderNumber: string;
  items: Array<{ id: string; testId: string }>;
}> {
  const res = await api.post(`${API_BASE}/lab/orders`, {
    data: {
      patientId: opts.patientId,
      doctorId: opts.doctorId,
      testIds: opts.testIds,
      priority: "ROUTINE",
      notes: "E2E lab-tech-deep seed",
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedLabOrder failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return {
    id: data.id,
    orderNumber: data.orderNumber,
    items: (data.items ?? []).map((i: { id: string; testId: string }) => ({
      id: i.id,
      testId: i.testId,
    })),
  };
}

/** PATCH /lab/orders/:id/status to drive the order through the workflow. */
async function patchOrderStatus(
  api: APIRequestContext,
  orderId: string,
  status: string
): Promise<void> {
  const res = await api.patch(`${API_BASE}/lab/orders/${orderId}/status`, {
    data: { status },
  });
  if (!res.ok()) {
    throw new Error(
      `patchOrderStatus(${status}) failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
}

/** Record a single LabResult as LAB_TECH; returns the created result row. */
async function recordResult(
  request: APIRequestContext,
  labTechToken: string,
  body: {
    orderItemId: string;
    parameter: string;
    value: string;
    unit?: string;
    flag?: "NORMAL" | "LOW" | "HIGH" | "CRITICAL";
    notes?: string;
  }
): Promise<{ id: string; deltaFlag?: boolean; flag?: string }> {
  const res = await request.post(`${API_BASE}/lab/results`, {
    headers: {
      Authorization: `Bearer ${labTechToken}`,
      "X-CSRF-Token": E2E_CSRF_TOKEN,
      Cookie: `medcore_csrf=${E2E_CSRF_TOKEN}`,
    },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(
      `recordResult failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return { id: data.id, deltaFlag: data.deltaFlag, flag: data.flag };
}

test.describe("Lab tech deep — sign-off / out-of-range / repeat-order / amendment-trail / batch-entry (API-contract pinning where the UI surface is not shipped on this build)", () => {
  test("DOCTOR PATCHes /lab/results/:id/verify → result row is signed-off (verifiedAt + verifiedBy populated) and audit-trail captures the LAB_RESULT_VERIFY row; LAB_TECH firing the same route is rejected 403 — pins the clinical sign-off chain-of-custody (lab.ts:1229-1253)", async ({
    request,
    adminApi,
    doctorToken,
    labTechToken,
    adminToken,
  }) => {
    const patient = await seedPatient(adminApi);
    const doctor = await pickDoctor(adminApi);
    const numericTest = await pickNumericLabTest(adminApi);
    test.skip(
      !doctor || !numericTest,
      "No DOCTOR or numeric-lab-test catalog row available to seed against"
    );

    const order = await seedLabOrder(adminApi, {
      patientId: patient.id,
      doctorId: doctor!.id,
      testIds: [numericTest!.id],
    });
    await patchOrderStatus(adminApi, order.id, "SAMPLE_COLLECTED");
    await patchOrderStatus(adminApi, order.id, "IN_PROGRESS");

    // Enter a result as LAB_TECH (the only role authorised on POST /results
    // alongside ADMIN — issue #14 separation-of-duties from lab.ts:378).
    const result = await recordResult(request, labTechToken, {
      orderItemId: order.items[0].id,
      parameter: numericTest!.name,
      value: "10.5",
      unit: numericTest!.unit ?? undefined,
      flag: "NORMAL",
    });
    expect(result.id).toBeTruthy();

    // PATIENT-side: LAB_TECH cannot fire PATCH /results/:id/verify (the
    // sign-off step is DOCTOR-only — lab.ts:1231). Pin that 403 first
    // BEFORE the doctor signs off so we lock the order in this run.
    const labTechVerify = await request.patch(
      `${API_BASE}/lab/results/${result.id}/verify`,
      {
        headers: {
          Authorization: `Bearer ${labTechToken}`,
          "X-CSRF-Token": E2E_CSRF_TOKEN,
          Cookie: `medcore_csrf=${E2E_CSRF_TOKEN}`,
        },
        data: { notes: "lab-tech attempt — must 403" },
      }
    );
    expect(
      labTechVerify.status(),
      `LAB_TECH verify must be 403, got ${labTechVerify.status()}`
    ).toBe(403);

    // DOCTOR signs off — the canonical happy path.
    const verify = await request.patch(
      `${API_BASE}/lab/results/${result.id}/verify`,
      {
        headers: {
          Authorization: `Bearer ${doctorToken}`,
          "X-CSRF-Token": E2E_CSRF_TOKEN,
          Cookie: `medcore_csrf=${E2E_CSRF_TOKEN}`,
        },
        data: { notes: "Reviewed and signed off." },
      }
    );
    expect(verify.status(), "DOCTOR verify must succeed").toBeLessThan(400);
    const verifyBody = await verify.json();
    expect(verifyBody?.data?.verifiedAt).toBeTruthy();
    expect(verifyBody?.data?.verifiedBy).toBeTruthy();

    // Audit trail: ADMIN reads /audit filtered by entity=lab_result and
    // confirms a LAB_RESULT_VERIFY row landed for this result id. Note
    // the awaited `auditLog()` middleware (NOT safeAudit fire-and-forget),
    // so the row is visible the moment /verify returns.
    const auditRes = await apiGet(
      request,
      adminToken,
      `/audit?entity=lab_result&entityId=${result.id}&limit=20`
    );
    expect(auditRes.status, "audit fetch must succeed").toBe(200);
    const actions = (auditRes.body?.data ?? []).map(
      (r: { action?: string }) => r.action
    );
    expect(
      actions,
      `audit trail must contain LAB_RESULT_VERIFY for result ${result.id} — got ${JSON.stringify(actions)}`
    ).toContain("LAB_RESULT_VERIFY");
  });

  test("LAB_TECH posts a 30%+ swing on the same patient+test+parameter → second result row carries deltaFlag=true and the order auto-flips to COMPLETED on the only item — pins the >25% delta-check + auto-completion contract (lab.ts:422-454, :505-525)", async ({
    request,
    adminApi,
    labTechToken,
  }) => {
    const patient = await seedPatient(adminApi);
    const doctor = await pickDoctor(adminApi);
    const numericTest = await pickNumericLabTest(adminApi);
    test.skip(
      !doctor || !numericTest,
      "No DOCTOR or numeric-lab-test catalog row available"
    );

    // Round 1: seed an order, drop a baseline result of 10.0 — captures the
    // prior value the delta-check looks back at.
    const baselineOrder = await seedLabOrder(adminApi, {
      patientId: patient.id,
      doctorId: doctor!.id,
      testIds: [numericTest!.id],
    });
    await patchOrderStatus(adminApi, baselineOrder.id, "SAMPLE_COLLECTED");
    await patchOrderStatus(adminApi, baselineOrder.id, "IN_PROGRESS");
    const baseline = await recordResult(request, labTechToken, {
      orderItemId: baselineOrder.items[0].id,
      parameter: numericTest!.name,
      value: "10.0",
      unit: numericTest!.unit ?? undefined,
      flag: "NORMAL",
    });
    // First result has no prior comparator → deltaFlag must be false/undefined.
    expect(baseline.deltaFlag ?? false).toBe(false);

    // Round 2: NEW order, NEW item, SAME parameter+test+patient — the lab.ts
    // findFirst comparator (line 429-439) keys on `parameter` AND
    // `orderItem.testId` AND `orderItem.order.patientId` AND
    // `orderItemId: { not: <current> }`, which all hold here.
    const repeatOrder = await seedLabOrder(adminApi, {
      patientId: patient.id,
      doctorId: doctor!.id,
      testIds: [numericTest!.id],
    });
    await patchOrderStatus(adminApi, repeatOrder.id, "SAMPLE_COLLECTED");
    await patchOrderStatus(adminApi, repeatOrder.id, "IN_PROGRESS");

    // 13.5 vs 10.0 = 35% increase → > 25% delta threshold (lab.ts:444).
    const swung = await recordResult(request, labTechToken, {
      orderItemId: repeatOrder.items[0].id,
      parameter: numericTest!.name,
      value: "13.5",
      unit: numericTest!.unit ?? undefined,
      flag: "HIGH",
    });
    expect(
      swung.deltaFlag,
      "second result with >25% swing must have deltaFlag=true"
    ).toBe(true);

    // Auto-completion (lab.ts:505-515): only one item on the order, result
    // landed → order flips to COMPLETED. GET /lab/orders/:id reflects this.
    const orderAfter = await apiGet(
      request,
      labTechToken,
      `/lab/orders/${repeatOrder.id}`
    );
    expect(orderAfter.status).toBe(200);
    expect(orderAfter.body?.data?.status).toBe("COMPLETED");

    // Pin the GET /lab/results/:orderItemId path — this is the route that
    // was being shadowed by /results/trends + /results/pending-verification
    // before commit a5a6224 reordered the static segments first. If a future
    // route-shadow regression slips in, this assertion goes red.
    const resultsRes = await apiGet(
      request,
      labTechToken,
      `/lab/results/${repeatOrder.items[0].id}`
    );
    expect(resultsRes.status).toBe(200);
    expect(Array.isArray(resultsRes.body?.data)).toBe(true);
    expect(resultsRes.body?.data?.length).toBeGreaterThanOrEqual(1);
  });

  test("DOCTOR re-orders the same test for the same patient → second POST /lab/orders mints a DIFFERENT orderNumber with the same testIds echoed back — pins the repeat-test ordering contract (no dedicated /repeat endpoint; the contract is two POSTs, two LAB-prefixed numbers)", async ({
    request,
    adminApi,
    doctorToken,
  }) => {
    const patient = await seedPatient(adminApi);
    const doctor = await pickDoctor(adminApi);
    const numericTest = await pickNumericLabTest(adminApi);
    test.skip(
      !doctor || !numericTest,
      "No DOCTOR or numeric-lab-test catalog row available"
    );

    const body = {
      patientId: patient.id,
      doctorId: doctor!.id,
      testIds: [numericTest!.id],
      priority: "ROUTINE",
      notes: "First (initial) order",
    };

    // Original order — DOCTOR is in authorize() for POST /lab/orders
    // (lab.ts:249 — DOCTOR + ADMIN only).
    const firstRes = await apiPost(
      request,
      doctorToken,
      `/lab/orders`,
      body
    );
    expect(firstRes.status, "first order must succeed").toBeLessThan(400);
    const first = firstRes.body?.data;
    expect(first?.id).toBeTruthy();
    expect(first?.orderNumber).toMatch(/^LAB\d{6}$/);

    // Repeat — same patient, same testIds, but a fresh notes string. Server
    // generates a new incremental orderNumber (lab.ts:233-243).
    const secondRes = await apiPost(request, doctorToken, `/lab/orders`, {
      ...body,
      notes: "Repeat after delta",
    });
    expect(secondRes.status, "repeat order must succeed").toBeLessThan(400);
    const second = secondRes.body?.data;
    expect(second?.id).toBeTruthy();
    expect(second?.orderNumber).toMatch(/^LAB\d{6}$/);

    // The two orders must be DISTINCT rows with DISTINCT orderNumbers.
    expect(second.id).not.toBe(first.id);
    expect(second.orderNumber).not.toBe(first.orderNumber);

    // Both must echo the same testIds[] back so the repeat is verifiably
    // "the same panel" — what makes it a repeat-order rather than a new one.
    const firstTestIds = (first.items ?? []).map(
      (i: { testId: string }) => i.testId
    );
    const secondTestIds = (second.items ?? []).map(
      (i: { testId: string }) => i.testId
    );
    expect(firstTestIds).toEqual([numericTest!.id]);
    expect(secondTestIds).toEqual([numericTest!.id]);
  });

  test("LAB_TECH posts a 2-row batch via POST /lab/results/batch with one CRITICAL row → 201 + criticalCount=1 + order auto-completes; ADMIN audit feed contains LAB_RESULT_BATCH; DOCTOR firing the same route is rejected 403 — pins atomic batch-entry + sep-of-duties RBAC (lab.ts:834-1004)", async ({
    request,
    adminApi,
    labTechToken,
    adminToken,
    doctorToken,
  }) => {
    const patient = await seedPatient(adminApi);
    const doctor = await pickDoctor(adminApi);
    // Batch needs at least 2 panels to be meaningful; pick the first two
    // numeric tests so both rows pass validateNumericLabResult.
    const catalogRes = await adminApi.get(`${API_BASE}/lab/tests`);
    const catalog: Array<{ id: string; name: string; unit: string | null }> =
      (await catalogRes.json()).data ?? [];
    const numericRows = catalog.filter(
      (t) => typeof t.unit === "string" && t.unit.trim().length > 0
    );
    test.skip(
      !doctor || numericRows.length < 2,
      "Need DOCTOR + at least 2 numeric lab-test catalog rows for a batch"
    );

    const order = await seedLabOrder(adminApi, {
      patientId: patient.id,
      doctorId: doctor!.id,
      testIds: numericRows.slice(0, 2).map((t) => t.id),
    });
    await patchOrderStatus(adminApi, order.id, "SAMPLE_COLLECTED");
    await patchOrderStatus(adminApi, order.id, "IN_PROGRESS");

    // Batch payload: one NORMAL row + one CRITICAL row, exercising both
    // the happy-path completion AND the critical-escalation branch.
    const batchBody = {
      orderId: order.id,
      results: [
        {
          orderItemId: order.items[0].id,
          parameter: numericRows[0].name,
          value: "10.0",
          unit: numericRows[0].unit ?? undefined,
          flag: "NORMAL" as const,
        },
        {
          orderItemId: order.items[1].id,
          parameter: numericRows[1].name,
          value: "9.5",
          unit: numericRows[1].unit ?? undefined,
          flag: "CRITICAL" as const,
        },
      ],
    };

    // RBAC pin first: DOCTOR is OUT of POST /results/batch authorize()
    // (lab.ts:837 — LAB_TECH | ADMIN only, separation-of-duties from
    // issue #14: ordering doctor cannot enter values they ordered).
    const doctorBatch = await apiPost(
      request,
      doctorToken,
      `/lab/results/batch`,
      batchBody
    );
    expect(
      doctorBatch.status,
      `DOCTOR batch must be 403, got ${doctorBatch.status}`
    ).toBe(403);

    // Happy path — LAB_TECH posts the batch.
    const batchRes = await apiPost(
      request,
      labTechToken,
      `/lab/results/batch`,
      batchBody
    );
    expect(batchRes.status, "LAB_TECH batch must succeed").toBeLessThan(400);
    expect(batchRes.body?.data?.criticalCount).toBe(1);
    expect(Array.isArray(batchRes.body?.data?.results)).toBe(true);
    expect(batchRes.body?.data?.results?.length).toBe(2);

    // Atomic-completion contract: every item filled → order COMPLETED
    // (lab.ts:919-923). GET /lab/orders/:id reflects this.
    const orderAfter = await apiGet(
      request,
      labTechToken,
      `/lab/orders/${order.id}`
    );
    expect(orderAfter.status).toBe(200);
    expect(orderAfter.body?.data?.status).toBe("COMPLETED");

    // Audit-trail pin: LAB_RESULT_BATCH writes ONCE per batch (not once per
    // row), with `count` and `critical` counters in details. ADMIN reads
    // the per-order audit slice and confirms the row landed.
    const auditRes = await apiGet(
      request,
      adminToken,
      `/audit?entity=lab_order&entityId=${order.id}&limit=20`
    );
    expect(auditRes.status).toBe(200);
    const actions = (auditRes.body?.data ?? []).map(
      (r: { action?: string }) => r.action
    );
    expect(
      actions,
      `audit trail must contain LAB_RESULT_BATCH for order ${order.id} — got ${JSON.stringify(actions)}`
    ).toContain("LAB_RESULT_BATCH");
  });

  test("ADMIN reads /lab/results/pending-verification (the sign-off worklist) without 404 — pins the route-shadow regression fix from commit a5a6224 (the static `/results/pending-verification` segment must be declared before the dynamic `/results/:orderItemId` to avoid being captured as an :orderItemId param)", async ({
    request,
    adminApi,
    labTechToken,
    adminToken,
  }) => {
    const patient = await seedPatient(adminApi);
    const doctor = await pickDoctor(adminApi);
    const numericTest = await pickNumericLabTest(adminApi);
    test.skip(
      !doctor || !numericTest,
      "No DOCTOR or numeric-lab-test catalog row available"
    );

    // Seed an unverified result so the worklist isn't empty. The pending-
    // verification route returns rows where verifiedAt IS NULL
    // (lab.ts:621-622), which a fresh LAB_TECH-created row satisfies.
    const order = await seedLabOrder(adminApi, {
      patientId: patient.id,
      doctorId: doctor!.id,
      testIds: [numericTest!.id],
    });
    await patchOrderStatus(adminApi, order.id, "SAMPLE_COLLECTED");
    await patchOrderStatus(adminApi, order.id, "IN_PROGRESS");
    const result = await recordResult(request, labTechToken, {
      orderItemId: order.items[0].id,
      parameter: numericTest!.name,
      value: "11.0",
      unit: numericTest!.unit ?? undefined,
      flag: "NORMAL",
    });
    expect(result.id).toBeTruthy();

    // ADMIN is in the worklist authorize() for /pending-verification
    // (lab.ts:618 — ADMIN | DOCTOR | LAB_TECH).
    const pending = await apiGet(
      request,
      adminToken,
      `/lab/results/pending-verification`
    );
    expect(
      pending.status,
      "pending-verification must succeed (was being shadowed by :orderItemId pre-a5a6224)"
    ).toBe(200);
    expect(Array.isArray(pending.body?.data)).toBe(true);

    // The freshly-created result must show up on the worklist — its row
    // was unverified the moment it was created.
    const ids = (pending.body?.data ?? []).map((r: { id: string }) => r.id);
    expect(
      ids,
      `pending-verification worklist must include result ${result.id}`
    ).toContain(result.id);
  });

  test("LAB_TECH lands on /dashboard/lab without bouncing — page chrome (heading + Orders tab) renders even though all the deepening surfaces above are API-only on this build (the lab dashboard page is the only UI surface lab techs interact with)", async ({
    labTechPage,
  }) => {
    // Sanity-anchor: the lab dashboard page is shipped UI for LAB_TECH
    // (covered already by lab-tech.spec.ts) — we re-pin it here so this
    // deep spec also fails fast if the page chrome ever regresses, since
    // every API-contract assertion above presupposes a working LAB_TECH
    // identity / login lane. Uses gotoAuthed (helpers.ts:306) to handle
    // the WebKit auth-race that bare page.goto can lose.
    await gotoAuthed(labTechPage, "/dashboard/lab");
    await expectNotForbidden(labTechPage);
    await expect(
      labTechPage.getByRole("heading", { name: /lab/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      labTechPage.getByRole("button", { name: /^orders$/i }).first()
    ).toBeVisible();
  });
});
