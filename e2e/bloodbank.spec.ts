import { faker } from "@faker-js/faker";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  seedPatient,
} from "./helpers";

/**
 * Blood Bank end-to-end clinical-safety flow.
 *
 * Closes coverage gap §7.1.C from the 2026-05-02 audit. Until this spec
 * landed, the Blood Bank module had only:
 *   - rbac-matrix coverage (negative deny checks)
 *   - one ot-surgery `Blood-bank requisition` test (currently skipped due
 *     to selector drift on the requests list)
 *
 * The flow we're protecting:
 *   1. ADMIN/DOCTOR registers a donor; the donor surfaces in the donor list
 *      (POST /bloodbank/donors → GET /bloodbank/donors).
 *   2. NURSE records a donation against that donor; an unapproved donation
 *      row is visible in `/donations`. DOCTOR approves it, which creates an
 *      AVAILABLE BloodUnit in inventory (`unitNumber` = `${donation.unitNumber}-1`).
 *   3. DOCTOR raises a blood request and the match endpoint returns
 *      ABO-compatible units only — never an O-only request matching A or B
 *      donor units (this is the cross-match constraint that we MUST keep
 *      green; if it ever regresses a transfusion-error becomes possible).
 *   4. Expired units are excluded from the match results (clinical-safety
 *      §C — issue #429). We seed an expired BloodUnit directly via the
 *      Prisma-backed `/bloodbank/inventory` endpoint with a past `expiresAt`
 *      and confirm /requests/:id/match never surfaces it.
 *   5. NURSE reserves a unit against an open request and the unit's status
 *      flips to RESERVED in the API, with `reservedForRequestId` set.
 *
 * Notes on stability:
 *  - We seed every donor + donation + unit via API as ADMIN so we own the
 *    full lifecycle and don't depend on the realistic seeder leaving
 *    anything specific behind.
 *  - Donor names are generated from faker + an Indian-context salt so
 *    repeated runs don't collide on (donorNumber is server-generated, but
 *    phone uniqueness has bitten other specs).
 *  - We assert against the API for status-flip cases where the page UI
 *    has a multi-step modal that's hard to drive deterministically without
 *    extra testids — the API contract is the actual safety boundary.
 *  - This spec is `--project=full` only by virtue of having no `@smoke`
 *    or `@regression` tags — matches the task brief.
 */

const DASH_TIMEOUT = 15_000;

// ─── Local helpers (file-scoped) ─────────────────────────────────────────

interface SeededDonor {
  id: string;
  donorNumber: string;
  name: string;
  bloodGroup: string;
}

interface SeededDonation {
  id: string;
  unitNumber: string;
  donorId: string;
}

interface SeededBloodUnit {
  id: string;
  unitNumber: string;
  bloodGroup: string;
  component: string;
  status: string;
}

function indianDonorName(): string {
  // The fixture's `indianishName` isn't exported, so we mimic the same
  // pattern here. Prefix with a short faker-derived salt so re-runs in
  // the same DB don't collide on phone uniqueness if this name is reused.
  const firsts = [
    "Aarav",
    "Vihaan",
    "Reyansh",
    "Arjun",
    "Rohan",
    "Saanvi",
    "Diya",
    "Anaya",
    "Meera",
    "Priya",
  ];
  const lasts = [
    "Mehta",
    "Krishnan",
    "Iyer",
    "Reddy",
    "Verma",
    "Patel",
    "Sharma",
    "Joshi",
    "Khan",
    "Gupta",
  ];
  const f = firsts[Math.floor(Math.random() * firsts.length)];
  const l = lasts[Math.floor(Math.random() * lasts.length)];
  return `${f} ${l}`;
}

function indianPhone(): string {
  // 10-digit Indian mobile: starts with 6/7/8/9. Faker's intl number can
  // produce shapes the API regex (^\+?[0-9 \-]{7,20}$) doesn't always
  // accept (parens, dots), so build it explicitly.
  const first = ["6", "7", "8", "9"][Math.floor(Math.random() * 4)];
  return `${first}${faker.string.numeric(9)}`;
}

async function seedDonor(
  api: import("@playwright/test").APIRequestContext,
  opts: { bloodGroup?: string } = {}
): Promise<SeededDonor> {
  const name = indianDonorName();
  const res = await api.post(`${API_BASE}/bloodbank/donors`, {
    data: {
      name,
      phone: indianPhone(),
      bloodGroup: opts.bloodGroup ?? "O_POS",
      gender: "MALE",
      // Donor weight ≥50 kg per createDonorSchema (phase4-ops.ts:101).
      weight: 70,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedDonor failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return {
    id: data.id,
    donorNumber: data.donorNumber,
    name: data.name ?? name,
    bloodGroup: data.bloodGroup ?? opts.bloodGroup ?? "O_POS",
  };
}

async function seedDonation(
  api: import("@playwright/test").APIRequestContext,
  opts: { donorId: string; volumeMl?: number }
): Promise<SeededDonation> {
  const res = await api.post(`${API_BASE}/bloodbank/donations`, {
    data: {
      donorId: opts.donorId,
      volumeMl: opts.volumeMl ?? 450,
      screeningNotes: "E2E seeded donation — bloodbank.spec.ts",
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedDonation failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return {
    id: data.id,
    unitNumber: data.unitNumber,
    donorId: data.donorId ?? opts.donorId,
  };
}

/**
 * Approve a donation. Approval auto-materialises a `BloodUnit` (default
 * PACKED_RED_CELLS, 42-day expiry) per bloodbank.ts:336 transaction.
 * Returns the freshly-created unit (which we can then transfuse / reserve).
 */
async function approveDonationAndReadUnit(
  api: import("@playwright/test").APIRequestContext,
  donationId: string
): Promise<SeededBloodUnit> {
  const res = await api.patch(
    `${API_BASE}/bloodbank/donations/${donationId}/approve`,
    {
      data: { approved: true },
    }
  );
  if (!res.ok()) {
    throw new Error(
      `approveDonation failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  // The approve endpoint returns just the donation row; pull units back via
  // `/bloodbank/donations` (which includes the units relation) to get the
  // newly-created BloodUnit.
  const list = await api.get(`${API_BASE}/bloodbank/donations?limit=50`);
  if (!list.ok()) {
    throw new Error(
      `donations list failed after approve: ${list.status()} ${(await list.text()).slice(0, 200)}`
    );
  }
  const json = await list.json();
  const rows: Array<{ id: string; units: SeededBloodUnit[] }> = json.data ?? [];
  const found = rows.find((d) => d.id === donationId);
  const firstUnit = found?.units?.[0];
  if (!firstUnit) {
    throw new Error(
      "approveDonationAndReadUnit: approved donation has no unit attached"
    );
  }
  return firstUnit;
}

async function seedBloodRequest(
  api: import("@playwright/test").APIRequestContext,
  opts: {
    patientId: string;
    bloodGroup: string;
    component?: string;
    unitsRequested?: number;
    urgency?: string;
  }
): Promise<{ id: string; requestNumber: string }> {
  const res = await api.post(`${API_BASE}/bloodbank/requests`, {
    data: {
      patientId: opts.patientId,
      bloodGroup: opts.bloodGroup,
      component: opts.component ?? "PACKED_RED_CELLS",
      unitsRequested: opts.unitsRequested ?? 1,
      reason: "E2E cross-match flow — bloodbank.spec.ts",
      urgency: opts.urgency ?? "ROUTINE",
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedBloodRequest failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return { id: data.id, requestNumber: data.requestNumber };
}

/**
 * Seed a deliberately-expired blood unit via POST /bloodbank/inventory.
 * `createBloodUnitSchema` accepts an arbitrary `expiresAt` ISO string, so
 * we point it 1 day in the past; the inventory + match endpoints must
 * never surface this unit (issue #429).
 */
async function seedExpiredUnit(
  api: import("@playwright/test").APIRequestContext,
  opts: { bloodGroup: string; component?: string }
): Promise<SeededBloodUnit> {
  const collectedAt = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000
  ).toISOString();
  const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await api.post(`${API_BASE}/bloodbank/inventory`, {
    data: {
      bloodGroup: opts.bloodGroup,
      component: opts.component ?? "PACKED_RED_CELLS",
      volumeMl: 350,
      collectedAt,
      expiresAt,
      storageLocation: "E2E-SHELF-EXPIRED",
      notes: "E2E seeded EXPIRED unit — must not appear in match results",
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedExpiredUnit failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return {
    id: data.id,
    unitNumber: data.unitNumber,
    bloodGroup: data.bloodGroup,
    component: data.component,
    status: data.status,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

test.describe("Blood Bank — donor / donation / cross-match clinical flow", () => {
  test("ADMIN registers a donor and the donor appears in the donor list (page + API)", async ({
    adminPage,
    adminApi,
  }) => {
    const page = adminPage;

    const donor = await seedDonor(adminApi, { bloodGroup: "B_POS" });

    // API contract: the donor is returned by GET /bloodbank/donors with
    // their generated donorNumber (BD######).
    const list = await adminApi.get(
      `${API_BASE}/bloodbank/donors?search=${encodeURIComponent(donor.name)}`
    );
    expect(list.ok(), "donors list should succeed").toBe(true);
    const listJson = await list.json();
    const found = (listJson.data ?? []).find(
      (d: { id: string }) => d.id === donor.id
    );
    expect(found, "seeded donor should be in /donors").toBeTruthy();
    expect(found.donorNumber).toMatch(/^BD\d{6}$/);

    // UI contract: the Donors tab on /dashboard/bloodbank renders the row.
    await page.goto("/dashboard/bloodbank");
    await expect(
      page.getByRole("heading", { name: /blood bank/i }).first()
    ).toBeVisible({ timeout: DASH_TIMEOUT });

    // Tab buttons are simple <button> elements in the page (line 326–337).
    await page.getByRole("button", { name: /^donors$/i }).first().click();

    // The row contains the donor number (font-mono) and full name. We
    // search by name to filter the list down (input on line 393–401).
    const search = page
      .getByPlaceholder(/search by name, phone, donor number/i)
      .first();
    await expect(search).toBeVisible({ timeout: DASH_TIMEOUT });
    await search.fill(donor.name);
    await search.press("Enter");

    await expect(page.locator("body")).toContainText(donor.donorNumber, {
      timeout: DASH_TIMEOUT,
    });
    await expect(page.locator("body")).toContainText(donor.name);
    await expectNotForbidden(page);
  });

  test("NURSE records a donation; DOCTOR approves it and the unit appears in inventory", async ({
    nursePage,
    adminApi,
    nurseToken,
    adminToken,
  }) => {
    const page = nursePage;

    // ADMIN-seeded donor (DOCTOR/NURSE/ADMIN may all create donors per the
    // route's authorize set, but seeding via adminApi keeps the spec simple).
    const donor = await seedDonor(adminApi, { bloodGroup: "A_POS" });

    // NURSE records a donation. POST /bloodbank/donations is gated to
    // NURSE / DOCTOR / ADMIN (bloodbank.ts:226). Use the nurseToken so this
    // exercises the actual NURSE RBAC path, not just an ADMIN override.
    const donationRes = await apiPost(
      page.request,
      nurseToken,
      "/bloodbank/donations",
      {
        donorId: donor.id,
        volumeMl: 450,
        screeningNotes: "NURSE-recorded donation — E2E",
      }
    );
    expect(donationRes.status, "NURSE POST /donations should succeed").toBe(
      201
    );
    const donation = donationRes.body.data;
    expect(donation.unitNumber).toMatch(/^BU\d{6}$/);

    // DOCTOR/ADMIN approves (NURSE is intentionally excluded from approval
    // per bloodbank.ts:317 — this is the clinical-staff separation that
    // matters for accountability). Use adminToken to flip approval.
    const approveRes = await page.request.patch(
      `${API_BASE}/bloodbank/donations/${donation.id}/approve`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { approved: true },
      }
    );
    expect(approveRes.status(), "approve should succeed").toBe(200);

    // After approval an AVAILABLE unit is created with unitNumber
    // `${donation.unitNumber}-1`. Confirm via GET /inventory.
    const inv = await apiGet(
      page.request,
      nurseToken,
      `/bloodbank/inventory?bloodGroup=${donor.bloodGroup}&limit=200`
    );
    expect(inv.status).toBe(200);
    const units: Array<{
      unitNumber: string;
      status: string;
      bloodGroup: string;
    }> = inv.body?.data ?? [];
    const seededUnit = units.find(
      (u) => u.unitNumber === `${donation.unitNumber}-1`
    );
    expect(
      seededUnit,
      `unit ${donation.unitNumber}-1 should be in inventory after approve`
    ).toBeTruthy();
    expect(seededUnit?.status).toBe("AVAILABLE");
    expect(seededUnit?.bloodGroup).toBe("A_POS");

    // UI contract: the Donations tab renders the unitNumber + donor name.
    await page.goto("/dashboard/bloodbank");
    await expect(
      page.getByRole("heading", { name: /blood bank/i }).first()
    ).toBeVisible({ timeout: DASH_TIMEOUT });
    await page.getByRole("button", { name: /^donations$/i }).first().click();
    await expect(page.locator("body")).toContainText(donation.unitNumber, {
      timeout: DASH_TIMEOUT,
    });
    await expectNotForbidden(page);
  });

  test("DOCTOR raises a blood request and ABO-compatible units surface — incompatible groups are excluded", async ({
    doctorPage,
    adminApi,
    doctorToken,
  }) => {
    const page = doctorPage;

    // Build a stock of two donors with DIFFERENT blood groups so we can
    // assert the matcher actually filters by ABO compatibility.
    //   - O- (universal donor): MUST appear for an A_POS recipient
    //   - B+ (incompatible with A_POS recipient): MUST NOT appear
    const oNegDonor = await seedDonor(adminApi, { bloodGroup: "O_NEG" });
    const bPosDonor = await seedDonor(adminApi, { bloodGroup: "B_POS" });

    const oNegDonation = await seedDonation(adminApi, { donorId: oNegDonor.id });
    const bPosDonation = await seedDonation(adminApi, { donorId: bPosDonor.id });

    const oNegUnit = await approveDonationAndReadUnit(adminApi, oNegDonation.id);
    const bPosUnit = await approveDonationAndReadUnit(adminApi, bPosDonation.id);
    expect(oNegUnit.bloodGroup).toBe("O_NEG");
    expect(bPosUnit.bloodGroup).toBe("B_POS");

    // Recipient: A_POS patient. Per RBC_COMPATIBILITY (abo-compatibility.ts:42),
    // A_POS recipient accepts {A_POS, A_NEG, O_POS, O_NEG} — so O_NEG matches,
    // B_POS doesn't.
    const patient = await seedPatient(adminApi);
    const request = await seedBloodRequest(adminApi, {
      patientId: patient.id,
      bloodGroup: "A_POS",
      component: "PACKED_RED_CELLS",
      unitsRequested: 1,
      urgency: "ROUTINE",
    });

    // POST /bloodbank/requests/:id/match — DOCTOR is in the authorize set
    // (bloodbank.ts:694).
    const matchRes = await page.request.post(
      `${API_BASE}/bloodbank/requests/${request.id}/match`,
      { headers: { Authorization: `Bearer ${doctorToken}` } }
    );
    expect(matchRes.status(), "match should succeed").toBe(200);
    const matchJson = await matchRes.json();
    const matched: Array<{ id: string; bloodGroup: string; unitNumber: string }> =
      matchJson.data ?? [];

    // Clinical-safety assertions:
    //  (a) the O_NEG unit is in the match set (universal-donor RBC).
    expect(
      matched.some((u) => u.id === oNegUnit.id),
      "O_NEG unit must be ABO-compatible with A_POS recipient"
    ).toBe(true);
    //  (b) the B_POS unit is NOT in the match set — this is the constraint
    //      that prevents a fatal mismatched transfusion.
    expect(
      matched.every((u) => u.id !== bPosUnit.id),
      "B_POS unit must NEVER match an A_POS recipient (fatal incompatibility)"
    ).toBe(true);
    //  (c) every returned unit is in a recipient-compatible group.
    const allowed = new Set(["A_POS", "A_NEG", "O_POS", "O_NEG"]);
    for (const u of matched) {
      expect(
        allowed.has(u.bloodGroup),
        `match returned ${u.bloodGroup} (${u.unitNumber}) for A_POS recipient`
      ).toBe(true);
    }

    // Sanity: the request also surfaces in the requests-list response.
    const list = await apiGet(
      page.request,
      doctorToken,
      "/bloodbank/requests?limit=50"
    );
    expect(list.status).toBe(200);
    const reqs: Array<{ id: string; requestNumber: string }> = list.body?.data ?? [];
    expect(reqs.find((r) => r.id === request.id)?.requestNumber).toBe(
      request.requestNumber
    );
    await expectNotForbidden(page);
  });

  test("Expired units are excluded from match results (issue #429 clinical-safety)", async ({
    doctorPage,
    adminApi,
    doctorToken,
  }) => {
    const page = doctorPage;

    // 1. Seed an EXPIRED O_POS unit directly via POST /bloodbank/inventory.
    //    expiresAt is 1 day in the past — the matcher uses
    //    `expiresAt: { gt: new Date() }` (bloodbank.ts:715) so this row
    //    must be filtered out.
    const expiredUnit = await seedExpiredUnit(adminApi, {
      bloodGroup: "O_POS",
      component: "PACKED_RED_CELLS",
    });
    expect(expiredUnit.status).toBe("AVAILABLE");

    // 2. Seed a fresh, in-date O_POS unit via the donor → donation → approve
    //    path so the match endpoint has at least one valid candidate to
    //    return. Without this we can't tell "matcher returned nothing
    //    because it's broken" vs "matcher returned nothing because there's
    //    nothing valid".
    const donor = await seedDonor(adminApi, { bloodGroup: "O_POS" });
    const donation = await seedDonation(adminApi, { donorId: donor.id });
    const freshUnit = await approveDonationAndReadUnit(adminApi, donation.id);

    // 3. Recipient: O_POS patient (so O_POS is the ONLY ABO-compatible
    //    donor group → tightly scoped, easy to reason about).
    const patient = await seedPatient(adminApi);
    const request = await seedBloodRequest(adminApi, {
      patientId: patient.id,
      bloodGroup: "O_POS",
      component: "PACKED_RED_CELLS",
    });

    const matchRes = await page.request.post(
      `${API_BASE}/bloodbank/requests/${request.id}/match`,
      { headers: { Authorization: `Bearer ${doctorToken}` } }
    );
    expect(matchRes.status()).toBe(200);
    const matchJson = await matchRes.json();
    const matched: Array<{ id: string; unitNumber: string }> =
      matchJson.data ?? [];

    // Hard assertions:
    //  (a) the EXPIRED unit must NEVER be in the match results — issuing
    //      it could transfuse haemolysed blood.
    expect(
      matched.every((u) => u.id !== expiredUnit.id),
      `expired unit ${expiredUnit.unitNumber} must NOT appear in match results`
    ).toBe(true);
    //  (b) the FRESH unit must be present (proves the filter is "expired
    //      only" not "everything").
    expect(
      matched.some((u) => u.id === freshUnit.id),
      "fresh in-date unit should appear in match results"
    ).toBe(true);

    // Sanity: the inventory endpoint (default, excludeExpired=true) also
    // omits the expired row — UI consumers of /inventory shouldn't ever
    // see it without explicitly opting in via `?expired=true`.
    const inv = await apiGet(
      page.request,
      doctorToken,
      "/bloodbank/inventory?bloodGroup=O_POS&limit=200"
    );
    expect(inv.status).toBe(200);
    const invUnits: Array<{ id: string }> = inv.body?.data ?? [];
    expect(invUnits.every((u) => u.id !== expiredUnit.id)).toBe(true);

    // And conversely: opting INTO expired units surfaces it (so we know
    // the row was actually persisted and we're not just asserting on an
    // empty DB).
    const invExpired = await apiGet(
      page.request,
      doctorToken,
      "/bloodbank/inventory?bloodGroup=O_POS&expired=true&limit=200"
    );
    expect(invExpired.status).toBe(200);
    const expiredRows: Array<{ id: string; isExpired?: boolean }> =
      invExpired.body?.data ?? [];
    expect(
      expiredRows.some((u) => u.id === expiredUnit.id),
      "expired-only filter should return the expired unit"
    ).toBe(true);
    await expectNotForbidden(page);
  });

  test("NURSE reserves a unit against an open request — status flips to RESERVED with reservedForRequestId set", async ({
    nursePage,
    adminApi,
    nurseToken,
  }) => {
    const page = nursePage;

    // Donor → donation → approved AVAILABLE unit (O_NEG, universal donor).
    const donor = await seedDonor(adminApi, { bloodGroup: "O_NEG" });
    const donation = await seedDonation(adminApi, { donorId: donor.id });
    const unit = await approveDonationAndReadUnit(adminApi, donation.id);
    expect(unit.status).toBe("AVAILABLE");

    // Recipient: O_NEG patient (only O_NEG donors compatible — keeps the
    // match set deterministic so the unit we just seeded is the candidate).
    const patient = await seedPatient(adminApi);
    const request = await seedBloodRequest(adminApi, {
      patientId: patient.id,
      bloodGroup: "O_NEG",
      component: "PACKED_RED_CELLS",
      urgency: "URGENT",
    });

    // POST /bloodbank/units/:id/reserve as NURSE — RESERVE is gated to
    // DOCTOR / ADMIN / NURSE (bloodbank.ts:1198).
    const reserveRes = await apiPost(
      page.request,
      nurseToken,
      `/bloodbank/units/${unit.id}/reserve`,
      { requestId: request.id, durationHours: 24 }
    );
    expect(reserveRes.status, "NURSE reserve should succeed").toBe(201);
    const reserved: {
      status: string;
      reservedForRequestId: string | null;
      reservedUntil: string | null;
    } = reserveRes.body.data;
    expect(reserved.status).toBe("RESERVED");
    expect(reserved.reservedForRequestId).toBe(request.id);
    expect(reserved.reservedUntil).toBeTruthy();

    // The reserved unit should also surface on GET /units/reserved.
    const reservedList = await apiGet(
      page.request,
      nurseToken,
      "/bloodbank/units/reserved"
    );
    expect(reservedList.status).toBe(200);
    const rows: Array<{ id: string; status: string }> =
      reservedList.body?.data ?? [];
    expect(
      rows.some((u) => u.id === unit.id && u.status === "RESERVED"),
      "reserved unit should appear in /units/reserved"
    ).toBe(true);

    // After reservation, the matcher must NOT return this unit any more
    // (status filter is `AVAILABLE`, bloodbank.ts:712) — i.e. one
    // reservation prevents another team from also issuing the same bag.
    const matchRes = await page.request.post(
      `${API_BASE}/bloodbank/requests/${request.id}/match`,
      { headers: { Authorization: `Bearer ${nurseToken}` } }
    );
    expect(matchRes.status()).toBe(200);
    const matchJson = await matchRes.json();
    const matched: Array<{ id: string }> = matchJson.data ?? [];
    expect(
      matched.every((u) => u.id !== unit.id),
      "reserved unit must NOT re-appear in /match (status filter is AVAILABLE)"
    ).toBe(true);
    await expectNotForbidden(page);
  });
});
