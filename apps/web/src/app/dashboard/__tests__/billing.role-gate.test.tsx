/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Issue #501 regression — when a non-billing role (e.g. NURSE) navigates
// directly to /dashboard/billing, the page must redirect to the
// chrome-wrapped /dashboard/not-authorized page so the user sees a
// persistent "Access Denied" banner. The previous behaviour was a
// silent `router.replace("/dashboard")` that left the user on the home
// dashboard with no clear signal that the URL had been blocked.
//
// What we cover here:
//   - apps/web/src/app/dashboard/billing/page.tsx — the role-gate effect
//     that fires for users not in BILLING_ALLOWED.
//
// Why the existing billing.page.test.tsx isn't extended in place:
//   That suite mocks `useRouter` with fresh vi.fn() per call, so we
//   cannot assert on the captured `replace` arg without reshaping the
//   shared mock. A focused file using a hoisted replaceMock keeps the
//   regression tightly scoped and easier to read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock, replaceMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  replaceMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/billing",
}));

import BillingPage from "../billing/page";

describe("BillingPage — role gate (#501)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
    toastMock.error.mockReset();
    replaceMock.mockReset();
  });

  it("NURSE is redirected to /dashboard/not-authorized?from=/dashboard/billing", async () => {
    authMock.mockReturnValue({
      user: { id: "n1", name: "Nurse Naveen", email: "n@x.com", role: "NURSE" },
      isLoading: false,
    });
    render(<BillingPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    const target = String(replaceMock.mock.calls[0][0]);
    // Bug repro: target used to be "/dashboard" with no banner, no
    // ?from. After the fix it MUST be the chrome-wrapped 403 page so
    // the user sees an "Access Denied" message they cannot miss.
    expect(target).toContain("/dashboard/not-authorized");
    expect(target).toContain("from=");
    expect(target).toContain(encodeURIComponent("/dashboard/billing"));
    // Bug repro: the silent redirect to /dashboard would leave NO query
    // params at all, so a guard against the regression is to assert the
    // target is NOT the bare home dashboard.
    expect(target).not.toBe("/dashboard");
  });

  it("DOCTOR is also redirected to the not-authorized page", async () => {
    authMock.mockReturnValue({
      user: { id: "d1", name: "Doctor", email: "d@x.com", role: "DOCTOR" },
      isLoading: false,
    });
    render(<BillingPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
    const target = String(replaceMock.mock.calls[0][0]);
    expect(target).toContain("/dashboard/not-authorized");
  });

  it("toast still fires alongside the redirect for fast-nav users", async () => {
    authMock.mockReturnValue({
      user: { id: "n1", name: "Nurse", email: "n@x.com", role: "NURSE" },
      isLoading: false,
    });
    render(<BillingPage />);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(String(toastMock.error.mock.calls[0][0])).toMatch(
      /restricted to/i
    );
  });

  it("ADMIN is NOT redirected (sanity check)", async () => {
    authMock.mockReturnValue({
      user: { id: "a1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    });
    render(<BillingPage />);
    // Wait for any effects to settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
