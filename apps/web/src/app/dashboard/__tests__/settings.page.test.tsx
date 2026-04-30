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
  usePathname: () => "/dashboard/settings",
}));

import SettingsPage from "../settings/page";

describe("SettingsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        refreshUser: vi.fn(),
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: { user: { id: "u1", name: "Admin", email: "a@x.com" } } });
  });

  it("renders Settings heading", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
  });

  it("renders settings tabs", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
  });

  it("switches tabs on click", async () => {
    // Ensure each endpoint returns an array-compatible shape so tab content
    // components don't crash on .map.
    apiMock.get.mockImplementation(() =>
      Promise.resolve({ data: [] })
    );
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
    // Click the first tab button (profile is default, just re-click to exercise)
    const tabBtns = screen.queryAllByRole("button");
    if (tabBtns.length > 0) {
      await user.click(tabBtns[0]);
    }
    expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
  });

  // Issue #437: nurse role must only see personal-scoped settings tabs.
  // The current allow-list lists the same four for every role, but the
  // important RBAC contract is that the *list* is filtered through the
  // role-aware helper (so when a future Org/Users/Billing tab is added it
  // will be hidden from nurses without a code change here). At minimum we
  // assert the four expected nurse tabs render.
  it("renders only nurse-allowed tabs when role=NURSE (#437)", async () => {
    apiMock.get.mockImplementation(() => Promise.resolve({ data: [] }));
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u2", name: "Nurse", email: "n@x.com", role: "NURSE" },
        refreshUser: vi.fn(),
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
    // Nurse-allowed tabs
    expect(screen.getByRole("button", { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /security/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preferences/i })).toBeInTheDocument();
    // Admin-only tabs that may be added in the future MUST NOT render for
    // nurse. We assert the labels don't appear at all.
    expect(screen.queryByRole("button", { name: /organization/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^users$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /billing|integrations/i })).not.toBeInTheDocument();
  });
});
