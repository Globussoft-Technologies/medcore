/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  usePathname: () => "/dashboard/lab-explainer",
}));

import LabExplainerPage from "./page";

const pendingItem = {
  id: "exp1",
  labOrderId: "order12345678",
  patientId: "patient12345678",
  explanation: "Your hemoglobin is slightly low but manageable. Eat iron-rich foods.",
  flaggedValues: [
    { parameter: "Hb", value: "10 g/dL", flag: "LOW", plainLanguage: "Slightly low" },
    { parameter: "WBC", value: "7500", flag: "NORMAL", plainLanguage: "Normal" },
  ],
  language: "en",
  status: "PENDING_REVIEW",
  approvedBy: null,
  approvedAt: null,
  sentAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("LabExplainerPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", role: "DOCTOR" },
        token: "tok",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the page heading and refresh button", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    render(<LabExplainerPage />);
    expect(
      await screen.findByRole("heading", { name: /ai lab report explainer/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("shows a loading indicator while fetching pending explanations", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => (resolveFn = r)));
    render(<LabExplainerPage />);
    expect(await screen.findByText(/loading pending explanations/i)).toBeInTheDocument();
    resolveFn({ success: true, data: [] });
  });

  it("shows the empty state when no explanations are pending", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [] });
    render(<LabExplainerPage />);
    await waitFor(() =>
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument()
    );
  });

  it("renders a pending explanation card with the Approve button", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [pendingItem] });
    render(<LabExplainerPage />);
    await waitFor(() => {
      expect(screen.getByText(/slightly low but manageable/i)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /approve.*send to patient/i })
      ).toBeInTheDocument();
    });
  });

  it("calls the approve endpoint and removes the item on success", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: [pendingItem] });
    apiMock.patch.mockResolvedValue({ success: true, data: { ...pendingItem, status: "SENT" } });
    const user = userEvent.setup();
    render(<LabExplainerPage />);
    await waitFor(() => screen.getByText(/slightly low but manageable/i));
    await user.click(screen.getByRole("button", { name: /approve.*send to patient/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        `/ai/reports/${pendingItem.id}/approve`,
        {},
        expect.any(Object)
      );
      expect(toastMock.success).toHaveBeenCalled();
    });
    // Item disappears since it was the only pending one
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });

  it("surfaces a toast error when fetching the list fails", async () => {
    apiMock.get.mockRejectedValue(new Error("Network error"));
    render(<LabExplainerPage />);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Network error"));
  });
});
