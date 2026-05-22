// Smoke tests for the Pearl §4.3 pharmacy dispensing Kanban board
// (apps/web/src/app/dashboard/pharmacy-kanban/page.tsx). Asserts:
//   • 4 active columns render (New / Dispensing / Ready / Dispensed)
//     with the mocked counts.
//   • Move button on a PENDING card calls
//     PATCH /pharmacy/prescriptions/:id/status with {status:"DISPENSING"}.
//   • Optimistic UI: card moves to the target column immediately on
//     success.
//   • Optimistic UI reverts on a 409 mock response.
//   • "Today only" / "All open" filter chips toggle the GET query
//     param so the page refetches with the right scope.
//   • Every Move button + filter chip carries the 44px touch-target
//     invariant (h-11 + min-w-[44px]) per Pearl §6.2.
//
// Mirrors the vi.hoisted pattern used by the rest of dashboard/__tests__.

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/pharmacy-kanban",
}));

import PharmacyKanbanPage from "../page";

function payloadFor(opts: {
  pendingIds?: string[];
  dispensingIds?: string[];
  readyIds?: string[];
  dispensedIds?: string[];
  rejectedIds?: string[];
}) {
  const mk = (id: string, status: string) => ({
    id,
    status,
    patientId: `p-${id}`,
    patientLabel: `Patient ${id.toUpperCase()}`,
    doctorName: "Dr. Test",
    topItem: "Paracetamol 500mg",
    extraItems: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return {
    data: {
      columns: {
        PENDING: (opts.pendingIds ?? []).map((id) => mk(id, "PENDING")),
        DISPENSING: (opts.dispensingIds ?? []).map((id) => mk(id, "DISPENSING")),
        READY: (opts.readyIds ?? []).map((id) => mk(id, "READY")),
        DISPENSED: (opts.dispensedIds ?? []).map((id) => mk(id, "DISPENSED")),
        REJECTED: (opts.rejectedIds ?? []).map((id) => mk(id, "REJECTED")),
        CANCELLED: [],
      },
      todayOnly: true,
    },
  };
}

describe("PharmacyKanbanPage — Pearl §4.3 gap row 104", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    routerReplace.mockReset();
    authMock.mockReturnValue({
      user: { role: "PHARMACIST", id: "u1", userId: "u1", name: "Pharma" },
      isLoading: false,
    });
  });

  it("renders 4 active columns with mocked card counts", async () => {
    apiMock.get.mockResolvedValueOnce(
      payloadFor({ pendingIds: ["a", "b"], dispensingIds: ["c"], readyIds: [], dispensedIds: [] }),
    );
    render(<PharmacyKanbanPage />);
    await waitFor(() => {
      expect(screen.getByTestId("kanban-column-PENDING")).toBeInTheDocument();
    });
    expect(screen.getByTestId("kanban-column-DISPENSING")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-column-READY")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-column-DISPENSED")).toBeInTheDocument();
    expect(screen.getByTestId("kanban-count-PENDING").textContent).toBe("2");
    expect(screen.getByTestId("kanban-count-DISPENSING").textContent).toBe("1");
    expect(screen.getByTestId("kanban-count-READY").textContent).toBe("0");
  });

  it("Move button on PENDING card calls PATCH with status:DISPENSING and optimistically moves the card", async () => {
    apiMock.get.mockResolvedValueOnce(
      payloadFor({ pendingIds: ["a"], dispensingIds: [], readyIds: [], dispensedIds: [] }),
    );
    apiMock.patch.mockResolvedValueOnce({ data: { id: "a", status: "DISPENSING" } });
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("kanban-move-a"));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/pharmacy/prescriptions/a/status",
        { status: "DISPENSING" },
      );
    });
    // Optimistic UI: count flips immediately (no re-fetch needed)
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-PENDING").textContent).toBe("0");
      expect(screen.getByTestId("kanban-count-DISPENSING").textContent).toBe("1");
    });
  });

  it("reverts the optimistic move when the PATCH fails with 409", async () => {
    apiMock.get.mockResolvedValueOnce(
      payloadFor({ pendingIds: ["a"] }),
    );
    apiMock.patch.mockRejectedValueOnce(
      Object.assign(new Error("Invalid transition"), { status: 409 }),
    );
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("kanban-move-a"));
    // Wait for revert: card should be back in PENDING (count = 1)
    await waitFor(() => {
      expect(screen.getByTestId("kanban-count-PENDING").textContent).toBe("1");
      expect(screen.getByTestId("kanban-count-DISPENSING").textContent).toBe("0");
    });
  });

  it("'All open' filter toggle re-fetches with todayOnly=false", async () => {
    apiMock.get
      .mockResolvedValueOnce(payloadFor({ pendingIds: ["a"] }))
      .mockResolvedValueOnce(payloadFor({ pendingIds: ["a", "b"] }));
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("todayOnly=true"),
      ),
    );
    fireEvent.click(screen.getByTestId("pharmacy-kanban-filter-all"));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("todayOnly=false"),
      ),
    );
  });

  it("Move buttons and filter chips carry the 44px touch-target invariant", async () => {
    apiMock.get.mockResolvedValueOnce(payloadFor({ pendingIds: ["a"] }));
    render(<PharmacyKanbanPage />);
    await waitFor(() =>
      expect(screen.getByTestId("kanban-move-a")).toBeInTheDocument(),
    );
    const moveBtn = screen.getByTestId("kanban-move-a");
    expect(moveBtn.className).toMatch(/h-11/);
    expect(moveBtn.className).toMatch(/min-w-\[44px\]/);
    const todayBtn = screen.getByTestId("pharmacy-kanban-filter-today");
    expect(todayBtn.className).toMatch(/h-11/);
    expect(todayBtn.className).toMatch(/min-w-\[44px\]/);
    const allBtn = screen.getByTestId("pharmacy-kanban-filter-all");
    expect(allBtn.className).toMatch(/h-11/);
    expect(allBtn.className).toMatch(/min-w-\[44px\]/);
  });
});
