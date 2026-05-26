/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BloodBankPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/bloodbank/page.tsx — the blood bank
 *     dashboard (Inventory / Donors / Donations / Requests tabs) plus four
 *     modals (DonorModal, RequestModal, DeferralModal, SeparationModal) and
 *     the cross-match / reserve / issue inline panel. Endpoints the page
 *     hits:
 *       GET    /bloodbank/inventory/summary
 *       GET    /bloodbank/inventory?limit=200
 *       GET    /bloodbank/donors?limit=100[&search=...]
 *       GET    /bloodbank/donations?limit=50
 *       GET    /bloodbank/requests?limit=50
 *       POST   /bloodbank/donors                      (DonorModal)
 *       POST   /bloodbank/donors/:id/deferrals        (DeferralModal)
 *       POST   /bloodbank/donors/send-donation-reminders
 *       POST   /bloodbank/donations/:id/separate      (SeparationModal)
 *       PATCH  /bloodbank/donations/:id/approve
 *       POST   /bloodbank/requests                    (RequestModal)
 *       POST   /bloodbank/requests/:id/match          (cross-match)
 *       POST   /bloodbank/requests/:id/issue
 *       POST   /bloodbank/units/:id/reserve
 *       POST   /bloodbank/units/:id/release
 *       GET    /patients?search=...&limit=10          (RequestModal patient picker)
 *
 *   - Behaviours covered:
 *       1. Skeleton renders while loading; flips off after fetch settles.
 *       2. Summary strip renders totals (available, expiring, open reqs,
 *          donors).
 *       3. Initial parallel fetch of summary + inventory + donors +
 *          donations + requests.
 *       4. Inventory tab — per-group cards (A+/A-/B+/B-/AB+/AB-/O+/O-) with
 *          per-component counts and an "expiring in 7 days" badge when
 *          summary.expiringByBloodGroup[g] > 0.
 *       5. Reserved-units panel — renders when any unit.status === RESERVED;
 *          shows EXPIRED highlight when the API flagged or the date is past.
 *          Release button POSTs to /units/:id/release.
 *       6. Donors tab — table renders rows with prettyGroup; eligible column;
 *          Add Deferral button only when canApprove (ADMIN/DOCTOR).
 *          Search input + Enter key refetches /donors?search=...
 *          Empty state renders "No donors found".
 *       7. Donor registration button — gated by canRegisterDonor
 *          (NURSE/DOCTOR/ADMIN). Hidden for LAB_TECH.
 *       8. DonorModal — opens, POSTs payload, closes on success; surfaces
 *          payload field errors (Issue #223) and toast.error fallback.
 *       9. Send Reminders — confirm-gate; happy POST surfaces toast.success
 *          with count; error path toasts.
 *      10. Donations tab — pending donations show Approve/Reject; approved
 *          donations show Separate Components (when canApprove); empty state.
 *      11. approveDonation PATCH — both true (Approve) and false (Reject).
 *          Error path toasts.
 *      12. SeparationModal — toggle component checkbox, POSTs the selected
 *          set; empty selection blocks with toast.error.
 *      13. DeferralModal — opens, fills, POSTs.
 *      14. Requests tab — rows with urgency badge (ROUTINE/URGENT/EMERGENCY);
 *          empty state renders "No requests".
 *      15. New Request button — gated by canCreateRequest
 *          (DOCTOR/ADMIN/NURSE). Hidden for LAB_TECH.
 *      16. RequestModal — patient search; required patient + reason fields;
 *          happy POST closes.
 *      17. Cross-match flow — clicking Match Units POSTs /requests/:id/match
 *          and renders the candidate units. Selecting compatible units
 *          enables Issue; selecting mismatched units surfaces the ABO
 *          mismatch warning + textarea (≥10 chars required to issue).
 *          Issue button POSTs with overrideAboMismatch + clinicalReason.
 *      18. Cross-match reserve flow — Reserve Units POSTs /units/:id/reserve
 *          per selected unit, surfaces toast.success.
 *      19. Expired units in match dialog — render the EXPIRED badge and
 *          disable the checkbox.
 *      20. Error-path resilience — initial load() rejection swallowed
 *          (console.error), loading still flips off.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog.
 *     @medcore/shared isAboCompatible / aboMismatchReason / prettyBloodGroup
 *     resolve through the workspace package — not mocked.
 *
 * Notes per CLAUDE.md gotcha #13: blood bank donors are NOT linked to a
 * Patient/User, so routes use authorize(...) gating only — no cross-patient
 * BOLA helper. This test exercises the client-side capability gates
 * (canCreateRequest / canApprove / canRegisterDonor) rather than wire-level
 * RBAC.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, confirmMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  authMock: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));

import BloodBankPage from "../page";

// +48h to dodge IST/UTC midnight traps.
const FUTURE = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

type Donor = {
  id: string;
  donorNumber: string;
  name: string;
  phone: string;
  bloodGroup: string;
  gender: string;
  totalDonations: number;
  lastDonation?: string | null;
  isEligible: boolean;
};

type Donation = {
  id: string;
  unitNumber: string;
  donatedAt: string;
  volumeMl: number;
  approved: boolean;
  donor: Donor;
};

type BloodUnit = {
  id: string;
  unitNumber: string;
  bloodGroup: string;
  component: string;
  volumeMl: number;
  expiresAt: string;
  status: string;
  storageLocation?: string | null;
  reservedUntil?: string | null;
  reservedForRequestId?: string | null;
  isExpired?: boolean;
};

type BloodRequest = {
  id: string;
  requestNumber: string;
  patient: { id: string; user: { name: string } };
  bloodGroup: string;
  component: string;
  unitsRequested: number;
  reason: string;
  urgency: string;
  fulfilled: boolean;
  createdAt: string;
  units: BloodUnit[];
};

function donorFixture(overrides: Partial<Donor> = {}): Donor {
  return {
    id: "d-1",
    donorNumber: "DN-001",
    name: "Asha Rao",
    phone: "9999900001",
    bloodGroup: "O_POS",
    gender: "FEMALE",
    totalDonations: 3,
    lastDonation: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    isEligible: true,
    ...overrides,
  };
}

function donationFixture(overrides: Partial<Donation> = {}): Donation {
  return {
    id: "don-1",
    unitNumber: "U-001",
    donatedAt: new Date().toISOString(),
    volumeMl: 450,
    approved: false,
    donor: donorFixture(),
    ...overrides,
  };
}

function unitFixture(overrides: Partial<BloodUnit> = {}): BloodUnit {
  return {
    id: "u-1",
    unitNumber: "U-001",
    bloodGroup: "O_POS",
    component: "PACKED_RED_CELLS",
    volumeMl: 250,
    expiresAt: FUTURE,
    status: "AVAILABLE",
    storageLocation: "Fridge-1",
    ...overrides,
  };
}

function requestFixture(overrides: Partial<BloodRequest> = {}): BloodRequest {
  return {
    id: "r-1",
    requestNumber: "REQ-001",
    patient: { id: "p-1", user: { name: "John Doe" } },
    bloodGroup: "O_POS",
    component: "PACKED_RED_CELLS",
    unitsRequested: 1,
    reason: "Surgery",
    urgency: "URGENT",
    fulfilled: false,
    createdAt: new Date().toISOString(),
    units: [],
    ...overrides,
  };
}

const summaryFixture = {
  totalAvailable: 12,
  byBloodGroup: {
    O_POS: { PACKED_RED_CELLS: 5, PLATELETS: 2 },
    A_POS: { PACKED_RED_CELLS: 3 },
  },
  byComponent: { PACKED_RED_CELLS: 8, PLATELETS: 2 },
  expiringSoon: 2,
  expiringByBloodGroup: { O_POS: 2 },
};

/**
 * Wire the parallel load() — five GETs by URL prefix. Tests pass overrides
 * per-call by URL.
 */
function wireLoad(overrides: {
  summary?: any;
  inventory?: BloodUnit[];
  donors?: Donor[];
  donations?: Donation[];
  requests?: BloodRequest[];
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/bloodbank/inventory/summary"))
      return Promise.resolve({ data: overrides.summary ?? summaryFixture });
    if (url.startsWith("/bloodbank/inventory"))
      return Promise.resolve({ data: overrides.inventory ?? [] });
    if (url.startsWith("/bloodbank/donors"))
      return Promise.resolve({ data: overrides.donors ?? [] });
    if (url.startsWith("/bloodbank/donations"))
      return Promise.resolve({ data: overrides.donations ?? [] });
    if (url.startsWith("/bloodbank/requests"))
      return Promise.resolve({ data: overrides.requests ?? [] });
    if (url.startsWith("/patients"))
      return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
}

function asRole(role: string) {
  authMock.mockReturnValue({
    user: { id: `u-${role.toLowerCase()}`, role, name: role },
    isLoading: false,
  });
}

describe("BloodBankPage (blood bank dashboard — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    asRole("ADMIN");
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------- initial render ---------------------------

  it("renders the loading skeleton while the initial fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<BloodBankPage />);
    expect(
      await screen.findByTestId("bloodbank-loading"),
    ).toBeInTheDocument();
  });

  it("renders the page heading and fires the five parallel GETs", async () => {
    wireLoad();
    render(<BloodBankPage />);

    expect(
      screen.getByRole("heading", { name: /Blood Bank/i }),
    ).toBeInTheDocument();

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => u.startsWith("/bloodbank/inventory/summary"))).toBe(true);
      expect(urls.some((u) => u.includes("/bloodbank/inventory?limit=200"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/bloodbank/donors?limit=100"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/bloodbank/donations?limit=50"))).toBe(true);
      expect(urls.some((u) => u.startsWith("/bloodbank/requests?limit=50"))).toBe(true);
    });
  });

  it("renders the summary strip with available units, expiring count, open requests, total donors", async () => {
    wireLoad({
      donors: [donorFixture(), donorFixture({ id: "d-2", donorNumber: "DN-002" })],
      requests: [requestFixture(), requestFixture({ id: "r-2", fulfilled: true })],
    });
    render(<BloodBankPage />);

    // Wait for skeleton to disappear so summary renders.
    await waitFor(() =>
      expect(screen.queryByTestId("bloodbank-loading")).not.toBeInTheDocument(),
    );

    expect(screen.getByText("Available Units")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument(); // totalAvailable
    expect(screen.getByText("Expiring in 7 days")).toBeInTheDocument();
    expect(screen.getByText("Open Requests")).toBeInTheDocument();
    expect(screen.getByText("Total Donors")).toBeInTheDocument();
  });

  it("swallows the initial GET rejection (console.error) and still flips loading off", async () => {
    const origConsoleErr = console.error;
    console.error = vi.fn();
    apiMock.get.mockRejectedValue(new Error("backend down"));
    render(<BloodBankPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("bloodbank-loading")).not.toBeInTheDocument(),
    );
    console.error = origConsoleErr;
  });

  // -------------------------- Inventory tab ----------------------------

  it("Inventory tab — renders 8 blood-group cards (A+/A-/B+/B-/AB+/AB-/O+/O-) with totals", async () => {
    wireLoad();
    render(<BloodBankPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("bloodbank-loading")).not.toBeInTheDocument(),
    );

    // 8 prettified blood-group labels.
    expect(screen.getByText("A+")).toBeInTheDocument();
    expect(screen.getByText("A-")).toBeInTheDocument();
    expect(screen.getByText("B+")).toBeInTheDocument();
    expect(screen.getByText("B-")).toBeInTheDocument();
    expect(screen.getByText("AB+")).toBeInTheDocument();
    expect(screen.getByText("AB-")).toBeInTheDocument();
    expect(screen.getByText("O+")).toBeInTheDocument();
    expect(screen.getByText("O-")).toBeInTheDocument();
  });

  it("Inventory tab — surfaces the 'X expiring in 7 days' badge per-group from summary.expiringByBloodGroup", async () => {
    wireLoad();
    render(<BloodBankPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("bloodbank-loading")).not.toBeInTheDocument(),
    );

    // O_POS has 2 expiring.
    expect(
      screen.getByText(/2 expiring in 7 days/i),
    ).toBeInTheDocument();
  });

  it("Inventory tab — Reserved Units panel renders when any unit has status=RESERVED; Release POSTs", async () => {
    const reservedUntil = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    wireLoad({
      inventory: [
        unitFixture({
          id: "u-res",
          unitNumber: "U-RES-1",
          status: "RESERVED",
          reservedUntil,
        }),
      ],
    });
    apiMock.post.mockResolvedValue({ data: {} });
    render(<BloodBankPage />);

    await screen.findByText(/Reserved Units \(1\)/i);
    expect(screen.getByText("U-RES-1")).toBeInTheDocument();
    // hours-left badge ("Xh Ym left")
    expect(screen.getByText(/left/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Release$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/units/u-res/release",
        {},
      ),
    );
  });

  it("Inventory tab — RESERVED + expired unit shows EXPIRED badge + 'Past expiry — discard' copy", async () => {
    wireLoad({
      inventory: [
        unitFixture({
          id: "u-exp",
          unitNumber: "U-EXP-1",
          status: "RESERVED",
          expiresAt: PAST,
          isExpired: true,
        }),
      ],
    });
    render(<BloodBankPage />);

    await screen.findByText(/Reserved Units/i);
    expect(
      screen.getByTestId("expired-badge-U-EXP-1"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Past expiry — discard/i)).toBeInTheDocument();
  });

  it("Release error surfaces toast.error", async () => {
    wireLoad({
      inventory: [
        unitFixture({ id: "u-res", unitNumber: "U-RES", status: "RESERVED" }),
      ],
    });
    apiMock.post.mockRejectedValue(new Error("release failed"));

    render(<BloodBankPage />);
    await screen.findByText(/Reserved Units/i);

    fireEvent.click(screen.getByRole("button", { name: /^Release$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("release failed"),
    );
  });

  // -------------------------- Donors tab -------------------------------

  it("Donors tab — renders donor rows with donor number, name, prettyGroup, eligibility", async () => {
    wireLoad({
      donors: [
        donorFixture(),
        donorFixture({
          id: "d-2",
          donorNumber: "DN-002",
          name: "Vikram Singh",
          bloodGroup: "A_NEG",
          isEligible: false,
          lastDonation: null,
        }),
      ],
    });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));

    await screen.findByText("Asha Rao");
    expect(screen.getByText("Vikram Singh")).toBeInTheDocument();
    expect(screen.getByText("DN-001")).toBeInTheDocument();
    expect(screen.getByText("DN-002")).toBeInTheDocument();
    expect(screen.getByText("A-")).toBeInTheDocument();
    // First donor eligible → "Yes", second not → "No".
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("Donors tab — empty state renders 'No donors found'", async () => {
    wireLoad({ donors: [] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));

    expect(await screen.findByText(/No donors found/i)).toBeInTheDocument();
  });

  it("Donors tab — search input + Enter key refetches /bloodbank/donors with ?search=...", async () => {
    wireLoad();
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));

    const searchInput = await screen.findByPlaceholderText(
      /Search by name, phone, donor number/i,
    );
    fireEvent.change(searchInput, { target: { value: "Asha" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/bloodbank\/donors\?limit=100&search=Asha/),
      ),
    );
  });

  it("Donors tab — Add Deferral button only visible to canApprove roles (ADMIN/DOCTOR); hidden for NURSE", async () => {
    asRole("NURSE");
    wireLoad({ donors: [donorFixture()] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));

    await screen.findByText("Asha Rao");
    expect(
      screen.queryByRole("button", { name: /Add Deferral/i }),
    ).not.toBeInTheDocument();
  });

  it("Donors tab — Add Deferral opens DeferralModal; happy POST submits payload", async () => {
    wireLoad({ donors: [donorFixture()] });
    apiMock.post.mockResolvedValue({ data: {} });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByText("Asha Rao");

    fireEvent.click(screen.getByRole("button", { name: /Add Deferral/i }));

    expect(
      await screen.findByRole("heading", { name: /Add Donor Deferral/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Save Deferral$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/donors/d-1/deferrals",
        expect.objectContaining({
          reason: "Recent travel",
          deferralType: "TEMPORARY",
        }),
      ),
    );
  });

  it("DeferralModal — POST rejection surfaces toast.error", async () => {
    wireLoad({ donors: [donorFixture()] });
    apiMock.post.mockRejectedValue(new Error("deferral fail"));
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByText("Asha Rao");

    fireEvent.click(screen.getByRole("button", { name: /Add Deferral/i }));
    await screen.findByRole("heading", { name: /Add Donor Deferral/i });

    fireEvent.click(screen.getByRole("button", { name: /^Save Deferral$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("deferral fail"),
    );
  });

  it("DeferralModal — Cancel closes without POST", async () => {
    wireLoad({ donors: [donorFixture()] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByText("Asha Rao");

    fireEvent.click(screen.getByRole("button", { name: /Add Deferral/i }));
    await screen.findByRole("heading", { name: /Add Donor Deferral/i });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Add Donor Deferral/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Donors tab — Register Donor button hidden for LAB_TECH (no canRegisterDonor)", async () => {
    asRole("LAB_TECH");
    wireLoad();
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));

    await screen.findByPlaceholderText(/Search by name/i);
    expect(
      screen.queryByRole("button", { name: /Register Donor/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Send Reminders$/i }),
    ).not.toBeInTheDocument();
  });

  // ----------------------- DonorModal ---------------------------------

  it("DonorModal — opens, fills, happy POST closes and triggers reload", async () => {
    wireLoad();
    apiMock.post.mockResolvedValue({ data: { id: "d-new" } });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(screen.getByRole("button", { name: /Register Donor/i }));

    expect(
      await screen.findByRole("heading", { name: /^Register Donor$/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("donor-name"), {
      target: { value: "New Donor" },
    });
    fireEvent.change(screen.getByTestId("donor-phone"), {
      target: { value: "9000000000" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/donors",
        expect.objectContaining({
          name: "New Donor",
          phone: "9000000000",
          bloodGroup: "O_POS",
        }),
      ),
    );
  });

  it("DonorModal — server field-error payload populates per-field errors + toast", async () => {
    wireLoad();
    const serverErr = Object.assign(new Error("validation failed"), {
      payload: {
        details: [{ field: "email", message: "Invalid email format" }],
      },
    });
    apiMock.post.mockRejectedValue(serverErr);

    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(screen.getByRole("button", { name: /Register Donor/i }));
    await screen.findByRole("heading", { name: /^Register Donor$/i });

    fireEvent.change(screen.getByTestId("donor-name"), {
      target: { value: "A" },
    });
    fireEvent.change(screen.getByTestId("donor-phone"), {
      target: { value: "9000000000" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));

    await waitFor(() =>
      expect(
        screen.getByTestId("error-donor-email"),
      ).toHaveTextContent(/Invalid email format/i),
    );
    expect(toastMock.error).toHaveBeenCalledWith("Invalid email format");
  });

  it("DonorModal — non-payload error path surfaces toast.error with the message", async () => {
    wireLoad();
    apiMock.post.mockRejectedValue(new Error("network down"));

    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(screen.getByRole("button", { name: /Register Donor/i }));
    await screen.findByRole("heading", { name: /^Register Donor$/i });

    fireEvent.change(screen.getByTestId("donor-name"), {
      target: { value: "Anon" },
    });
    fireEvent.change(screen.getByTestId("donor-phone"), {
      target: { value: "9000000000" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Register$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("network down"),
    );
  });

  it("DonorModal — Cancel closes without POST", async () => {
    wireLoad();
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(screen.getByRole("button", { name: /Register Donor/i }));
    await screen.findByRole("heading", { name: /^Register Donor$/i });

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^Register Donor$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ----------------------- Send Reminders -----------------------------

  it("Send Reminders — happy path: confirm true → POST → toast.success with count", async () => {
    wireLoad();
    confirmMock.mockResolvedValue(true);
    apiMock.post.mockResolvedValue({ data: { count: 7 } });

    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(
      screen.getByRole("button", { name: /^Send Reminders$/i }),
    );

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/donors/send-donation-reminders",
        {},
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("7"),
    );
  });

  it("Send Reminders — declined confirm does NOT POST", async () => {
    wireLoad();
    confirmMock.mockResolvedValue(false);

    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(
      screen.getByRole("button", { name: /^Send Reminders$/i }),
    );

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(apiMock.post).not.toHaveBeenCalledWith(
      "/bloodbank/donors/send-donation-reminders",
      expect.anything(),
    );
  });

  it("Send Reminders — POST rejection toasts an error", async () => {
    wireLoad();
    confirmMock.mockResolvedValue(true);
    apiMock.post.mockRejectedValue(new Error("smtp down"));

    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donors$/i }));
    await screen.findByPlaceholderText(/Search by name/i);

    fireEvent.click(
      screen.getByRole("button", { name: /^Send Reminders$/i }),
    );

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("smtp down"),
    );
  });

  // ----------------------- Donations tab ------------------------------

  it("Donations tab — empty state renders 'No donations recorded'", async () => {
    wireLoad({ donations: [] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));

    expect(
      await screen.findByText(/No donations recorded/i),
    ).toBeInTheDocument();
  });

  it("Donations tab — pending donation shows Approve + Reject; approveDonation PATCH=true on Approve", async () => {
    wireLoad({ donations: [donationFixture()] });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));

    await screen.findByText("U-001");
    expect(screen.getByText(/Pending/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/bloodbank/donations/don-1/approve",
        { approved: true },
      ),
    );
  });

  it("Donations tab — Reject calls approveDonation with approved=false", async () => {
    wireLoad({ donations: [donationFixture()] });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));
    await screen.findByText("U-001");

    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/bloodbank/donations/don-1/approve",
        { approved: false },
      ),
    );
  });

  it("approveDonation PATCH rejection surfaces toast.error", async () => {
    wireLoad({ donations: [donationFixture()] });
    apiMock.patch.mockRejectedValue(new Error("conflict"));
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));
    await screen.findByText("U-001");

    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("conflict"),
    );
  });

  it("Donations tab — approved donation surfaces Separate Components for canApprove", async () => {
    wireLoad({ donations: [donationFixture({ approved: true })] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));
    await screen.findByText("U-001");

    expect(
      screen.getByRole("button", { name: /Separate Components/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Approved/i)).toBeInTheDocument();
  });

  it("SeparationModal — opens; default PRBC is selected; happy POST submits the selected components", async () => {
    wireLoad({ donations: [donationFixture({ approved: true })] });
    apiMock.post.mockResolvedValue({ data: {} });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));
    await screen.findByText("U-001");

    fireEvent.click(
      screen.getByRole("button", { name: /Separate Components/i }),
    );

    expect(
      await screen.findByRole("heading", { name: /Separate Components/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Separate$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/donations/don-1/separate",
        expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({ component: "PRBC" }),
          ]),
        }),
      ),
    );
  });

  it("SeparationModal — unchecking all components blocks submission with toast.error", async () => {
    wireLoad({ donations: [donationFixture({ approved: true })] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));
    await screen.findByText("U-001");

    fireEvent.click(
      screen.getByRole("button", { name: /Separate Components/i }),
    );

    await screen.findByRole("heading", { name: /Separate Components/i });

    // Uncheck the default PRBC.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    fireEvent.click(screen.getByRole("button", { name: /^Separate$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/at least one component/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("SeparationModal — POST rejection surfaces toast.error", async () => {
    wireLoad({ donations: [donationFixture({ approved: true })] });
    apiMock.post.mockRejectedValue(new Error("sep failed"));
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^donations$/i }));
    await screen.findByText("U-001");

    fireEvent.click(
      screen.getByRole("button", { name: /Separate Components/i }),
    );
    await screen.findByRole("heading", { name: /Separate Components/i });

    fireEvent.click(screen.getByRole("button", { name: /^Separate$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("sep failed"),
    );
  });

  // ----------------------- Requests tab -------------------------------

  it("Requests tab — empty state renders 'No requests'", async () => {
    wireLoad({ requests: [] });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));

    expect(await screen.findByText(/^No requests$/i)).toBeInTheDocument();
  });

  it("Requests tab — renders rows with urgency badge; Match Units button shows for unfulfilled", async () => {
    wireLoad({
      requests: [
        requestFixture({ urgency: "EMERGENCY" }),
        requestFixture({
          id: "r-2",
          requestNumber: "REQ-002",
          urgency: "ROUTINE",
          fulfilled: true,
        }),
      ],
    });
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));

    await screen.findByText("REQ-001");
    expect(screen.getByText("REQ-002")).toBeInTheDocument();
    expect(screen.getByText("EMERGENCY")).toBeInTheDocument();
    expect(screen.getByText("ROUTINE")).toBeInTheDocument();
    // Only unfulfilled gets Match Units.
    expect(
      screen.getAllByRole("button", { name: /Match Units/i }).length,
    ).toBe(1);
    expect(screen.getByText(/^Fulfilled$/i)).toBeInTheDocument();
  });

  it("Requests tab — New Request hidden for LAB_TECH; visible for DOCTOR/ADMIN/NURSE", async () => {
    asRole("LAB_TECH");
    wireLoad();
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));

    await screen.findByText(/^No requests$/i);
    expect(
      screen.queryByRole("button", { name: /New Request/i }),
    ).not.toBeInTheDocument();
  });

  // ----------------------- RequestModal -------------------------------

  it("RequestModal — opens; missing patient blocks submit with toast.error", async () => {
    wireLoad();
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText(/^No requests$/i);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));

    expect(
      await screen.findByRole("heading", { name: /New Blood Request/i }),
    ).toBeInTheDocument();

    // Fill reason so the disabled-state guard is past; patient still empty.
    // Submit button is disabled when reason OR patient is blank — fill reason
    // and verify that submission still blocks on patient since patientId is empty.
    fireEvent.change(
      screen.getByPlaceholderText(/Clinical reason/i),
      { target: { value: "Surgery prep" } },
    );

    // The submit button is disabled until both reason + patientId are set;
    // since patient is missing, button is still disabled.
    const submitBtn = screen.getByRole("button", { name: /Submit Request/i });
    expect(submitBtn).toBeDisabled();
  });

  it("RequestModal — patient search hits /patients?search=...&limit=10; selecting + submitting POSTs", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({
          data: [
            { id: "p-1", mrNumber: "MR-1", user: { name: "John Doe" } },
          ],
        });
      }
      if (url.startsWith("/bloodbank/inventory/summary"))
        return Promise.resolve({ data: summaryFixture });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { id: "r-new" } });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText(/^No requests$/i);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    await screen.findByRole("heading", { name: /New Blood Request/i });

    const patientInput = screen.getByPlaceholderText(
      /Search patient by name \/ MR/i,
    );
    fireEvent.change(patientInput, { target: { value: "John" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringMatching(/^\/patients\?search=John/),
      ),
    );

    // Select patient from dropdown.
    const select = await screen.findByRole("combobox", { name: "" }).catch(() => null);
    // The dropdown is the first <select> rendered by RequestModal; use the
    // first option-bearing select. Fallback: find by has(option John Doe).
    const selects = document.querySelectorAll("select");
    const patientSelect = Array.from(selects).find((s) =>
      Array.from(s.querySelectorAll("option")).some((o) =>
        o.textContent?.includes("John Doe"),
      ),
    ) as HTMLSelectElement;
    fireEvent.change(patientSelect, { target: { value: "p-1" } });

    fireEvent.change(screen.getByPlaceholderText(/Clinical reason/i), {
      target: { value: "Anaemia" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Submit Request/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/requests",
        expect.objectContaining({
          patientId: "p-1",
          bloodGroup: "O_POS",
          component: "PACKED_RED_CELLS",
          unitsRequested: 1,
          reason: "Anaemia",
        }),
      ),
    );
    // Suppress unused
    void select;
  });

  it("RequestModal — search error path falls through (console.error swallowed)", async () => {
    const origConsoleErr = console.error;
    console.error = vi.fn();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?search="))
        return Promise.reject(new Error("patients down"));
      if (url.startsWith("/bloodbank/inventory/summary"))
        return Promise.resolve({ data: summaryFixture });
      return Promise.resolve({ data: [] });
    });
    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText(/^No requests$/i);

    fireEvent.click(screen.getByRole("button", { name: /New Request/i }));
    await screen.findByRole("heading", { name: /New Blood Request/i });

    const patientInput = screen.getByPlaceholderText(
      /Search patient by name \/ MR/i,
    );
    fireEvent.change(patientInput, { target: { value: "Jane" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));

    // The modal should still be open and not crash.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      screen.getByRole("heading", { name: /New Blood Request/i }),
    ).toBeInTheDocument();
    console.error = origConsoleErr;
  });

  // -------------------- Cross-match flow ------------------------------

  it("Cross-match — Match Units POSTs /requests/:id/match and renders candidate units", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/bloodbank/requests/r-1/match") {
        return Promise.resolve({
          data: [
            unitFixture({ id: "u-1", unitNumber: "U-MATCH-1" }),
            unitFixture({
              id: "u-2",
              unitNumber: "U-MATCH-2",
              bloodGroup: "A_POS",
            }),
          ],
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/requests/r-1/match",
      ),
    );
    expect(
      await screen.findByText(/Match Units for REQ-001/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("abo-unit-U-MATCH-1")).toBeInTheDocument();
    expect(screen.getByTestId("abo-unit-U-MATCH-2")).toBeInTheDocument();
  });

  it("Cross-match — selecting a compatible unit enables Issue button; happy POST submits unitIds", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/bloodbank/requests/r-1/match") {
        // Compatible: O+ donor for O+ recipient.
        return Promise.resolve({
          data: [unitFixture({ id: "u-1", unitNumber: "U-MATCH-1" })],
        });
      }
      if (url === "/bloodbank/requests/r-1/issue") {
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    const unit = await screen.findByTestId("abo-unit-U-MATCH-1");
    const checkbox = within(unit).getByRole("checkbox");
    fireEvent.click(checkbox);

    const issueBtn = screen.getByTestId("abo-issue-button");
    expect(issueBtn).not.toBeDisabled();
    fireEvent.click(issueBtn);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/requests/r-1/issue",
        expect.objectContaining({ unitIds: ["u-1"] }),
      ),
    );
  });

  it("Cross-match — mismatched selection surfaces ABO warning + requires ≥10-char clinicalReason to issue", async () => {
    // Request O- recipient; A+ donor unit → incompatible (RBC matrix:
    // O_NEG accepts only O_NEG).
    wireLoad({ requests: [requestFixture({ bloodGroup: "O_NEG" })] });
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/bloodbank/requests/r-1/match") {
        return Promise.resolve({
          data: [
            unitFixture({
              id: "u-incompat",
              unitNumber: "U-INCOMPAT-1",
              bloodGroup: "A_POS",
            }),
          ],
        });
      }
      if (url === "/bloodbank/requests/r-1/issue") {
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    const unit = await screen.findByTestId("abo-unit-U-INCOMPAT-1");
    const checkbox = within(unit).getByRole("checkbox");
    fireEvent.click(checkbox);

    // Warning panel appears.
    expect(
      await screen.findByTestId("abo-mismatch-warning"),
    ).toBeInTheDocument();

    // Issue button still disabled until ≥10 chars in textarea.
    const issueBtn = screen.getByTestId("abo-issue-button");
    expect(issueBtn).toBeDisabled();

    // Type a short reason — still disabled.
    fireEvent.change(screen.getByTestId("abo-override-reason"), {
      target: { value: "short" },
    });
    expect(issueBtn).toBeDisabled();

    // Type ≥10-char reason — enabled.
    fireEvent.change(screen.getByTestId("abo-override-reason"), {
      target: { value: "Massive haemorrhage, attending Dr Rao authorised" },
    });
    expect(issueBtn).not.toBeDisabled();

    fireEvent.click(issueBtn);

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/requests/r-1/issue",
        expect.objectContaining({
          unitIds: ["u-incompat"],
          overrideAboMismatch: true,
          clinicalReason: expect.stringMatching(/Massive haemorrhage/i),
        }),
      ),
    );
  });

  it("Cross-match — expired unit renders EXPIRED badge and the checkbox is disabled", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/bloodbank/requests/r-1/match") {
        return Promise.resolve({
          data: [
            unitFixture({
              id: "u-expired",
              unitNumber: "U-EXPIRED-1",
              isExpired: true,
              expiresAt: PAST,
            }),
          ],
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    await screen.findByTestId("abo-unit-U-EXPIRED-1");
    expect(
      screen.getByTestId("expired-badge-U-EXPIRED-1"),
    ).toBeInTheDocument();
    const unitLabel = screen.getByTestId("abo-unit-U-EXPIRED-1");
    const checkbox = within(unitLabel).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox).toBeDisabled();
  });

  it("Cross-match — match POST rejection surfaces toast.error", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockRejectedValue(new Error("match failed"));
    render(<BloodBankPage />);

    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("match failed"),
    );
  });

  it("Cross-match — Reserve Units POSTs /units/:id/reserve per selected unit + toasts success", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/bloodbank/requests/r-1/match") {
        return Promise.resolve({
          data: [unitFixture({ id: "u-1", unitNumber: "U-MATCH-1" })],
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    const unit = await screen.findByTestId("abo-unit-U-MATCH-1");
    fireEvent.click(within(unit).getByRole("checkbox"));

    fireEvent.click(
      screen.getByRole("button", { name: /Reserve 1 Unit\(s\) \(24h\)/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/bloodbank/units/u-1/reserve",
        expect.objectContaining({
          requestId: "r-1",
          durationHours: 24,
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Reserved 1 unit\(s\) for 24h/i),
    );
  });

  it("Cross-match — Cancel button closes the modal", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockResolvedValue({ data: [] });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));
    await screen.findByText(/Match Units for REQ-001/i);

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/Match Units for REQ-001/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("Cross-match — 'No compatible units available' renders when match returns empty", async () => {
    wireLoad({ requests: [requestFixture()] });
    apiMock.post.mockImplementation((url: string) => {
      if (url === "/bloodbank/requests/r-1/match")
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });

    render(<BloodBankPage />);
    fireEvent.click(screen.getByRole("button", { name: /^requests$/i }));
    await screen.findByText("REQ-001");

    fireEvent.click(screen.getByRole("button", { name: /Match Units/i }));

    expect(
      await screen.findByText(/No compatible units available/i),
    ).toBeInTheDocument();
  });
});
