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
  usePathname: () => "/dashboard/doctors/test-id",
  useParams: () => ({ id: "test-id" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import DoctorDetailPage from "../doctors/[id]/page";

const sampleDoctor = {
  id: "test-id",
  specialization: "Cardiology",
  qualification: "MD, DM",
  registrationNumber: "MED-12345",
  user: {
    id: "u1",
    name: "Dr. Aarav Singh",
    email: "aarav@hospital.in",
    phone: "9000000001",
    isActive: true,
  },
  schedules: [
    {
      id: "s1",
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "13:00",
      slotDurationMinutes: 15,
    },
  ],
};

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
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

describe("DoctorDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    toastMock.error.mockReset();
  });

  it("renders the loading copy while the fetch is in flight", async () => {
    asAdmin();
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<DoctorDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/loading doctor/i)).toBeInTheDocument()
    );
  });

  it("renders not-found when the doctor id is not in the list", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({ data: [] });
    render(<DoctorDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-detail-notfound")).toBeInTheDocument()
    );
  });

  it("renders the doctor profile on a happy path", async () => {
    asAdmin();
    apiMock.get.mockResolvedValue({ data: [sampleDoctor] });
    render(<DoctorDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-detail-name")).toBeInTheDocument()
    );
    expect(screen.getByTestId("doctor-detail-name").textContent).toMatch(
      /Aarav Singh/
    );
    expect(screen.getByTestId("doctor-detail-spec").textContent).toMatch(
      /Cardiology/
    );
    expect(screen.getByTestId("doctor-detail-schedule-table")).toBeInTheDocument();
  });

  it("only shows the Edit button for ADMIN role", async () => {
    asReception();
    apiMock.get.mockResolvedValue({ data: [sampleDoctor] });
    render(<DoctorDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-detail-name")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("doctor-detail-edit")).toBeNull();
  });

  it("falls back to not-found when the doctors-list fetch rejects", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<DoctorDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("doctor-detail-notfound")).toBeInTheDocument()
    );
  });
});
