/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/users",
}));

import UsersPage from "../users/page";

const staff = [
  {
    id: "s1",
    name: "Alice Admin",
    email: "alice@x.com",
    phone: "9000000001",
    role: "ADMIN",
    isActive: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: "s2",
    name: "Dr. Bob",
    email: "bob@x.com",
    phone: "9000000002",
    role: "DOCTOR",
    isActive: true,
    createdAt: new Date().toISOString(),
  },
  {
    id: "s3",
    name: "Nurse Nila",
    email: "nila@x.com",
    phone: "9000000003",
    role: "NURSE",
    isActive: false,
    createdAt: new Date().toISOString(),
  },
];

describe("UsersPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    });
    apiMock.get.mockResolvedValue({ data: [] });
    document.documentElement.classList.remove("dark");
  });

  it("renders User Management heading on empty data", async () => {
    render(<UsersPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /user management/i })
      ).toBeInTheDocument()
    );
  });

  it("shows the empty state when no users exist", async () => {
    render(<UsersPage />);
    await waitFor(() =>
      expect(screen.getByText(/no users found/i)).toBeInTheDocument()
    );
  });

  it("renders populated staff table with roles", async () => {
    apiMock.get.mockResolvedValue({ data: staff });
    render(<UsersPage />);
    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
      expect(screen.getByText("Dr. Bob")).toBeInTheDocument();
      expect(screen.getByText("Nurse Nila")).toBeInTheDocument();
    });
    // Role badges present
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
    expect(screen.getByText("NURSE")).toBeInTheDocument();
  });

  it("redirects non-admin users back to dashboard", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
    });
    render(<UsersPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("opens the Add Staff form when the button is clicked", async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() => screen.getByRole("button", { name: /add staff user/i }));
    await user.click(screen.getByRole("button", { name: /add staff user/i }));
    expect(
      screen.getByRole("heading", { name: /create staff account/i })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/full name/i)).toBeInTheDocument();
  });

  it("super-admin must pick a tenant before creating staff (tenant gating)", async () => {
    const tenants = [
      { id: "t1", name: "Active Hospital", subdomain: "active", active: true },
      { id: "t2", name: "Suspended Hospital", subdomain: "susp", active: false },
    ];
    authMock.mockReturnValue({
      user: {
        id: "sa",
        name: "Super",
        email: "s@x.com",
        role: "SUPER_ADMIN",
        tenantId: null,
      },
    });
    apiMock.get.mockImplementation((url: string) =>
      url.startsWith("/tenants")
        ? Promise.resolve({ data: tenants })
        : Promise.resolve({ data: [] }),
    );
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /add staff user/i }),
    );
    await user.click(screen.getByRole("button", { name: /add staff user/i }));

    // Super-admin sees the Tenant picker in the create form.
    expect(screen.getByTestId("label-staff-tenant")).toBeInTheDocument();

    // Fill the required fields but leave the tenant unset.
    await user.type(screen.getByTestId("staff-name-input"), "New Staff");
    await user.type(screen.getByTestId("staff-email-input"), "newstaff@x.com");
    await user.type(screen.getByTestId("staff-phone-input"), "9876500000");
    await user.type(
      screen.getByTestId("staff-password-input"),
      "MedCoreT3st-2026",
    );
    await user.click(screen.getByRole("button", { name: /create user/i }));

    // Validation blocks the request and surfaces the tenant error; no POST.
    await waitFor(() =>
      expect(screen.getByTestId("error-staff-tenant")).toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("super-admin: cancel resets and closes the create form", async () => {
    authMock.mockReturnValue({
      user: {
        id: "sa",
        name: "Super",
        email: "s@x.com",
        role: "SUPER_ADMIN",
        tenantId: null,
      },
    });
    apiMock.get.mockImplementation((url: string) =>
      url.startsWith("/tenants")
        ? Promise.resolve({
            data: [
              { id: "t1", name: "Active Hospital", subdomain: "active", active: true },
            ],
          })
        : Promise.resolve({ data: [] }),
    );
    const user = userEvent.setup();
    render(<UsersPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /add staff user/i }),
    );
    await user.click(screen.getByRole("button", { name: /add staff user/i }));
    expect(
      screen.getByRole("heading", { name: /create staff account/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /create staff account/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows loading placeholder while fetching", async () => {
    let resolveFn: (v: any) => void = () => {};
    apiMock.get.mockImplementation(
      () =>
        new Promise((r) => {
          resolveFn = r;
        })
    );
    render(<UsersPage />);
    const loader = await screen.findByTestId("users-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
    resolveFn({ data: [] });
  });
});
