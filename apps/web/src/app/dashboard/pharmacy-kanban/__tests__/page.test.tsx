// Tests for the per-MEDICINE Pharmacy Kanban
// (apps/web/src/app/dashboard/pharmacy-kanban/page.tsx). Each card is a single
// prescription line item. Asserts: 4 active columns render with mocked counts;
// a New medicine's Move PATCHes /pharmacy/prescription-items/:id/status; the
// optimistic move reverts on a 409; the final READY → Dispense POSTs
// /pharmacy/dispense with the medicine's id; an out-of-stock medicine's Move
// button is disabled (not advanceable); the board always fetches today; and
// the Move button keeps the 44px touch target.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiMock, authMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
const { routerPush, searchParamsMock } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  searchParamsMock: { value: new URLSearchParams() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => searchParamsMock.value,
  usePathname: () => "/dashboard/pharmacy-kanban",
}));

import PharmacyKanbanPage from "../page";

type CardOpts = { inStock?: boolean; dispensed?: boolean; medicineId?: string | null };

function payloadFor(opts: {
  pendingIds?: Array<[string, CardOpts?]> | string[];
  dispensingIds?: string[];
  readyIds?: Array<[string, CardOpts?]> | string[];
  dispensedIds?: string[];
  rejectedIds?: string[];
}) {
  const mk = (id: string, status: string, o: CardOpts = {}) => ({
    id,
    // All fixture cards belong to ONE prescription so the per-prescription
    // board filter (?prescription=p-rx) shows them.
    prescriptionId: "p-rx",
    medicineId: o.medicineId === undefined ? `med-${id}` : o.medicineId,
    medicineName: `Medicine ${id.toUpperCase()}`,
    dosage: "500mg",
    frequency: "1-0-0",
    duration: "5 days",
    patientId: `pat-${id}`,
    patientLabel: `Patient ${id.toUpperCase()}`,
    doctorName: "Dr. Test",
    requiredQty: 5,
    availableQty: o.inStock === false ? 0 : 50,
    inStock: o.inStock !== false,
    dispensed: o.dispensed ?? false,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const norm = (
    arr: Array<[string, CardOpts?]> | string[] | undefined,
    status: string,
  ) =>
    (arr ?? []).map((entry) =>
      Array.isArray(entry) ? mk(entry[0], status, entry[1]) : mk(entry, status),
    );
  return {
    data: {
      columns: {
        PENDING: norm(opts.pendingIds, "PENDING"),
        DISPENSING: norm(opts.dispensingIds, "DISPENSING"),
        READY: norm(opts.readyIds, "READY"),
        DISPENSED: norm(opts.dispensedIds, "DISPENSED"),
        REJECTED: norm(opts.rejectedIds, "REJECTED"),
        CANCELLED: [],
      },
      todayOnly: true,
    },
  };
}

describe("PharmacyKanbanPage — per-medicine board", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    apiMock.post.mockReset();
    routerReplace.mockReset();
    routerPush.mockReset();
    // Default: board scoped to the fixture prescription so columns render.
    searchParamsMock.value = new URLSearchParams("prescription=p-rx");
    authMock.mockReturnValue({
      user: { role: "PHARMACIST", id: "u1", userId: "u1", name: "Pharma" },
      isLoading: false,
    });
  });

  it("renders 4 active columns with mocked medicine counts", async () => {
    apiMock.get.mockResolvedValueOnce(
      payloadFor({ pendingIds: ["a", "b"], dispensingIds: ["c"] }),
    );
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-column-PENDING")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("kanban-count-PENDING").textContent).toBe("2");
    expect(screen.getByTestId("kanban-count-DISPENSING").textContent).toBe("1");
    expect(screen.getByTestId("kanban-count-READY").textContent).toBe("0");
  });

  it("Move on a New medicine PATCHes /pharmacy/prescription-items/:id/status and optimistically advances", async () => {
    apiMock.get.mockResolvedValueOnce(payloadFor({ pendingIds: ["a"] }));
    apiMock.patch.mockResolvedValueOnce({ data: { id: "a", kanbanStatus: "DISPENSING" } });
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("kanban-move-a"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/pharmacy/prescription-items/a/status",
        { status: "DISPENSING" },
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-PENDING").textContent).toBe("0");
      expect(screen.getByTestId("kanban-count-DISPENSING").textContent).toBe("1");
    });
  });

  it("reverts the optimistic move when the PATCH fails with 409", async () => {
    apiMock.get.mockResolvedValueOnce(payloadFor({ pendingIds: ["a"] }));
    apiMock.patch.mockRejectedValueOnce(
      Object.assign(new Error("Invalid transition"), { status: 409 }),
    );
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("kanban-move-a"));
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-PENDING").textContent).toBe("1");
      expect(screen.getByTestId("kanban-count-DISPENSING").textContent).toBe("0");
    });
  });

  it("the final READY → Dispense POSTs /pharmacy/dispense with the line-item id", async () => {
    apiMock.get.mockResolvedValue(
      payloadFor({ readyIds: [["a", { medicineId: "med-a" }]] }),
    );
    apiMock.post.mockResolvedValue({ data: {} });
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("kanban-move-a")).toHaveTextContent("Dispense");
    fireEvent.click(screen.getByTestId("kanban-move-a"));
    // Dispenses the LINE ITEM (card id "a"), not the medicine — so two lines
    // of the same medicine dispense independently.
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/pharmacy/dispense", {
        prescriptionId: "p-rx",
        itemIds: ["a"],
      }),
    );
  });

  it("an out-of-stock medicine's Move button is disabled (not advanceable)", async () => {
    apiMock.get.mockResolvedValueOnce(
      payloadFor({ pendingIds: [["a", { inStock: false }]] }),
    );
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    const moveBtn = screen.getByTestId("kanban-move-a");
    expect(moveBtn).toBeDisabled();
    expect(screen.getByText(/Out of stock/)).toBeInTheDocument();
    fireEvent.click(moveBtn);
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("always fetches today's medicines and shows the scope label", async () => {
    apiMock.get.mockResolvedValue(payloadFor({ pendingIds: ["a"] }));
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("todayOnly=true"),
      ),
    );
    expect(screen.getByTestId("pharmacy-kanban-scope")).toBeInTheDocument();
  });

  it("with NO prescription scope, shows the empty prompt (not all medicines)", async () => {
    searchParamsMock.value = new URLSearchParams(); // no ?prescription
    apiMock.get.mockResolvedValue(payloadFor({ pendingIds: ["a", "b"] }));
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("pharmacy-kanban-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("kanban-column-PENDING")).not.toBeInTheDocument();
  });

  it("Generate Bill generates/opens the prescription's invoice (dispensed-only)", async () => {
    apiMock.get.mockResolvedValue(payloadFor({ dispensedIds: ["a"] }));
    apiMock.post.mockResolvedValue({ data: { invoiceId: "inv-9" } });
    render(<PharmacyKanbanPage />);
    const btn = await screen.findByTestId("kanban-generate-bill");
    fireEvent.click(btn); // opens the confirm popup
    const confirm = await screen.findByTestId("kanban-bill-confirm");
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/prescriptions/p-rx/invoice",
        {},
      ),
    );
    // After generating, return to the Prescriptions list (bill is viewable
    // under Billing).
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard/prescriptions"),
    );
  });

  it("disables Generate Bill when the bill already covers every dispensed line", async () => {
    // 1 dispensed line, bill already has 1 → nothing new to add → disabled.
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/invoice")) {
        return Promise.resolve({ data: { invoiceId: "inv-5", billedCount: 1 } });
      }
      return Promise.resolve(payloadFor({ dispensedIds: ["a"] }));
    });
    render(<PharmacyKanbanPage />);
    const btn = await screen.findByTestId("kanban-generate-bill");
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent(/Bill Generated/);
    fireEvent.click(btn);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("offers 'Update Bill' when more medicines are dispensed than are on the bill", async () => {
    // 2 dispensed lines, bill only has 1 → one newly dispensed → Update Bill.
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/invoice")) {
        return Promise.resolve({ data: { invoiceId: "inv-5", billedCount: 1 } });
      }
      return Promise.resolve(payloadFor({ dispensedIds: ["a", "b"] }));
    });
    apiMock.post.mockResolvedValue({
      data: { invoiceId: "inv-5", billedCount: 2 },
    });
    render(<PharmacyKanbanPage />);
    const btn = await screen.findByTestId("kanban-generate-bill");
    await waitFor(() => expect(btn).toHaveTextContent(/Update Bill/));
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn); // opens the confirm popup
    const confirm = await screen.findByTestId("kanban-bill-confirm");
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/pharmacy/prescriptions/p-rx/invoice",
        {},
      ),
    );
  });

  it("shows a confirm popup on Generate Bill; Cancel closes it without billing", async () => {
    apiMock.get.mockResolvedValue(payloadFor({ dispensedIds: ["a"] }));
    render(<PharmacyKanbanPage />);
    const btn = await screen.findByTestId("kanban-generate-bill");
    fireEvent.click(btn);
    expect(await screen.findByTestId("kanban-bill-confirm-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("kanban-bill-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("kanban-bill-confirm-modal")).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Move buttons carry the 44px touch-target invariant", async () => {
    apiMock.get.mockResolvedValueOnce(payloadFor({ pendingIds: ["a"] }));
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    const moveBtn = screen.getByTestId("kanban-move-a");
    expect(moveBtn.className).toMatch(/h-11/);
    expect(moveBtn.className).toMatch(/min-w-\[44px\]/);
  });
});
