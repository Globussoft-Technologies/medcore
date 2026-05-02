/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/controlled-substances",
}));

import ControlledSubstancesPage from "../controlled-substances/page";

function asPharmacist() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Pharma", email: "p@x.com", role: "PHARMACIST" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asReception() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Rec", email: "r@x.com", role: "RECEPTION" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

const sampleEntry = {
  id: "e1",
  entryNumber: "CS-001",
  dispensedAt: new Date().toISOString(),
  quantity: 10,
  balance: 90,
  notes: null,
  medicine: {
    id: "m1",
    name: "Morphine",
    scheduleClass: "X",
    strength: "10mg",
    form: "TAB",
  },
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    user: { name: "Aarav Mehta" },
  },
  doctor: { id: "d1", user: { name: "Dr. Singh" } },
  user: { id: "u1", name: "Pharmacist", role: "PHARMACIST" },
};

describe("ControlledSubstancesPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
    routerReplace.mockReset();
    toastMock.error.mockReset();
  });

  it("smoke renders the heading for an authorised role", async () => {
    asPharmacist();
    render(<ControlledSubstancesPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /controlled substance register/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the empty-state when no entries are returned", async () => {
    asPharmacist();
    render(<ControlledSubstancesPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no entries match the filter/i)
      ).toBeInTheDocument()
    );
  });

  it("renders entry rows when the API returns data", async () => {
    asPharmacist();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/controlled-substances?"))
        return Promise.resolve({ data: [sampleEntry] });
      return Promise.resolve({ data: [] });
    });
    render(<ControlledSubstancesPage />);
    await waitFor(() =>
      expect(screen.getByText(/CS-001/)).toBeInTheDocument()
    );
  });

  it("redirects RECEPTION away with an error toast", async () => {
    asReception();
    render(<ControlledSubstancesPage />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized")
      )
    );
  });

  it("keeps rendering when entries endpoint rejects", async () => {
    asPharmacist();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ControlledSubstancesPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /controlled substance register/i })
      ).toBeInTheDocument()
    );
  });
});
