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
  EntityPicker: ({ onChange }: { onChange: (id: string) => void }) => (
    <button type="button" data-testid="pick-patient" onClick={() => onChange("p-1")}>
      pick
    </button>
  ),
}));

import PmjayConsolePage from "../page";

const STATS = {
  beneficiaries: { eligible: 3, pendingVerification: 1 },
  claims: { submitted: 2, inReview: 1, approved: 1, denied: 0, settled: 4 },
  admissions: 5,
  amounts: { totalClaimed: 100000, totalApproved: 80000, settlementAmount: 60000 },
  packages: { active: 4, lastSyncedAt: "2026-07-13T10:00:00Z", version: "v-abcd1234" },
  ops: { documentUploadsPending: 0, documentUploadsFailed: 0 },
};
const PKGS = [
  { id: "pk-1", packageCode: "HBP-CARD-001", packageName: "Angioplasty", specialty: "Cardiology", amount: 60000, hospitalType: "PRIVATE" },
];

function wireGet() {
  apiMock.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/pmjay/stats")) return { data: STATS };
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
      data: { eligibilityStatus: "ELIGIBLE", beneficiaryId: "BEN123", familyId: "FAM123", eligible: true },
    });
    render(<PmjayConsolePage />);
    fireEvent.click(await screen.findByTestId("pick-patient"));
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
});
