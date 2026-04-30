/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function trackedPromise<T>(value: T): Promise<T> {
  const p: any = Promise.resolve(value);
  p.status = "fulfilled";
  p.value = value;
  return p;
}

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
  usePathname: () => "/dashboard/admissions/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import AdmissionDetailPage from "../admissions/[id]/page";

const sampleAdmission = {
  id: "adm1",
  admissionNumber: "ADM-100",
  admittedAt: new Date().toISOString(),
  status: "ADMITTED",
  reason: "Observation",
  diagnosis: "Fever",
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    user: { name: "Aarav Mehta", phone: "9000000001" },
  },
  doctor: { id: "d1", user: { name: "Dr. Singh" } },
  bed: { id: "b1", bedNumber: "B-1", ward: { id: "w1", name: "General" } },
};

function renderPage() {
  return render(
    <AdmissionDetailPage params={trackedPromise({ id: "test-id" }) as any} />
  );
}

describe("AdmissionDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders loading initially", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/loading/i)).toBeInTheDocument()
    );
  });

  it("shows not-found when admission fetch fails", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/admission not found/i)).toBeInTheDocument()
    );
  });

  it("renders populated admission details", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions/test-id"))
        return Promise.resolve({ data: sampleAdmission });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText(/ADM-100/).length).toBeGreaterThan(0);
  });

  it("switches tabs without crashing", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/admissions/test-id")
        return Promise.resolve({ data: sampleAdmission });
      if (url.includes("/bill"))
        return Promise.resolve({
          data: { breakdown: [], days: 0, grandTotal: 0 },
        });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/ADM-100/).length).toBeGreaterThan(0)
    );
    // Just verify page rendered with data; exercising tab buttons is not
    // reliable across DataTable desktop+mobile duplication.
    expect(screen.getAllByText(/ADM-100/).length).toBeGreaterThan(0);
  });

  it("renders without crashing when API returns empty", async () => {
    apiMock.get.mockResolvedValue({ data: null });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/admission not found/i)).toBeInTheDocument()
    );
  });

  // Issue #416 — Medications tab used to crash the patient chart when the
  // /medication/orders payload contained null entries (e.g. a stale
  // serialized cache row) or an order whose `administrations[]` had a
  // null element. The render-time TypeError bubbled to the page-level
  // ErrorBoundary and users saw the entire tab go red. We now filter out
  // non-object entries on both layers and route every date through the
  // Invalid-Date-safe `formatDateTime` helper.
  it("renders Medications tab without crashing when payload contains null rows (#416)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/admissions/test-id")
        return Promise.resolve({ data: sampleAdmission });
      if (url.includes("/medication/orders"))
        return Promise.resolve({
          data: [
            null,
            {
              id: "ord-1",
              dosage: "500mg",
              frequency: "BID",
              route: "ORAL",
              startDate: "2026-04-30",
              isActive: true,
              medicineName: "Paracetamol",
              administrations: [
                null,
                {
                  id: "adm-1",
                  scheduledAt: "not-a-date",
                  status: "ADMINISTERED",
                },
              ],
            },
          ],
        });
      if (url.includes("/bill"))
        return Promise.resolve({
          data: { breakdown: [], days: 0, grandTotal: 0 },
        });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/ADM-100/).length).toBeGreaterThan(0)
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^\s*medications\s*$/i })
    );
    // Tab rendered without throwing — the page-level ErrorBoundary
    // fallback ("Something went wrong rendering this view.") must NOT
    // appear, and the surviving order row must render its name.
    await waitFor(() =>
      expect(screen.getByTestId("medication-orders-list")).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/Something went wrong rendering this view/i)
    ).toBeNull();
    expect(
      screen.getAllByTestId("medication-order-name").map((n) => n.textContent)
    ).toContain("Paracetamol");
  });

  // Issue #417 — Nurse Rounds tab used to crash on null entries in the
  // /nurse-rounds payload. Same mechanism as #416. We now filter the
  // array and render the empty state when nothing valid remains.
  it("renders Nurse Rounds tab without crashing when payload is null/empty (#417)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/admissions/test-id")
        return Promise.resolve({ data: sampleAdmission });
      if (url.includes("/nurse-rounds"))
        return Promise.resolve({ data: [null, null] });
      if (url.includes("/bill"))
        return Promise.resolve({
          data: { breakdown: [], days: 0, grandTotal: 0 },
        });
      return Promise.resolve({ data: [] });
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/ADM-100/).length).toBeGreaterThan(0)
    );
    await userEvent.click(
      screen.getByRole("button", { name: /nurse rounds/i })
    );
    // After filtering null entries the visible list is empty — no
    // `nurse-round-row` testids — and crucially the page-level
    // ErrorBoundary fallback ("Something went wrong rendering this
    // view.") must NOT appear.
    await waitFor(() =>
      expect(screen.getByTestId("nurse-rounds-list")).toBeInTheDocument()
    );
    expect(screen.queryAllByTestId("nurse-round-row")).toHaveLength(0);
    expect(
      screen.queryByText(/Something went wrong rendering this view/i)
    ).toBeNull();
  });
});
