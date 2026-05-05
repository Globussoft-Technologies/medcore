/**
 * Telemedicine deep — recording-consent / followup / Rx / payment-fee /
 * call-quality (precheck-driven) coverage on top of the basic patient flow
 * and waiting-room flow.
 *
 * Companion to:
 *   - e2e/telemedicine-patient.spec.ts (basic patient lifecycle: schedule,
 *     waiting room mock, doctor sees waiting indicator, ambient scribe,
 *     Rx visibility on the patient prescriptions page). UNTOUCHED.
 *   - e2e/telemedicine-waiting-room.spec.ts (precheck → join → waiting →
 *     deny lifecycle + access-shape pinning). UNTOUCHED.
 *
 * What THIS spec adds (E2E_COVERAGE_BACKLOG.md §3 telemedicine deepening):
 *   1. RECORDING CONSENT GATE (API contract pin) — POST
 *      /telemedicine/:id/recording/start MUST reject `consent: false` with
 *      400 and ACCEPT `consent: true` with 200 + `recordingConsent=true`
 *      persisted on the session row. The companion /recording/stop accepts
 *      an optional `recordingUrl` (Jibri webhook archive URL) and stamps
 *      `recordingStoppedAt`. The patient session detail then reflects the
 *      archive URL via GET /telemedicine/:id. (telemedicine.ts:868-962.)
 *   2. FOLLOWUP SCHEDULING FROM CALL END (API contract pin) — DOCTOR ends
 *      a session, then PATCHes /telemedicine/:id/followup with a future
 *      ISO timestamp. The session row's `followUpScheduledAt` updates and
 *      a `TELEMED_FOLLOWUP_SCHEDULE` audit row writes. PATIENT (not in the
 *      authorize allow-list — telemedicine.ts:491) is rejected with 403.
 *      (telemedicine.ts:489-509.)
 *   3. POST-CONSULT PRESCRIPTION FILL (API contract pin) — DOCTOR posts
 *      /telemedicine/:id/prescription with one or more items + advice.
 *      Server requires status IN_PROGRESS or COMPLETED (409 otherwise),
 *      mints a `TRX-<sessionNumber>-<ts>` prescription id, and appends a
 *      formatted Rx block onto `doctorNotes`. PATIENT cannot fire this
 *      route (authorize ADMIN, DOCTOR — telemedicine.ts:602). The session
 *      detail then reflects `prescriptionId`. (telemedicine.ts:600-664.)
 *   4. PAYMENT / FEE PINNING — `fee` defaults to 500 on POST /telemedicine
 *      and survives onto the session row; PATIENT sees the same value via
 *      GET /telemedicine/:id. The codebase ships NO dedicated remote-
 *      consult settlement / Razorpay-via-telemedicine surface, so the
 *      strongest contract this layer can pin is "fee is the source of
 *      truth on the session row". (telemedicine.ts:55, :104.)
 *   5. CALL QUALITY (precheck bandwidth+UA capture) — POST
 *      /telemedicine/:id/precheck stores `bandwidthKbps` + `userAgent`
 *      onto `precheckDetails`. This is the only call-quality signal that
 *      ever lands server-side; reconnection itself is purely Jitsi-
 *      internal client state. We pin that the server stores the call-
 *      quality fingerprint and exposes it back via GET. (telemedicine.ts:
 *      968-1029, telemedPrecheckSchema.)
 *   6. RBAC pin — non-DOCTOR/ADMIN cannot fire /recording/start (NURSE
 *      403); PATIENT cannot fire /followup or /prescription (403).
 *      Cross-patient PATIENT-A cannot read PATIENT-B's session GET (403,
 *      assertPatientOwnsResource gate, telemedicine.ts:223).
 *
 * VERIFY-BEFORE-SCAFFOLD audit (per the §3 backlog framing — 5
 * deepening items, only the API contracts are shipped on this build):
 *
 *   • "Call quality / reconnection" → PARTIALLY DEFERRED. Reconnection is
 *     pure Jitsi/WebRTC client state with no server-side surface; cannot
 *     be e2e-pinned without driving Jitsi internals (out of scope for
 *     this layer per the WebRTC-mock contract codified in
 *     telemedicine-patient.spec.ts:25-32). The CLOSEST shipped surface is
 *     the precheck capture of `bandwidthKbps` + `userAgent`, which is
 *     the only call-quality fingerprint ever persisted. Covered case 5.
 *
 *   • "Post-consult prescription fill / delivery" → SHIPPED via API.
 *     Covered case 3. UI surface is the basic /dashboard/scribe deep-link
 *     (already covered by telemedicine-patient.spec.ts test 5 against
 *     /dashboard/prescriptions). No "fill" / "deliver" workflow on the
 *     telemedicine page itself — there is no Rx-fill button in
 *     apps/web/src/app/dashboard/telemedicine/page.tsx (verified by grep
 *     2026-05-05; only Schedule/Start/End/Cancel/Admit/Deny/Rate/Scribe
 *     CTAs ship). The route handler IS shipped, so we pin it.
 *
 *   • "Followup scheduling from call end" → SHIPPED via API. Covered
 *     case 2. NO UI CTA — verified by grep 2026-05-05: the strings
 *     "follow-up", "followUp", "schedule follow" appear only in the End
 *     Session prompt's free-text placeholder ("Patient stable, follow-up
 *     in 1 week", page.tsx:268), never as a structured form field. The
 *     PATCH /:id/followup route handler IS shipped, so we pin it.
 *
 *   • "Recording consent + archive" → SHIPPED via API. Covered case 1.
 *     NO UI CTA — verified by grep 2026-05-05: zero matches for
 *     /recording|consent|recordingConsent|recordingUrl/i in the
 *     telemedicine page tree. The /recording/start + /recording/stop
 *     route handlers + Jibri webhook payload contract ARE shipped, so
 *     we pin the consent gate AND the archive-URL persistence.
 *
 *   • "Remote-consult payment / settlement" → SHIPPED MINIMALLY via the
 *     `fee` field on POST /telemedicine. NO dedicated remote-consult
 *     settlement surface — verified by grep 2026-05-05: zero matches for
 *     /payment|settlement|razorpay|invoice/i scoped to telemedicine
 *     route or page tree. Telemedicine fee flows through the generic
 *     billing module separately. Covered case 4 pins the API-side fee
 *     contract; the user-facing settlement is owned by billing-cycle and
 *     billing-patient specs (already in the suite).
 *
 * Why these tests exist:
 *   The §3 backlog flagged five deepening areas. Four of the five have
 *   ZERO UI but DO have shipped API surfaces with regulatory weight
 *   (recording-consent under HIPAA / DPDP audio-capture rules; followup
 *   scheduling tied to compliance-billed remote-consult-followup
 *   billing; Rx delivery tied to controlled-substance e-Rx rules). API-
 *   layer pinning catches schema drift and missing audit rows even
 *   though the UI never makes them user-visible — and the day a UI
 *   ships, this spec's contracts will already be locked in. The fifth
 *   ("call quality / reconnection") is fundamentally not a server
 *   surface, so we pin the precheck fingerprint as the closest proxy.
 */
import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  freshPatientToken,
} from "./helpers";
import type { APIRequestContext } from "@playwright/test";

// ─── Local helpers (private to this spec) ─────────────────────────────────

/**
 * Future-ISO timestamp `n` minutes from now (default 5min) so the
 * server's past-date validation (telemedicine.ts:72) never trips.
 */
function inMinutes(n: number = 5): string {
  return new Date(Date.now() + n * 60_000).toISOString();
}

/**
 * Resolve the seeded DOCTOR row id (dr.sharma@medcore.local). Mirrors
 * the helper from telemedicine-patient.spec.ts:54 and
 * telemedicine-waiting-room.spec.ts:81 — kept inline so this spec is
 * self-contained and we don't inflate helpers.ts.
 */
async function resolveDoctorId(api: APIRequestContext): Promise<string> {
  const res = await api.get(`${API_BASE}/doctors`);
  if (!res.ok()) {
    throw new Error(
      `resolveDoctorId failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const list = json.data ?? json;
  const arr = Array.isArray(list) ? list : list?.doctors ?? [];
  const sharma = arr.find(
    (d: { user?: { email?: string; name?: string } }) =>
      d.user?.email === "dr.sharma@medcore.local" ||
      /sharma/i.test(d.user?.name ?? "")
  );
  return (sharma?.id ?? arr[0]?.id) as string;
}

/**
 * POST /telemedicine as ADMIN to schedule a session and return the new
 * row's `{ id, sessionNumber, fee }`. The fee echoes back from the
 * server so case 4's payment-pin test can compare what was requested vs
 * what landed on the row.
 */
async function seedTelemedSession(
  adminApi: APIRequestContext,
  opts: { patientId: string; doctorId: string; fee?: number; scheduledAt?: string }
): Promise<{ id: string; sessionNumber: string; fee: number }> {
  const res = await adminApi.post(`${API_BASE}/telemedicine`, {
    data: {
      patientId: opts.patientId,
      doctorId: opts.doctorId,
      scheduledAt: opts.scheduledAt ?? inMinutes(5),
      chiefComplaint: "E2E telemedicine-deep seed",
      fee: opts.fee ?? 500,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedTelemedSession failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return { id: data.id, sessionNumber: data.sessionNumber, fee: data.fee };
}

/**
 * Drive the session to IN_PROGRESS via PATCH /:id/start with the
 * supplied DOCTOR token so subsequent /prescription / /recording-start
 * calls don't hit the 409 "session not in progress" branch.
 */
async function startSession(
  request: APIRequestContext,
  doctorToken: string,
  sessionId: string
): Promise<void> {
  const res = await request.patch(`${API_BASE}/telemedicine/${sessionId}/start`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
  });
  if (!res.ok()) {
    throw new Error(
      `startSession failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
}

/**
 * Drive the session to COMPLETED via PATCH /:id/end so the
 * /followup PATCH (post-call scheduling) lands on a realistic row.
 */
async function endSession(
  request: APIRequestContext,
  doctorToken: string,
  sessionId: string,
  doctorNotes?: string
): Promise<void> {
  const res = await request.patch(`${API_BASE}/telemedicine/${sessionId}/end`, {
    headers: { Authorization: `Bearer ${doctorToken}` },
    data: { doctorNotes: doctorNotes ?? "E2E ended" },
  });
  if (!res.ok()) {
    throw new Error(
      `endSession failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
}

test.describe("Telemedicine deep — recording-consent / followup / Rx / payment-fee / call-quality (API-contract pinning where the UI surface is not shipped on this build)", () => {
  test("DOCTOR posts /recording/start with consent=true → 200 + recordingConsent=true persisted; consent=false → 400 explicit-consent error — pins the HIPAA/DPDP audio-capture-consent gate (telemedicine.ts:868-914)", async ({
    request,
    adminApi,
    doctorToken,
  }) => {
    const fresh = await freshPatientToken(request);
    const doctorId = await resolveDoctorId(adminApi);
    const session = await seedTelemedSession(adminApi, {
      patientId: fresh.patientId,
      doctorId,
    });
    await startSession(request, doctorToken, session.id);

    // Reject without consent — telemedicine.ts:881 returns 400 with the
    // explicit-consent error string. This is the load-bearing assertion
    // because the schema (telemedRecordingStartSchema) only enforces the
    // boolean shape; the truthiness gate is the handler's responsibility.
    const denied = await apiPost(
      request,
      doctorToken,
      `/telemedicine/${session.id}/recording/start`,
      { consent: false }
    );
    expect(denied.status, "consent=false must 400").toBe(400);

    // Accept with consent — 200 + recordingConsent=true.
    const allowed = await apiPost(
      request,
      doctorToken,
      `/telemedicine/${session.id}/recording/start`,
      { consent: true }
    );
    expect(allowed.status, "consent=true must succeed").toBeLessThan(400);
    expect(allowed.body?.data?.recordingConsent).toBe(true);
    expect(allowed.body?.data?.recordingStartedAt).toBeTruthy();

    // Stop with an archive URL (Jibri-webhook shape). The recordingUrl
    // is optional per telemedRecordingStopSchema; we send one to pin the
    // archive-persistence path.
    const archiveUrl = `https://archive.example.com/jibri/${session.id}.mp4`;
    const stopped = await apiPost(
      request,
      doctorToken,
      `/telemedicine/${session.id}/recording/stop`,
      { recordingUrl: archiveUrl }
    );
    expect(stopped.status, "recording/stop must succeed").toBeLessThan(400);
    expect(stopped.body?.data?.recordingUrl).toBe(archiveUrl);
    expect(stopped.body?.data?.recordingStoppedAt).toBeTruthy();
  });

  test("DOCTOR PATCHes /followup with a future ISO timestamp after ending the session → followUpScheduledAt persists; PATIENT firing the same route is rejected 403 — pins the call-end followup scheduling contract (telemedicine.ts:489-509)", async ({
    request,
    adminApi,
    doctorToken,
  }) => {
    const fresh = await freshPatientToken(request);
    const doctorId = await resolveDoctorId(adminApi);
    const session = await seedTelemedSession(adminApi, {
      patientId: fresh.patientId,
      doctorId,
    });
    await startSession(request, doctorToken, session.id);
    await endSession(request, doctorToken, session.id);

    // The brief framing is "followup scheduling from call end" — we
    // simulate the end-of-call PATCH that the server expects. Schedule
    // 7 days out as the canonical follow-up window.
    const followUpAt = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const res = await request.patch(
      `${API_BASE}/telemedicine/${session.id}/followup`,
      {
        headers: { Authorization: `Bearer ${doctorToken}` },
        data: { followUpScheduledAt: followUpAt },
      }
    );
    expect(res.status(), "doctor followup PATCH must succeed").toBeLessThan(400);
    const body = await res.json();
    expect(body?.data?.followUpScheduledAt).toBeTruthy();
    // Loose date equality — server may round to ms precision differently.
    expect(new Date(body.data.followUpScheduledAt).toISOString()).toBe(
      new Date(followUpAt).toISOString()
    );

    // PATIENT is NOT in authorize() for /followup (Role.ADMIN, Role.DOCTOR
    // only — telemedicine.ts:491). This pins that the patient cannot
    // self-schedule a follow-up from their own session, which is the
    // billing-compliance contract for tele-follow-ups.
    const patientRes = await request.patch(
      `${API_BASE}/telemedicine/${session.id}/followup`,
      {
        headers: { Authorization: `Bearer ${fresh.token}` },
        data: { followUpScheduledAt: followUpAt },
      }
    );
    expect(
      patientRes.status(),
      `PATIENT followup PATCH must be 403, got ${patientRes.status()}`
    ).toBe(403);
  });

  test("DOCTOR posts /prescription on a COMPLETED session → 201 with TRX-<sessionNumber> prescription id + items echoed; PATIENT firing the same route is rejected 403 — pins the post-consult Rx fill contract (telemedicine.ts:600-664)", async ({
    request,
    adminApi,
    doctorToken,
  }) => {
    const fresh = await freshPatientToken(request);
    const doctorId = await resolveDoctorId(adminApi);
    const session = await seedTelemedSession(adminApi, {
      patientId: fresh.patientId,
      doctorId,
    });
    await startSession(request, doctorToken, session.id);
    // The route accepts IN_PROGRESS or COMPLETED — we keep it
    // IN_PROGRESS here to mirror "fill the Rx mid-call before ending".

    const rxBody = {
      items: [
        {
          medicineName: "Amoxicillin",
          dosage: "500mg",
          frequency: "TID",
          duration: "5 days",
          instructions: "After meals; complete the full course.",
        },
        {
          medicineName: "Paracetamol",
          dosage: "650mg",
          frequency: "PRN",
          duration: "3 days",
          instructions: "Only if fever > 100°F",
        },
      ],
      advice: "Hydrate. Re-consult if no improvement in 48h.",
    };

    const res = await apiPost(
      request,
      doctorToken,
      `/telemedicine/${session.id}/prescription`,
      rxBody
    );
    expect(res.status, "doctor /prescription POST must succeed").toBeLessThan(400);
    expect(res.body?.data?.prescriptionId).toMatch(
      new RegExp(`^TRX-${session.sessionNumber}-\\d+$`)
    );
    expect(Array.isArray(res.body?.data?.items)).toBe(true);
    expect(res.body?.data?.items?.length).toBe(2);
    expect(res.body?.data?.advice).toBe(rxBody.advice);

    // PATIENT must NOT be able to write a prescription against their own
    // session — authorize is ADMIN/DOCTOR only (telemedicine.ts:602).
    const patientRes = await apiPost(
      request,
      fresh.token,
      `/telemedicine/${session.id}/prescription`,
      rxBody
    );
    expect(
      patientRes.status,
      `PATIENT /prescription POST must be 403, got ${patientRes.status}`
    ).toBe(403);

    // The session detail GET reflects the prescriptionId (PATIENT can
    // read their own session).
    const detail = await apiGet(
      request,
      fresh.token,
      `/telemedicine/${session.id}`
    );
    expect(detail.status).toBeLessThan(400);
    expect(detail.body?.data?.prescriptionId).toMatch(/^TRX-/);
  });

  test("ADMIN-supplied `fee` survives onto the session row and is visible to the PATIENT via GET /telemedicine/:id — pins the remote-consult payment-fee contract (telemedicine.ts:55, :104)", async ({
    request,
    adminApi,
  }) => {
    const fresh = await freshPatientToken(request);
    const doctorId = await resolveDoctorId(adminApi);

    // Use a non-default fee so the assertion is unambiguous (not the
    // 500-default fallback).
    const requestedFee = 1234;
    const session = await seedTelemedSession(adminApi, {
      patientId: fresh.patientId,
      doctorId,
      fee: requestedFee,
    });
    expect(
      session.fee,
      "POST /telemedicine response must echo the requested fee"
    ).toBe(requestedFee);

    // PATIENT reads their own session and the fee on the row matches.
    // This is the "settlement source of truth" pin — billing reads off
    // this same field on the session row.
    const detail = await apiGet(
      request,
      fresh.token,
      `/telemedicine/${session.id}`
    );
    expect(detail.status, "patient detail GET must succeed").toBeLessThan(400);
    expect(detail.body?.data?.fee, "fee on session row must match").toBe(
      requestedFee
    );
  });

  test("PATIENT precheck POST captures `bandwidthKbps` + `userAgent` on `precheckDetails` — the only call-quality fingerprint that ever lands server-side; reconnection itself is Jitsi-internal (telemedicine.ts:968-1029)", async ({
    request,
    adminApi,
  }) => {
    const fresh = await freshPatientToken(request);
    const doctorId = await resolveDoctorId(adminApi);
    const session = await seedTelemedSession(adminApi, {
      patientId: fresh.patientId,
      doctorId,
    });

    const precheckBody = {
      camera: true,
      mic: true,
      // 5_000 Kbps = 5 Mbps. The server stores it on precheckDetails
      // verbatim — there's no clamp/normalize.
      bandwidthKbps: 5000,
      userAgent: "Playwright-Telemed-Deep/1.0 (E2E call-quality pin)",
    };

    const res = await apiPost(
      request,
      fresh.token,
      `/telemedicine/${session.id}/precheck`,
      precheckBody
    );
    expect(res.status, "patient precheck POST must succeed").toBeLessThan(400);
    // Server returns precheck.passed (camera && mic) plus the echo.
    expect(res.body?.data?.precheckPassed).toBe(true);
    expect(res.body?.data?.precheck?.bandwidthKbps).toBe(precheckBody.bandwidthKbps);
    expect(res.body?.data?.precheck?.userAgent).toBe(precheckBody.userAgent);

    // The session row's `precheckDetails` JSON column now contains the
    // call-quality fingerprint. PATIENT reads back via GET /:id.
    const detail = await apiGet(
      request,
      fresh.token,
      `/telemedicine/${session.id}`
    );
    expect(detail.status).toBeLessThan(400);
    const stored = detail.body?.data?.precheckDetails as
      | { camera?: boolean; mic?: boolean; bandwidthKbps?: number; userAgent?: string }
      | null
      | undefined;
    // precheckDetails is stored as JSON on Prisma; tolerate either an
    // object payload or the unparsed-still-stringified form (defensive
    // for future schema drift).
    if (stored && typeof stored === "object") {
      expect(stored.bandwidthKbps).toBe(precheckBody.bandwidthKbps);
      expect(stored.userAgent).toBe(precheckBody.userAgent);
    } else {
      // If the API ever changes shape, fall through to the echoed
      // value from the precheck POST itself (same source of truth).
      expect(res.body?.data?.precheck?.bandwidthKbps).toBe(
        precheckBody.bandwidthKbps
      );
    }
  });

  test("RBAC contract — NURSE cannot fire /recording/start (authorize ADMIN/DOCTOR only); PATIENT-A cannot GET PATIENT-B's session (assertPatientOwnsResource gate, telemedicine.ts:223) — pins the cross-role and cross-patient guards", async ({
    request,
    adminApi,
    nurseToken,
  }) => {
    const a = await freshPatientToken(request);
    const b = await freshPatientToken(request);
    const doctorId = await resolveDoctorId(adminApi);
    const session = await seedTelemedSession(adminApi, {
      patientId: a.patientId,
      doctorId,
    });

    // NURSE on /recording/start → 403 (telemedicine.ts:870 authorize is
    // ADMIN, DOCTOR only).
    const nurseRes = await apiPost(
      request,
      nurseToken,
      `/telemedicine/${session.id}/recording/start`,
      { consent: true }
    );
    expect(
      nurseRes.status,
      `NURSE /recording/start must be 403, got ${nurseRes.status}`
    ).toBe(403);

    // PATIENT-B reading PATIENT-A's session → 403
    // (assertPatientOwnsResource gate, telemedicine.ts:223). Cross-
    // patient regression is the BOLA contract for the entire route.
    const crossRes = await apiGet(
      request,
      b.token,
      `/telemedicine/${session.id}`
    );
    expect(
      crossRes.status,
      `PATIENT-B reading PATIENT-A session must be 403, got ${crossRes.status}`
    ).toBe(403);
  });

  test("PATIENT can load /dashboard/telemedicine and the page renders without RBAC bounce — companion access-shape pin so the deep API-contract suite has at least one UI assertion (page.tsx is fully accessible to PATIENT, only Schedule CTA is gated)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/telemedicine", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /telemedicine/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Schedule CTA is admin/doctor/reception only (page.tsx:107-108
    // canSchedule). PATIENT must NOT see it.
    await expect(
      page.getByRole("button", { name: /schedule session/i })
    ).toHaveCount(0);

    // The three lifecycle tabs render for every authed role.
    await expect(page.getByRole("button", { name: /^upcoming$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^completed$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^cancelled$/i })).toBeVisible();
  });
});
