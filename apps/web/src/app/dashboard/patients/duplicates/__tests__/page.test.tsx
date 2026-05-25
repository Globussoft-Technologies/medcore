/**
 * Duplicate-patient triage page tests — Pearl ERP Stage 1 §2.1.1 (gap row 41).
 *
 * What / which modules / why:
 *   - Exercises /dashboard/patients/duplicates client component:
 *       * RBAC: redirects non-ADMIN/RECEPTION users to /not-authorized.
 *       * Empty state when no duplicates exist.
 *       * Grouping by phone, then merge action posting to
 *         POST /patients/:keepId/merge with mergeFromIds + showing the
 *         per-table mergedRowCounts in the success toast.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patients/duplicates",
}));

import PatientsDuplicatesPage from "../page";

// Suppress the window.confirm prompt the merge action raises.
const origConfirm = window.confirm;
beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  routerMock.replace.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  window.confirm = () => true;
});
afterEach(() => {
  window.confirm = origConfirm;
});

describe("PatientsDuplicatesPage", () => {
  it("redirects a NURSE user away from the page (RBAC gate)", async () => {
    authMock.mockReturnValue({
      user: { id: "u1", name: "Nina Nurse", role: "NURSE" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PatientsDuplicatesPage />);
    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      ),
    );
  });

  it("renders the empty state when no patients share a phone number", async () => {
    authMock.mockReturnValue({
      user: { id: "u3", name: "Admin", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue({
      data: [
        {
          id: "p1",
          mrNumber: "MR000001",
          user: { id: "u-p1", name: "A", email: "a@x", phone: "9000000001" },
        },
        {
          id: "p2",
          mrNumber: "MR000002",
          user: { id: "u-p2", name: "B", email: "b@x", phone: "9000000002" },
        },
      ],
    });
    render(<PatientsDuplicatesPage />);
    await waitFor(() => {
      expect(screen.getByTestId("dup-empty")).toBeInTheDocument();
    });
  });

  it("groups duplicates by phone and renders a row per candidate", async () => {
    authMock.mockReturnValue({
      user: { id: "u3", name: "Admin", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue({
      data: [
        {
          id: "p1",
          mrNumber: "MR000010",
          dateOfBirth: "1990-01-01",
          user: { id: "uA", name: "Asha Sharma", email: "a@x", phone: "9000000100" },
        },
        {
          id: "p2",
          mrNumber: "MR000011",
          dateOfBirth: "1990-01-02",
          user: { id: "uB", name: "Asha S.", email: "b@x", phone: "9000000100" },
        },
        {
          id: "p3",
          mrNumber: "MR000012",
          user: { id: "uC", name: "Solo", email: "c@x", phone: "9000000999" },
        },
      ],
    });
    render(<PatientsDuplicatesPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("dup-group").length).toBeGreaterThan(0),
    );
    const groups = screen.getAllByTestId("dup-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute("data-phone")).toBe("9000000100");
    const rows = screen.getAllByTestId("dup-row");
    expect(rows).toHaveLength(2);
  });

  it("posts mergeFromIds to /patients/:keepId/merge and surfaces rowCounts", async () => {
    authMock.mockReturnValue({
      user: { id: "u3", name: "Admin", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValueOnce({
      data: [
        {
          id: "p1",
          mrNumber: "MR000010",
          dateOfBirth: "1990-01-01",
          user: { id: "uA", name: "Asha Sharma", email: "a@x", phone: "9000000100" },
        },
        {
          id: "p2",
          mrNumber: "MR000011",
          dateOfBirth: "1990-01-02",
          user: { id: "uB", name: "Asha S.", email: "b@x", phone: "9000000100" },
        },
      ],
    });
    // Refresh-after-success call returns empty (the two have been merged).
    apiMock.get.mockResolvedValueOnce({ data: [] });
    apiMock.post.mockResolvedValueOnce({
      data: {
        keepId: "p1",
        mergedFromIds: ["p2"],
        mergedRowCounts: { appointment: 3, invoice: 2 },
      },
    });

    render(<PatientsDuplicatesPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("dup-row")).toHaveLength(2),
    );

    // Pick p1 as keep (first radio), p2 as merge-from (second row checkbox).
    const radios = screen.getAllByTestId("dup-keep-radio");
    const checkboxes = screen.getAllByTestId("dup-from-checkbox");
    const user = userEvent.setup();
    await user.click(radios[0]); // keep p1
    await user.click(checkboxes[1]); // merge-from p2

    await user.click(screen.getByTestId("dup-merge-action"));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/patients/p1/merge", {
        mergeFromIds: ["p2"],
      });
    });
    expect(toastMock.success).toHaveBeenCalled();
    const msg = (toastMock.success.mock.calls[0]?.[0] ?? "") as string;
    expect(msg).toMatch(/3 appointment/);
    expect(msg).toMatch(/2 invoice/);
  });

  it("blocks the merge action when no keep row is selected", async () => {
    authMock.mockReturnValue({
      user: { id: "u3", name: "Admin", role: "ADMIN" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValueOnce({
      data: [
        {
          id: "p1",
          mrNumber: "MR000010",
          user: { id: "uA", name: "Asha Sharma", email: "a@x", phone: "9000000100" },
        },
        {
          id: "p2",
          mrNumber: "MR000011",
          user: { id: "uB", name: "Asha S.", email: "b@x", phone: "9000000100" },
        },
      ],
    });
    render(<PatientsDuplicatesPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("dup-row")).toHaveLength(2),
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("dup-merge-action"));
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/canonical row/i),
    );
  });
});
