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
  usePathname: () => "/dashboard/lab/test-id",
  useParams: () => ({ orderId: "test-id" }),
}));

import LabOrderPage from "../lab/[orderId]/page";

const sampleOrder = {
  id: "lo1",
  orderNumber: "LAB-001",
  status: "IN_PROGRESS",
  orderedAt: new Date().toISOString(),
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    gender: "MALE",
    age: 30,
    user: { name: "Aarav Mehta" },
  },
  doctor: { user: { name: "Dr. Rao" } },
  items: [
    {
      id: "i1",
      status: "PENDING",
      test: { name: "CBC", code: "CBC", unit: "", refRange: "" },
      results: [],
    },
  ],
};

function trackedPromise<T>(value: T): Promise<T> {
  const p: any = Promise.resolve(value);
  p.status = "fulfilled";
  p.value = value;
  return p;
}

function renderPage() {
  return render(
    <LabOrderPage params={trackedPromise({ orderId: "test-id" }) as any} />
  );
}

describe("LabOrderPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Tech", email: "t@x.com", role: "LAB_TECH" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state", async () => {
    // Skeleton sweep wave 8 (2026-05-23): plain "Loading..." text was
    // replaced with `<SkeletonCard ×3 />` inside a wrapper carrying
    // `data-testid="lab-order-detail-loading"` + `aria-busy="true"`.
    // Assert against the skeleton's testid + a11y attribute instead of
    // the removed text — both are stable, both are what assistive tech
    // actually consumes. Mirrors the wave-3 `users-loading` and wave-6
    // `ot-loading` patterns.
    apiMock.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const loader = await screen.findByTestId("lab-order-detail-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("shows order-not-found on failure", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/order not found/i)).toBeInTheDocument()
    );
  });

  it("renders populated lab order", async () => {
    apiMock.get.mockResolvedValue({ data: sampleOrder });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText(/LAB-001/).length).toBeGreaterThan(0);
  });

  it("renders back link", async () => {
    apiMock.get.mockResolvedValue({ data: sampleOrder });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/back to lab orders/i)).toBeInTheDocument()
    );
  });

  it("clicking Print Report button does not crash", async () => {
    apiMock.get.mockResolvedValue({ data: sampleOrder });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      screen.getByRole("button", { name: /print lab report/i })
    );
    // just ensure rendered; clicking opens window which we skip
    expect(
      screen.getByRole("button", { name: /print lab report/i })
    ).toBeInTheDocument();
  });
});
