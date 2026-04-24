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
    // subtitle is "Patient registry" in en / "मरीज़ रजिस्ट्री" in hi — match the digit instead
    expect(screen.getAllByText(/0/).length).toBeGreaterThan(0);
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
      screen.getByPlaceholderText(/search by name/i)
    );
    const input = screen.getByPlaceholderText(
      /search by name/i
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
      screen.getAllByRole("button", { name: /register patient/i })[0]
    );
    const openBtns = screen.getAllByRole("button", { name: /register patient/i });
    await user.click(openBtns[0]);
    // Modal opens — there should now be a heading with the register title.
    const headings = screen.getAllByRole("heading", { name: /register patient/i });
    expect(headings.length).toBeGreaterThan(0);
  });

  it("shows validation errors when submitting empty registration", async () => {
    apiMock.get.mockResolvedValue({ data: [], meta: { total: 0 } });
    const user = userEvent.setup();
    render(<PatientsPage />);
    await waitFor(() =>
      screen.getAllByRole("button", { name: /register patient/i })[0]
    );
    const openBtns = screen.getAllByRole("button", { name: /register patient/i });
    await user.click(openBtns[0]);
    // The form's submit button is the last register-patient button in the tree.
    const allBtns = screen.getAllByRole("button", { name: /register patient/i });
    await user.click(allBtns[allBtns.length - 1]);
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

  it("renders '—' (NOT '0') in the age column for legacy rows with age=0 and no DOB", async () => {
    // Issue #13 regression: a legacy patient row with age=0 AND dateOfBirth=null
    // previously rendered "0" in the Age column. The fix routes the column
    // through formatPatientAge() which returns the "—" placeholder in this case.
    const legacyRow = {
      id: "p-legacy",
      mrNumber: "MR-LEGACY",
      gender: "MALE",
      age: 0,
      dateOfBirth: null,
      bloodGroup: null,
      user: { id: "u-legacy", name: "Zero Age Person", email: "z@x.com", phone: "9000000099" },
    };
    apiMock.get.mockResolvedValue({ data: [legacyRow], meta: { total: 1 } });
    render(<PatientsPage />);
    await waitFor(() => {
      // DataTable renders the row twice (desktop + mobile views), so use getAllByText.
      expect(screen.getAllByText("Zero Age Person").length).toBeGreaterThan(0);
    });
    // Take the desktop <tr> containing the name and assert the age cell.
    const desktopRow = screen.getAllByText("Zero Age Person")[0].closest("tr");
    expect(desktopRow).toBeTruthy();
    // Must show the placeholder, never a bare "0" in the age cell.
    expect(desktopRow!.textContent).toMatch(/—/);
    // MR-LEGACY + "—" + "MALE" — no literal digit "0" should appear in the row.
    expect(desktopRow!.textContent).not.toMatch(/\b0\b/);
  });

  it("renders a real DOB-derived age when dateOfBirth is present", async () => {
    // DOB wins over stored `age` when both are set — this verifies the helper
    // is not falling through to the stale integer column.
    const fiftyYearsAgo = new Date();
    fiftyYearsAgo.setFullYear(fiftyYearsAgo.getFullYear() - 50);
    const adult = {
      id: "p-adult",
      mrNumber: "MR-A",
      gender: "FEMALE",
      age: 99, // stale — DOB wins
      dateOfBirth: fiftyYearsAgo.toISOString(),
      bloodGroup: "O+",
      user: { id: "u-a", name: "DOB Wins Person", email: "a@x.com", phone: "9000000010" },
    };
    apiMock.get.mockResolvedValue({ data: [adult], meta: { total: 1 } });
    render(<PatientsPage />);
    await waitFor(() => {
      expect(screen.getAllByText("DOB Wins Person").length).toBeGreaterThan(0);
    });
    const desktopRow = screen.getAllByText("DOB Wins Person")[0].closest("tr");
    expect(desktopRow).toBeTruthy();
    // 50 should be rendered, not stale 99. (No \b because text concatenates
    // with neighbouring phone digits in testing-library's textContent.)
    expect(desktopRow!.textContent).toContain("50");
    expect(desktopRow!.textContent).not.toContain("99");
  });
});
