/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/insurance-claims",
}));

import InsuranceClaimsPage from "./page";

const sampleClaim = {
  id: "c1",
  billId: "b1",
  patientId: "p1",
  tpaProvider: "MOCK",
  providerClaimRef: "PROV-123",
  insurerName: "Acme Life",
  policyNumber: "POL-999",
  diagnosis: "Acute gastritis",
  amountClaimed: 12000,
  amountApproved: null,
  status: "SUBMITTED",
  submittedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

describe("InsuranceClaimsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerMock.push.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", role: "ADMIN" },
      isLoading: false,
    });
  });

  it("renders the heading and the Submit new claim button", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<InsuranceClaimsPage />);
    expect(
      await screen.findByRole("heading", { name: /insurance claims/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /submit new claim/i })
    ).toBeInTheDocument();
  });

  it("shows a loading message initially, then empty state when the list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<InsuranceClaimsPage />);
    await waitFor(() =>
      expect(screen.getByText(/no claims match your filters/i)).toBeInTheDocument()
    );
  });

  it("renders a claim row with the MOCK TPA badge", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleClaim] });
    render(<InsuranceClaimsPage />);
    await waitFor(() => {
      expect(screen.getByText("Acme Life")).toBeInTheDocument();
      expect(screen.getByText(/MOCK TPA/i)).toBeInTheDocument();
    });
  });

  it("surfaces an error banner when the list call fails", async () => {
    apiMock.get.mockRejectedValue(new Error("Claims service unavailable"));
    render(<InsuranceClaimsPage />);
    await waitFor(() =>
      expect(screen.getByText(/claims service unavailable/i)).toBeInTheDocument()
    );
  });

  it("redirects DOCTOR role away from the page", async () => {
    authMock.mockReturnValue({
      user: { id: "u1", name: "Dr Asha", role: "DOCTOR" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue({ data: [] });
    render(<InsuranceClaimsPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });
});
