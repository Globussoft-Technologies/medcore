/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PmjayConsolePage — adjacent-to-source coverage.
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/pmjay/page.tsx (ADMIN/RECEPTION
 *     PM-JAY console). Endpoints: GET /pmjay/stats, GET /pmjay/packages,
 *     POST /pmjay/verify, POST /pmjay/packages/sync, GET /pmjay/family/:id.
 *   - Behaviours: RBAC redirect for a disallowed role; ADMIN renders + fetches
 *     stats/packages on mount; beneficiary verify posts and shows the
 *     eligibility badge; the Sync button is ADMIN-only and posts.
 *   - Mocks: @/lib/api, @/lib/toast, @/lib/store, @/lib/currency,
 *     next/navigation, @/components/Skeleton, @/components/EntityPicker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/currency", () => ({ formatINR: (n: number) => `Rs ${n}` }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/dashboard/pmjay",
}));
vi.mock("@/components/Skeleton", () => ({ SkeletonTable: () => <div data-testid="skeleton-stub" /> }));
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ onChange, testIdPrefix }: { onChange: (id: string) => void; testIdPrefix?: string }) => (
    <button type="button" data-testid={`${testIdPrefix ?? "picker"}-pick`} onClick={() => onChange("p-1")}>
      pick
    </button>
  ),
}));

import PmjayConsolePage from "../page";

const STATS = {
  beneficiaries: { eligible: 3, pendingVerification: 1 },
  preAuth: { pending: 2, approved: 1 },
  claims: { submitted: 2, inReview: 1, approved: 1, denied: 0, settled: 4 },
  admissions: 5,
  amounts: { totalClaimed: 100000, totalApproved: 80000, settlementAmount: 60000 },
  packages: { active: 4, lastSyncedAt: "2026-07-13T10:00:00Z", version: "v-abcd1234" },
  ops: { documentUploadsPending: 0, documentUploadsFailed: 0 },
};
const PKGS = [
  { id: "pk-1", packageCode: "HBP-CARD-001", packageName: "Angioplasty", specialty: "Cardiology", amount: 60000, hospitalType: "PRIVATE" },
];
const PREAUTHS = [
  {
    id: "pa-1",
    requestNumber: "PA-9001",
    procedureName: "Angioplasty",
    packageCode: "HBP-CARD-001",
    estimatedCost: 60000,
    status: "PENDING",
    approvedAmount: null,
    approvalNumber: null,
    submittedAt: "2026-07-13T09:00:00Z",
    patient: { user: { name: "Rajesh Kumar" } },
  },
];

function wireGet() {
  apiMock.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/pmjay/stats")) return { data: STATS };
    if (url.startsWith("/pmjay/beneficiary")) return { data: { ayushmanCardNumber: "PMJAY-C1", beneficiaryId: "BEN1" } };
    if (url.startsWith("/pmjay/preauth")) return { data: PREAUTHS };
    if (url.startsWith("/pmjay/packages")) return { data: PKGS };
    if (url.startsWith("/pmjay/family")) return { data: [{ beneficiaryId: "B1", name: "Head", ayushmanCardNumber: "C1", familyId: "F1" }] };
    return { data: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue({ user: { role: "ADMIN" }, isLoading: false });
  wireGet();
});
afterEach(() => cleanup());

describe("PmjayConsolePage", () => {
  it("redirects a disallowed role to not-authorized", async () => {
    authMock.mockReturnValue({ user: { role: "DOCTOR" }, isLoading: false });
    render(<PmjayConsolePage />);
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith(expect.stringContaining("/dashboard/not-authorized"));
    });
  });

  it("renders for ADMIN and fetches stats + packages on mount", async () => {
    render(<PmjayConsolePage />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/pmjay/stats");
    });
    expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/pmjay/packages"));
    expect(await screen.findByText("HBP-CARD-001")).toBeInTheDocument();
  });

  it("verifies a beneficiary and shows the ELIGIBLE badge", async () => {
    apiMock.post.mockResolvedValue({
      data: {
        eligibilityStatus: "ELIGIBLE",
        beneficiaryId: "BEN123",
        familyId: "FAM123",
        name: "Rajesh Kumar",
        ayushmanCardNumber: "PMJAY-CARD-1",
        verifiedAt: "2026-07-13T12:00:00Z",
        eligible: true,
      },
    });
    render(<PmjayConsolePage />);
    fireEvent.click(await screen.findByTestId("pmjay-patient-picker-pick"));
    fireEvent.change(screen.getByTestId("pmjay-card-input"), { target: { value: "PMJAY-CARD-1" } });
    fireEvent.click(screen.getByTestId("pmjay-verify-btn"));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/pmjay/verify", { patientId: "p-1", ayushmanCardNumber: "PMJAY-CARD-1" });
    });
    expect(await screen.findByText("ELIGIBLE")).toBeInTheDocument();
  });

  it("shows the ADMIN-only Sync button and posts a sync", async () => {
    apiMock.post.mockResolvedValue({ data: { synced: 4, skipped: false } });
    render(<PmjayConsolePage />);
    const btn = await screen.findByTestId("pmjay-sync-btn");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/pmjay/packages/sync", {});
    });
  });

  it("hides the Sync button for RECEPTION", async () => {
    authMock.mockReturnValue({ user: { role: "RECEPTION" }, isLoading: false });
    render(<PmjayConsolePage />);
    await screen.findByText("HBP-CARD-001");
    expect(screen.queryByTestId("pmjay-sync-btn")).not.toBeInTheDocument();
  });

  it("renders the PM-JAY pre-authorisation queue on mount", async () => {
    render(<PmjayConsolePage />);
    expect(await screen.findByText("PA-9001")).toBeInTheDocument();
    expect(screen.getByText("Rajesh Kumar")).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/pmjay/preauth?status=PENDING"));
  });

  it("refetches pre-auths when a tab is clicked", async () => {
    render(<PmjayConsolePage />);
    await screen.findByText("PA-9001");
    fireEvent.click(screen.getByTestId("pmjay-preauth-tab-APPROVED"));
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(expect.stringContaining("/pmjay/preauth?status=APPROVED"));
    });
  });

  it("creates a PM-JAY pre-authorisation from the queue modal", async () => {
    apiMock.post.mockResolvedValue({ data: { id: "pa-new" } });
    render(<PmjayConsolePage />);
    fireEvent.click(await screen.findByTestId("pmjay-new-preauth-btn"));
    // Pick the patient inside the modal → beneficiary auto-loads (eligible).
    fireEvent.click(await screen.findByTestId("preauth-patient-picker-pick"));
    expect(await screen.findByTestId("preauth-ben")).toBeInTheDocument();
    // Choose a package (auto-fills estimated cost).
    fireEvent.change(screen.getByTestId("preauth-package-select"), { target: { value: "HBP-CARD-001" } });
    fireEvent.click(screen.getByTestId("preauth-submit"));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/preauth",
        expect.objectContaining({
          patientId: "p-1",
          insuranceProvider: "PM-JAY (Ayushman Bharat)",
          policyNumber: "PMJAY-C1",
          packageCode: "HBP-CARD-001",
          estimatedCost: 60000,
        })
      );
    });
  });

  it("searches by a chosen identifier and 'Use card' fills the card field", async () => {
    apiMock.post.mockResolvedValue({
      data: [{ beneficiaryId: "BEN9", name: "Sita Devi", ayushmanCardNumber: "PMJAY-FOUND-9", familyId: "FAM9" }],
    });
    render(<PmjayConsolePage />);
    fireEvent.change(screen.getByTestId("pmjay-search-type"), { target: { value: "mobile" } });
    fireEvent.change(screen.getByTestId("pmjay-search-value"), { target: { value: "9876543210" } });
    fireEvent.click(screen.getByTestId("pmjay-search-btn"));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/pmjay/search-beneficiary", { mobile: "9876543210" });
    });
    fireEvent.click(await screen.findByTestId("pmjay-use-candidate"));
    expect((screen.getByTestId("pmjay-card-input") as HTMLInputElement).value).toBe("PMJAY-FOUND-9");
  });
});
