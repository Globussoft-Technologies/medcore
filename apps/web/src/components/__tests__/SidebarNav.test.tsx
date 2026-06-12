/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pearl §7.2 — per-user reorderable sidebar.
 *
 * Verifies:
 *   1. Pinned items render first; reorderable items follow in default order
 *      when there is no saved customisation.
 *   2. A saved order from the DB is applied to the reorderable items.
 *   3. Entering reorder mode + "Default" persists an empty order (reset).
 *   4. Drag-reordering persists the new href order to the API.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { apiMock, confirmMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  confirmMock: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/use-dialog", () => ({ useConfirm: () => confirmMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SidebarNav } from "../SidebarNav";

const Stub = () => <svg data-testid="icon" />;

const ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: Stub },
  { href: "/a", label: "Alpha", icon: Stub },
  { href: "/b", label: "Bravo", icon: Stub },
  { href: "/c", label: "Charlie", icon: Stub },
];

function renderNav() {
  return render(
    <SidebarNav
      items={ITEMS}
      pinnedHrefs={["/dashboard"]}
      pathname="/dashboard"
      tNav={(l) => l}
      tips={{}}
    />,
  );
}

function linkHrefs(): string[] {
  return screen
    .getAllByRole("link")
    .map((a) => a.getAttribute("href") || "");
}

const dt = () => ({
  dataTransfer: { effectAllowed: "", dropEffect: "", setDragImage: vi.fn() },
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.put.mockResolvedValue({ success: true, data: { order: [] }, error: null });
  confirmMock.mockResolvedValue(true);
});

describe("SidebarNav", () => {
  it("renders pinned item first, reorderables in default order (no saved order)", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: { order: [] }, error: null });
    renderNav();
    await waitFor(() =>
      expect(linkHrefs()).toEqual(["/dashboard", "/a", "/b", "/c"]),
    );
  });

  it("applies a saved order from the DB", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: { order: ["/c", "/a", "/b"] },
      error: null,
    });
    renderNav();
    await waitFor(() =>
      expect(linkHrefs()).toEqual(["/dashboard", "/c", "/a", "/b"]),
    );
  });

  it("inserts newly-added items at their DEFAULT position, not the bottom", async () => {
    // Saved order reorders the two known hrefs (/c before /b); /a is a 'new'
    // href whose DEFAULT position is the front. Per reconcile()'s documented
    // behaviour, /a lands at its default position (front) rather than being
    // stranded at the bottom — this is what keeps a super-admin's later-
    // appearing Tenants item where the stock layout puts it.
    apiMock.get.mockResolvedValue({
      success: true,
      data: { order: ["/c", "/b"] }, // /c,/b known + reordered; /a is 'new'
      error: null,
    });
    renderNav();
    await waitFor(() =>
      expect(linkHrefs()).toEqual(["/dashboard", "/a", "/c", "/b"]),
    );
  });

  it("'Default' resets by persisting an empty order (after confirm)", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: { order: ["/c", "/a", "/b"] },
      error: null,
    });
    renderNav();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("sidebar-reorder-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-reset-default"));

    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith("/users/me/sidebar-preferences", {
        order: [],
      }),
    );
    expect(confirmMock).toHaveBeenCalled();
    // After reset it auto-exits reorder mode → the "Reorder menu" button returns
    // (no need to click "Done" again).
    await waitFor(() =>
      expect(screen.getByTestId("sidebar-reorder-toggle")).toBeInTheDocument(),
    );
  });

  it("'Default' does nothing when the confirmation is declined", async () => {
    confirmMock.mockResolvedValue(false);
    apiMock.get.mockResolvedValue({
      success: true,
      data: { order: ["/c", "/a", "/b"] },
      error: null,
    });
    renderNav();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("sidebar-reorder-toggle"));
    fireEvent.click(screen.getByTestId("sidebar-reset-default"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.put).not.toHaveBeenCalled();
    // Cancelling still leaves reorder mode → the "Reorder menu" button returns.
    await waitFor(() =>
      expect(screen.getByTestId("sidebar-reorder-toggle")).toBeInTheDocument(),
    );
  });

  it("persists the new href order after a drag-reorder", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: { order: [] }, error: null });
    renderNav();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("sidebar-reorder-toggle"));

    const a = await screen.findByTestId("sidebar-reorder-item-/a");
    const b = await screen.findByTestId("sidebar-reorder-item-/b");

    // Drag /a onto /b → /a lands after /b.
    fireEvent.dragStart(a, dt());
    fireEvent.dragOver(b, dt());
    fireEvent.drop(b, dt());

    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith("/users/me/sidebar-preferences", {
        order: ["/b", "/a", "/c"],
      }),
    );
  });

  it("pinned items are not draggable in reorder mode", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: { order: [] }, error: null });
    renderNav();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("sidebar-reorder-toggle"));

    // Dashboard renders as a pinned (non-draggable) row, not a reorder item.
    expect(screen.getByTestId("sidebar-pinned-item-/dashboard")).toBeInTheDocument();
    expect(
      screen.queryByTestId("sidebar-reorder-item-/dashboard"),
    ).not.toBeInTheDocument();
  });

  it("shows the 'Drag items to reorder' hint only in reorder mode", async () => {
    apiMock.get.mockResolvedValue({ success: true, data: { order: [] }, error: null });
    renderNav();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());

    expect(screen.queryByTestId("sidebar-reorder-hint")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sidebar-reorder-toggle"));
    expect(screen.getByTestId("sidebar-reorder-hint")).toBeInTheDocument();
  });
});
