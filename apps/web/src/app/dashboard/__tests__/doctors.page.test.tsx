/* eslint-disable @typescript-eslint/no-explicit-any */
// Issue #168 (Apr 30 2026): the admin Doctors page was rebuilt with a
// search input, specialization filter, and a "+ Add Doctor" modal flow.
// This test file locks in the new shape so future refactors can't quietly
// regress the admin UX.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/doctors",
}));

import DoctorsPage from "../doctors/page";

const sampleDoctors = [
  {
    id: "d1",
    specialization: "Cardiology",
    qualification: "MBBS, MD",
    user: {
      id: "u1",
      name: "Dr. Asha Mehta",
      email: "asha@x.com",
      phone: "9000000001",
      isActive: true,
    },
    schedules: [],
  },
  {
    id: "d2",
    specialization: "Pediatrics",
    qualification: "MBBS, DCH",
    user: {
      id: "u2",
      name: "Dr. Bina Shah",
      email: "bina@x.com",
      phone: "9000000002",
      isActive: true,
    },
    schedules: [
      {
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "13:00",
        slotDurationMinutes: 15,
      },
    ],
  },
  {
    id: "d3",
    specialization: "Cardiology",
    qualification: "MBBS, DM",
    user: {
      id: "u3",
      name: "Dr. Chandra Rao",
      email: "chandra@x.com",
      phone: "9000000003",
      isActive: false,
    },
    schedules: [],
  },
];

describe("DoctorsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    routerReplace.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockReturnValue({
      user: { id: "admin", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue({ data: sampleDoctors });
    document.documentElement.classList.remove("dark");
  });

  it("renders heading and the populated doctor list", async () => {
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^doctors$/i })
      ).toBeInTheDocument()
    );
    await waitFor(() => {
      expect(screen.getAllByText("Dr. Asha Mehta").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Dr. Bina Shah").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Dr. Chandra Rao").length).toBeGreaterThan(0);
    });
  });

  it("exposes the required data-testid hooks (search, add, row)", async () => {
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-search-input")).toBeInTheDocument()
    );
    expect(screen.getByTestId("doctor-add-button")).toBeInTheDocument();
    // DataTable renders rows in both desktop + mobile views, so the
    // testid may appear twice — getAllByTestId guards against that.
    // #213 (commit ab318f0) renamed doctor-row-{id} -> doctor-card-{id}
    // when each row became a Link wrapper to /dashboard/doctors/[id].
    await waitFor(() =>
      expect(screen.getAllByTestId("doctor-card-d1").length).toBeGreaterThan(0)
    );
  });

  it("debounced search filters the list client-side", async () => {
    const u = userEvent.setup();
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Dr. Bina Shah").length).toBeGreaterThan(0)
    );
    await u.type(screen.getByTestId("doctor-search-input"), "asha");
    // 300ms debounce — wait for filter to apply.
    await waitFor(
      () => {
        expect(screen.getAllByText("Dr. Asha Mehta").length).toBeGreaterThan(0);
        expect(screen.queryByText("Dr. Bina Shah")).toBeNull();
      },
      { timeout: 1500 }
    );
  });

  it("specialization dropdown filters to a single specialty", async () => {
    const u = userEvent.setup();
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Dr. Bina Shah").length).toBeGreaterThan(0)
    );
    await u.selectOptions(screen.getByTestId("doctor-spec-filter"), "Cardiology");
    await waitFor(() => {
      expect(screen.getAllByText("Dr. Asha Mehta").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Dr. Chandra Rao").length).toBeGreaterThan(0);
      expect(screen.queryByText("Dr. Bina Shah")).toBeNull();
    });
  });

  it("clicking + Add Doctor opens the in-DOM modal", async () => {
    const u = userEvent.setup();
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-add-button")).toBeInTheDocument()
    );
    await u.click(screen.getByTestId("doctor-add-button"));
    expect(screen.getByTestId("doctor-add-modal")).toBeInTheDocument();
    expect(screen.getByTestId("doctor-add-save")).toBeInTheDocument();
    expect(screen.getByTestId("doctor-form-name")).toBeInTheDocument();
    expect(screen.getByTestId("doctor-form-spec")).toBeInTheDocument();
  });

  it("submitting an empty modal shows validation errors", async () => {
    const u = userEvent.setup();
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-add-button")).toBeInTheDocument()
    );
    await u.click(screen.getByTestId("doctor-add-button"));
    await u.click(screen.getByTestId("doctor-add-save"));
    await waitFor(() => {
      expect(screen.getByText(/full name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/email is required/i)).toBeInTheDocument();
      expect(screen.getByText(/qualification is required/i)).toBeInTheDocument();
    });
    // POST must NOT have fired with invalid data.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("a valid create-new-user submission POSTs /auth/register with role=DOCTOR", async () => {
    const u = userEvent.setup();
    apiMock.post.mockResolvedValue({ data: { user: { id: "new-u" } } });
    apiMock.patch.mockResolvedValue({ data: {} });
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-add-button")).toBeInTheDocument()
    );
    await u.click(screen.getByTestId("doctor-add-button"));
    await u.type(screen.getByTestId("doctor-form-name"), "Dr. Newbie");
    await u.type(screen.getByTestId("doctor-form-email"), "new@x.com");
    await u.type(screen.getByTestId("doctor-form-phone"), "9123456789");
    await u.type(screen.getByTestId("doctor-form-password"), "abcd1234");
    await u.type(screen.getByTestId("doctor-form-qual"), "MBBS");
    await u.click(screen.getByTestId("doctor-add-save"));
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/auth/register",
        expect.objectContaining({
          name: "Dr. Newbie",
          email: "new@x.com",
          phone: "9123456789",
          role: "DOCTOR",
        })
      );
    });
  });

  it("redirects non-admins to /dashboard/not-authorized", async () => {
    authMock.mockReturnValue({
      user: { id: "u", role: "RECEPTION" },
      isLoading: false,
    });
    render(<DoctorsPage />);
    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized")
      );
    });
  });

  it("keeps rendering when the list fetch fails (500)", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<DoctorsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^doctors$/i })
      ).toBeInTheDocument()
    );
  });
});
