/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for the super-admin route group scaffold (gap #6 piece 1 of 4).
//
// Covers:
//   - Landing page renders for an ADMIN with tenantId === null (the super-admin pattern).
//   - Landing page is NOT rendered for an ADMIN with a tenantId set (tenant operator).
//   - Landing page is NOT rendered for a non-ADMIN role (DOCTOR / RECEPTION / etc.).
//   - The Pearl-Billing placeholder is disabled.
//   - The Tenants tile links to the (piece 2) /super-admin/tenants path.
//   - The layout does NOT mount the dashboard sidebar — the super-admin surface
//     is intentionally bare so operators visually distinguish it from the
//     in-band /dashboard surface.
//
// Mock contract mirrors apps/web/src/app/dashboard/__tests__/tenants.page.test.tsx:
//   - useAuthStore mocked as a callable selector function.
//   - next/navigation mocked with routerReplace as the assertion target (the
//     layout uses router.replace for the gate, NOT router.push).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { authMock, routerReplace, routerPush, toastMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/super-admin",
}));

import SuperAdminLandingPage from "../page";
import SuperAdminLayout from "../layout";

function mockAuth(state: {
  user: { id: string; name: string; email: string; role: string; tenantId?: string | null } | null;
  isLoading?: boolean;
}) {
  const full = {
    user: state.user,
    isLoading: state.isLoading ?? false,
    loadSession: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  // Layout calls `useAuthStore()` (no selector) — return the whole state.
  // Tenants test pattern shows selectors are also fine to support.
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector(full) : full,
  );
}

describe("Super-admin route group — gap #6 piece 1 of 4", () => {
  beforeEach(() => {
    authMock.mockReset();
    routerReplace.mockReset();
    routerPush.mockReset();
    toastMock.error.mockReset();
  });

  it("renders the landing page for an ADMIN with tenantId === null (super-admin)", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <SuperAdminLandingPage />
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    expect(screen.getByTestId("super-admin-landing")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /super-admin console/i }),
    ).toBeInTheDocument();
    // No redirect for the happy path.
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("renders the dark super-admin topbar (no dashboard sidebar) for a super-admin", async () => {
    mockAuth({
      user: {
        id: "u1",
        name: "Pearl Ops",
        email: "ops@pearl-erp.in",
        role: "ADMIN",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <SuperAdminLandingPage />
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("super-admin-shell")).toBeInTheDocument();
    });
    // The dashboard layout mounts an <aside aria-label="Primary navigation">
    // — the super-admin surface must NOT mount it. We assert on the dashboard
    // sidebar's aria-label rather than a testid (the dashboard sidebar does
    // not carry a data-testid="dashboard-sidebar" attribute today).
    expect(
      screen.queryByRole("complementary", { name: /primary navigation/i }),
    ).not.toBeInTheDocument();
    // And the super-admin's own topbar IS mounted.
    expect(screen.getByTestId("super-admin-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("super-admin-brand")).toHaveAttribute(
      "href",
      "/super-admin",
    );
  });

  it("redirects an ADMIN WITH a tenantId set (tenant operator, not super-admin) to /dashboard/not-authorized", async () => {
    mockAuth({
      user: {
        id: "u2",
        name: "St. Johns Admin",
        email: "admin@stjohns.local",
        role: "ADMIN",
        tenantId: "tenant-stjohns",
      },
    });
    render(
      <SuperAdminLayout>
        <SuperAdminLandingPage />
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
    // Landing surface must NOT render for a forbidden role.
    expect(screen.queryByTestId("super-admin-landing")).not.toBeInTheDocument();
  });

  it("redirects a non-ADMIN role (e.g. DOCTOR) to /dashboard/not-authorized", async () => {
    mockAuth({
      user: {
        id: "u3",
        name: "Dr. Default",
        email: "doc@stjohns.local",
        role: "DOCTOR",
        tenantId: null,
      },
    });
    render(
      <SuperAdminLayout>
        <SuperAdminLandingPage />
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
    expect(screen.queryByTestId("super-admin-landing")).not.toBeInTheDocument();
  });

  it("redirects an unauthenticated visitor (user=null) to /login with redirect param", async () => {
    mockAuth({ user: null });
    render(
      <SuperAdminLayout>
        <SuperAdminLandingPage />
      </SuperAdminLayout>,
    );
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/login?redirect="),
      );
    });
    expect(screen.queryByTestId("super-admin-landing")).not.toBeInTheDocument();
  });

  it("renders the Pearl Billing tile as disabled with the post-piece-3 tooltip", () => {
    render(<SuperAdminLandingPage />);
    const billing = screen.getByTestId("super-admin-tile-pearl-billing");
    expect(billing).toBeInTheDocument();
    expect(billing).toBeDisabled();
    expect(billing).toHaveAttribute("title", "Pearl Billing ships in piece 3");
    expect(billing).toHaveAttribute("aria-disabled", "true");
  });

  it("renders the Tenants tile linking to /super-admin/tenants (piece 2 target)", () => {
    render(<SuperAdminLandingPage />);
    const tenants = screen.getByTestId("super-admin-tile-tenants");
    expect(tenants).toBeInTheDocument();
    expect(tenants).toHaveAttribute("href", "/super-admin/tenants");
  });
});
