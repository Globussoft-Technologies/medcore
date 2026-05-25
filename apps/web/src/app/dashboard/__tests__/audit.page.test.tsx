/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastErrorMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: { error: toastErrorMock, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/audit",
}));

import AuditPage from "../audit/page";

describe("AuditPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    toastErrorMock.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders heading for ADMIN with empty data", async () => {
    apiMock.get.mockResolvedValue({ data: [], meta: { totalPages: 1 } });
    render(<AuditPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /audit log/i })).toBeInTheDocument()
    );
  });

  it("denies access for non-ADMIN", async () => {
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u2", name: "Rec", email: "r@x.com", role: "RECEPTION" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [], meta: { totalPages: 1 } });
    render(<AuditPage />);
    await waitFor(() =>
      expect(screen.getByText(/access denied/i)).toBeInTheDocument()
    );
  });

  it("renders populated entries", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/audit/filters"))
        return Promise.resolve({
          data: { actions: ["AUTH_LOGIN"], entityTypes: ["USER"], users: [] },
        });
      if (url.startsWith("/audit/retention"))
        return Promise.reject(new Error("no stats"));
      if (url.startsWith("/audit"))
        return Promise.resolve({
          data: [
            {
              id: "a1",
              action: "AUTH_LOGIN",
              entityType: "USER",
              entityId: "u1",
              createdAt: new Date().toISOString(),
              userId: "u1",
              ipAddress: "1.2.3.4",
              user: { name: "Admin", email: "a@x.com" },
              details: null,
            },
          ],
          meta: { totalPages: 1 },
        });
      return Promise.resolve({ data: [] });
    });
    render(<AuditPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/LOGIN/).length).toBeGreaterThan(0)
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<AuditPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /audit log/i })).toBeInTheDocument()
    );
  });

  // Issue #290: inverted "From > To" must surface a toast and NOT fire the
  // audit-list request. Previously the API accepted the inverted range and
  // returned zero rows, silently hiding the user's mistake.
  it("rejects an inverted From > To range with a toast and no audit-list fetch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/audit/filters"))
        return Promise.resolve({ data: { actions: [], entityTypes: [], users: [] } });
      if (url.startsWith("/audit/retention"))
        return Promise.reject(new Error("no stats"));
      return Promise.resolve({ data: [], meta: { totalPages: 1 } });
    });
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /audit log/i })).toBeInTheDocument()
    );
    // Type both date inputs — each onChange re-runs the loadEntries effect
    // (deps now include fromDate/toDate), which fires intermediate requests
    // we don't care about. Clear AFTER both inputs are set, then click Apply
    // Filters and assert the guard prevents the post-click fetch.
    const fromInput = document.getElementById("audit-filter-from") as HTMLInputElement;
    const toInput = document.getElementById("audit-filter-to") as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2026-05-01" } });
    fireEvent.change(toInput, { target: { value: "2026-04-01" } });
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(0)
    );
    apiMock.get.mockClear();
    toastErrorMock.mockClear();
    await user.click(screen.getByRole("button", { name: /apply filters/i }));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/must be on or before/i))
    );
    const auditFetchCalls = apiMock.get.mock.calls.filter((c) =>
      String(c[0]).startsWith("/audit") &&
      !String(c[0]).startsWith("/audit/filters") &&
      !String(c[0]).startsWith("/audit/retention")
    );
    expect(auditFetchCalls).toHaveLength(0);
  });

  it("clicking Export CSV button does not crash", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/audit/filters"))
        return Promise.resolve({
          data: { actions: [], entityTypes: [], users: [] },
        });
      if (url.startsWith("/audit/retention"))
        return Promise.reject(new Error("no stats"));
      return Promise.resolve({ data: [], meta: { totalPages: 1 } });
    });
    // String body, not `new Blob([])`: jsdom's Blob shim has no `stream()`,
    // and Node 20's undici calls Blob.stream() inside `new Response(blob)`.
    (globalThis as any).fetch = vi.fn(async () => new Response("", { status: 200 }));
    const user = userEvent.setup();
    render(<AuditPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /export csv/i })
    );
    await user.click(screen.getByRole("button", { name: /export csv/i }));
    expect(
      screen.getByRole("heading", { name: /audit log/i })
    ).toBeInTheDocument();
  });
});
