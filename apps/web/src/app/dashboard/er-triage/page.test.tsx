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
  usePathname: () => "/dashboard/er-triage",
}));

import ERTriagePage from "./page";

const assessment = {
  suggestedTriageLevel: 2,
  triageLevelLabel: "Emergent",
  disposition: "ER bay",
  immediateActions: ["ECG within 10 minutes"],
  suggestedInvestigations: ["ECG", "Troponin"],
  redFlags: ["Radiating chest pain"],
  calculatedMEWS: 4,
  aiReasoning: "Acute cardiac presentation suspected.",
  disclaimer: "For clinical decision support only.",
};

describe("ERTriagePage", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", role: "DOCTOR" },
        token: "tok",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the ER Triage header and form", () => {
    render(<ERTriagePage />);
    expect(
      screen.getByRole("heading", { name: /er triage assistant/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/chief complaint/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /assess patient/i })).toBeInTheDocument();
  });

  it("shows a toast error when the chief complaint is empty on submit", async () => {
    // Button should be disabled when empty, but direct click attempt is guarded by handler
    const user = userEvent.setup();
    render(<ERTriagePage />);
    const btn = screen.getByRole("button", { name: /assess patient/i });
    // Disabled — should not call api
    await user.click(btn);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("calls the assess endpoint and renders the assessment card on success", async () => {
    apiMock.post.mockResolvedValue({ success: true, data: assessment });
    const user = userEvent.setup();
    render(<ERTriagePage />);
    await user.type(
      screen.getByPlaceholderText(/sudden onset chest pain/i),
      "Chest pain radiating to arm"
    );
    await user.click(screen.getByRole("button", { name: /assess patient/i }));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/er-triage/assess",
        expect.objectContaining({ chiefComplaint: "Chest pain radiating to arm" }),
        expect.any(Object)
      );
      expect(screen.getByText("Emergent")).toBeInTheDocument();
      expect(screen.getByText(/er bay/i)).toBeInTheDocument();
    });
  });

  it("shows a loading spinner label while assessing", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.post.mockImplementation(
      () => new Promise((res) => (resolveFn = res))
    );
    const user = userEvent.setup();
    render(<ERTriagePage />);
    await user.type(
      screen.getByPlaceholderText(/sudden onset chest pain/i),
      "Dyspnea"
    );
    await user.click(screen.getByRole("button", { name: /assess patient/i }));
    expect(await screen.findByText(/assessing/i)).toBeInTheDocument();
    resolveFn({ success: true, data: assessment });
  });

  it("surfaces an error toast when the API rejects", async () => {
    apiMock.post.mockRejectedValue(new Error("Backend error"));
    const user = userEvent.setup();
    render(<ERTriagePage />);
    await user.type(
      screen.getByPlaceholderText(/sudden onset chest pain/i),
      "Dyspnea"
    );
    await user.click(screen.getByRole("button", { name: /assess patient/i }));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("Backend error"))
    );
    // No assessment result rendered
    expect(screen.queryByText(/esi level/i)).not.toBeInTheDocument();
  });

  it("does not render any results card in the initial empty state", () => {
    render(<ERTriagePage />);
    expect(screen.queryByText(/esi level/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/immediate actions/i)).not.toBeInTheDocument();
  });
});
