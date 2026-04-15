/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patients",
}));

import PatientsPage from "../patients/page";

const samplePatients = [
  {
    id: "p1",
    mrNumber: "MR-1",
    gender: "MALE",
    age: 30,
    bloodGroup: "A+",
    user: { id: "u1", name: "Aarav Mehta", email: "a@x.com", phone: "9000000001" },
  },
  {
    id: "p2",
    mrNumber: "MR-2",
    gender: "FEMALE",
    age: 28,
    bloodGroup: "B+",
    user: { id: "u2", name: "Bina Shah", email: "b@x.com", phone: "9000000002" },
  },
  {
    id: "p3",
    mrNumber: "MR-3",
    gender: "MALE",
    age: 60,
    bloodGroup: "O+",
    user: { id: "u3", name: "Chandra Rao", email: "c@x.com", phone: "9000000003" },
  },
];

describe("PatientsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Rec", email: "r@x.com", role: "RECEPTION" },
    });
    document.documentElement.classList.remove("dark");
  });

  it("renders heading with empty data", async () => {
    apiMock.get.mockResolvedValue({ data: [], meta: { total: 0 } });
    render(<PatientsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^patients$/i })
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/0 registered patients/i)).toBeInTheDocument();
  });

  it("renders a populated patient list", async () => {
    apiMock.get.mockResolvedValue({ data: samplePatients, meta: { total: 3 } });
    render(<PatientsPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Bina Shah").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Chandra Rao").length).toBeGreaterThan(0);
    });
  });

  it("typing in the search box refetches with a search query", async () => {
    apiMock.get.mockResolvedValue({ data: [], meta: { total: 0 } });
    const user = userEvent.setup();
    render(<PatientsPage />);
    await waitFor(() =>
      screen.getByPlaceholderText(/search by name, phone, or mr number/i)
    );
    const input = screen.getByPlaceholderText(
      /search by name, phone, or mr number/i
    );
    await user.type(input, "asha");
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("search="))).toBe(true);
    });
  });

  it("opens the registration form when Register Patient button is clicked", async () => {
    apiMock.get.mockResolvedValue({ data: [], meta: { total: 0 } });
    const user = userEvent.setup();
    render(<PatientsPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /register patient/i })
    );
    await user.click(screen.getByRole("button", { name: /register patient/i }));
    expect(
      screen.getByRole("heading", { name: /new patient registration/i })
    ).toBeInTheDocument();
  });

  it("shows validation errors when submitting empty registration", async () => {
    apiMock.get.mockResolvedValue({ data: [], meta: { total: 0 } });
    const user = userEvent.setup();
    render(<PatientsPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /register patient/i })
    );
    await user.click(screen.getByRole("button", { name: /register patient/i }));
    await user.click(screen.getByRole("button", { name: /^register$/i }));
    await waitFor(() => {
      expect(screen.getByText(/full name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/phone number is required/i)).toBeInTheDocument();
    });
  });

  it("keeps rendering when the list fetch fails (500)", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<PatientsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^patients$/i })
      ).toBeInTheDocument()
    );
  });
});
