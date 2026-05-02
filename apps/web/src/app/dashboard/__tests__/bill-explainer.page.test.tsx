/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/bill-explainer",
}));

import BillExplainerPage from "../bill-explainer/page";

const sampleItem = {
  id: "be-1",
  invoiceId: "inv-1234567890",
  patientId: "pat-1234567890",
  language: "en",
  content: "This bill covers your consultation and lab tests.",
  status: "DRAFT",
  flaggedItems: [],
  approvedBy: null,
  approvedAt: null,
  sentAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("BillExplainerPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        token: "tok-1",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("smoke renders the page heading", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<BillExplainerPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /bill.*insurance explainer/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the all-caught-up empty state when no items pending", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<BillExplainerPage />);
    await waitFor(() =>
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument()
    );
  });

  it("renders a populated explanation card", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleItem] });
    render(<BillExplainerPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/this bill covers your consultation/i)
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/draft/i)).toBeInTheDocument();
  });

  it("toasts an error when the load endpoint rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("503 outage"));
    render(<BillExplainerPage />);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/503 outage|failed to load/i)
      )
    );
  });

  it("calls the bill-explainer pending endpoint on mount", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<BillExplainerPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/ai/bill-explainer/pending"))).toBe(
        true
      );
    });
  });
});
