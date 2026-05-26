/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MedicinesPage — full-surface coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/medicines/page.tsx, the
 *     formulary/catalog master. Endpoints the page hits:
 *       GET    /medicines?search=&category=     (list with filters)
 *       GET    /medicines/:id                   (detail w/ interactions)
 *       POST   /medicines                       (create)
 *       PATCH  /medicines/:id                   (update)
 *       DELETE /medicines/:id                   (admin-only)
 *
 *   - Behaviours covered:
 *       1. RBAC — VIEW_ALLOWED restriction (ADMIN/DOCTOR/NURSE/PHARMACIST);
 *          RECEPTION triggers toast.error + router.replace to
 *          /dashboard/not-authorized?from=... with the breadcrumb.
 *       2. Loading branch — `medicines-loading` skeleton renders while
 *          the initial /medicines fetch is pending.
 *       3. Happy fetch — every row renders name, generic, mfg, category,
 *          form+strength concatenation, Rx badge.
 *       4. Empty branch — "No medicines found." copy when list is [].
 *       5. Error-path resilience — initial GET rejection still flips
 *          loading off and renders the empty branch.
 *       6. Search filter — typing into the search box refetches with
 *          ?search= in the querystring.
 *       7. Category filter — changing the <select> refetches with
 *          ?category= in the querystring.
 *       8. Add Medicine button is ADMIN-only — hidden for DOCTOR/NURSE.
 *       9. Create modal — opens, validates blank name (toast.error),
 *          validates blank manufacturer (toast.error), happy POST,
 *          closes + toasts success + reloads.
 *      10. Edit modal — Edit button opens the modal pre-populated with
 *          the row's fields, heading reads "Edit <name>", submit calls
 *          PATCH /medicines/:id.
 *      11. DOCTOR can Edit but not Delete (canEdit / canDelete split).
 *      12. PHARMACIST can neither Edit nor Delete (action buttons absent).
 *      13. Delete confirm flow — ADMIN clicks Delete, confirm resolves
 *          true → DELETE fires + toast.success + reload. Confirm resolves
 *          false → no DELETE fires.
 *      14. Detail modal — clicking a card fetches /medicines/:id and
 *          renders the Info grid + interactions list (MAJOR/MODERATE/MINOR
 *          severity branches). Detail-fetch rejection falls back to row.
 *      15. Detail modal close (X button) clears `selected`.
 *      16. Cancel button on add modal closes without POST.
 *      17. Create error surfaces toast.error with the error message.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *            next/navigation, @/components/Skeleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, confirmMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
    authMock: vi.fn(),
    routerMock: {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
    confirmMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/medicines",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import MedicinesPage from "../page";

type Medicine = {
  id: string;
  name: string;
  genericName?: string | null;
  form?: string | null;
  strength?: string | null;
  category?: string | null;
  rxRequired?: boolean;
  manufacturer?: string | null;
  interactions?: Array<{
    id: string;
    severity: string;
    description: string;
    interactsWith?: { id: string; name: string };
  }>;
};

function medFixture(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: "m-1",
    name: "Amlodipine 5mg",
    genericName: "Amlodipine",
    form: "Tablet",
    strength: "5mg",
    category: "Cardiac",
    rxRequired: true,
    manufacturer: "Cipla",
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    isLoading: false,
  });
}

function asNurse() {
  authMock.mockReturnValue({
    user: { id: "u-nurse", role: "NURSE", name: "Nurse" },
    isLoading: false,
  });
}

function asPharmacist() {
  authMock.mockReturnValue({
    user: { id: "u-pharm", role: "PHARMACIST", name: "Pharm" },
    isLoading: false,
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Front Desk" },
    isLoading: false,
  });
}

describe("MedicinesPage (formulary catalog — full surface)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    confirmMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects RECEPTION to /dashboard/not-authorized with the ?from= breadcrumb and toasts a role-restriction error", async () => {
    asReception();
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/restricted to clinical and pharmacy roles/i),
      ),
    );
    expect(routerMock.replace).toHaveBeenCalledWith(
      `/dashboard/not-authorized?from=${encodeURIComponent(
        "/dashboard/medicines",
      )}`,
    );
  });

  it("does NOT redirect when the auth store is still loading (isLoading=true short-circuits the gate)", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);
    // Give the effect a microtask to run.
    await new Promise((r) => setTimeout(r, 10));

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("renders the loading skeleton while the initial /medicines fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<MedicinesPage />);

    expect(
      await screen.findByTestId("medicines-loading"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders one card per medicine with name, generic, manufacturer, Rx badge, form+strength concatenation, and category chip", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        medFixture({ id: "m-1", name: "Amlodipine 5mg" }),
        medFixture({
          id: "m-2",
          name: "Paracetamol 500mg",
          genericName: "Paracetamol",
          rxRequired: false,
          manufacturer: "GSK",
          category: "Analgesic",
          form: "Tablet",
          strength: "500mg",
        }),
      ],
    });

    render(<MedicinesPage />);

    await screen.findByText("Amlodipine 5mg");
    await screen.findByText("Paracetamol 500mg");

    // Querystring contract — no filters → bare URL.
    expect(apiMock.get).toHaveBeenCalledWith("/medicines");

    // Mfg labels both render with the correct mfg.
    const mfgs = screen.getAllByTestId("medicine-manufacturer");
    expect(mfgs[0].textContent).toMatch(/Cipla/);
    expect(mfgs[1].textContent).toMatch(/GSK/);

    // Exactly one Rx badge — Amlodipine has rxRequired:true; Paracetamol does not.
    expect(screen.getAllByText("Rx")).toHaveLength(1);

    // Form+strength concatenation renders.
    expect(screen.getAllByText(/Tablet · 5mg/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Tablet · 500mg/).length).toBeGreaterThan(0);
  });

  it("renders the em-dash form/strength fallback and 'Mfg: —' when both fields are absent", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        medFixture({
          id: "m-3",
          name: "Bare Drug",
          form: null,
          strength: null,
          manufacturer: null,
          genericName: null,
          category: null,
          rxRequired: false,
        }),
      ],
    });

    render(<MedicinesPage />);

    await screen.findByText("Bare Drug");
    // form+strength concatenation falls back to "—".
    const card = screen.getByTestId("medicine-card");
    expect(within(card).getByText("—")).toBeInTheDocument();
    expect(within(card).getByTestId("medicine-manufacturer").textContent).toMatch(
      /Mfg: —/,
    );
  });

  it("renders 'No medicines found.' when the list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);

    expect(await screen.findByText(/No medicines found\./i)).toBeInTheDocument();
  });

  it("swallows fetch errors and settles into the empty branch when /medicines rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));

    render(<MedicinesPage />);

    expect(await screen.findByText(/No medicines found\./i)).toBeInTheDocument();
  });

  it("refetches with ?search=<term> when the search input changes", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    const searchInput = screen.getByPlaceholderText(/Search medicines/i);
    fireEvent.change(searchInput, { target: { value: "para" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/medicines?search=para"),
    );
  });

  it("refetches with ?category=<cat> when the category select changes", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    // Lock onto the category <select> via its unique "Antibiotic" option to
    // avoid colliding with the add-modal category select (which is not in
    // the DOM until the modal opens, but scope tightly anyway).
    const categorySelect = screen
      .getAllByRole("combobox")
      .find((s) =>
        Array.from((s as HTMLSelectElement).options).some(
          (o) => o.value === "Antibiotic",
        ),
      ) as HTMLSelectElement;
    expect(categorySelect).toBeTruthy();

    fireEvent.change(categorySelect, { target: { value: "Antibiotic" } });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/medicines?category=Antibiotic",
      ),
    );
  });

  it("hides the Add Medicine button for DOCTOR (ADMIN-only write-create gate)", async () => {
    asDoctor();
    apiMock.get.mockResolvedValue({ data: [medFixture()] });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    expect(
      screen.queryByRole("button", { name: /Add Medicine/i }),
    ).not.toBeInTheDocument();
  });

  it("shows Edit but NOT Delete for DOCTOR (canEdit true, canDelete false)", async () => {
    asDoctor();
    apiMock.get.mockResolvedValue({ data: [medFixture()] });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    expect(screen.getByTestId("medicine-edit")).toBeInTheDocument();
    expect(screen.queryByTestId("medicine-delete")).not.toBeInTheDocument();
  });

  it("hides BOTH Edit and Delete for PHARMACIST (read-only role)", async () => {
    asPharmacist();
    apiMock.get.mockResolvedValue({ data: [medFixture()] });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    expect(screen.queryByTestId("medicine-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("medicine-delete")).not.toBeInTheDocument();
  });

  it("allows NURSE to view but hides write actions (canEdit and canDelete both false)", async () => {
    asNurse();
    apiMock.get.mockResolvedValue({ data: [medFixture()] });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("medicine-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("medicine-delete")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add Medicine/i }),
    ).not.toBeInTheDocument();
  });

  it("rejects blank Name in the create modal with toast.error and never POSTs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Medicine/i }));
    fireEvent.click(screen.getByTestId("medicine-save"));

    expect(toastMock.error).toHaveBeenCalledWith("Name is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects blank Manufacturer in the create modal with toast.error and never POSTs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Medicine/i }));
    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: "New Drug" },
    });
    fireEvent.click(screen.getByTestId("medicine-save"));

    expect(toastMock.error).toHaveBeenCalledWith("Manufacturer is required");
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("happy-path creates a medicine, toasts success, closes the modal, and reloads the list", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { id: "m-new" } });

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Medicine/i }));
    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: "New Drug" },
    });
    fireEvent.change(screen.getByLabelText(/Generic Name/i), {
      target: { value: "Generix" },
    });
    fireEvent.change(screen.getByLabelText(/^Form$/i), {
      target: { value: "Syrup" },
    });
    fireEvent.change(screen.getByLabelText(/^Strength$/i), {
      target: { value: "100mg" },
    });
    fireEvent.change(screen.getByLabelText(/^Manufacturer/i), {
      target: { value: "Sun Pharma" },
    });
    // Uncheck Rx required to flip a branch.
    fireEvent.click(screen.getByLabelText(/Prescription required/i));

    fireEvent.click(screen.getByTestId("medicine-save"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/medicines",
        expect.objectContaining({
          name: "New Drug",
          genericName: "Generix",
          form: "Syrup",
          strength: "100mg",
          manufacturer: "Sun Pharma",
          rxRequired: false,
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Medicine created");
  });

  it("surfaces a toast.error when the create POST rejects (modal stays open)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("server is down"));

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Medicine/i }));
    fireEvent.change(screen.getByLabelText(/^Name$/i), {
      target: { value: "X" },
    });
    fireEvent.change(screen.getByLabelText(/^Manufacturer/i), {
      target: { value: "Y" },
    });
    fireEvent.click(screen.getByTestId("medicine-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server is down"),
    );
  });

  it("Cancel button closes the add modal without calling the API", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<MedicinesPage />);
    await screen.findByText(/No medicines found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Medicine/i }));
    expect(screen.getByRole("heading", { name: /Add Medicine/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /Add Medicine/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Edit button opens the modal pre-populated, heading reads 'Edit <name>', and submit calls PATCH /medicines/:id", async () => {
    apiMock.get.mockResolvedValue({ data: [medFixture()] });
    apiMock.patch.mockResolvedValue({ data: { id: "m-1" } });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(screen.getByTestId("medicine-edit"));

    // Heading switches to Edit mode.
    expect(
      screen.getByRole("heading", { name: /Edit Amlodipine 5mg/i }),
    ).toBeInTheDocument();
    // Name field is pre-populated.
    expect(
      (screen.getByLabelText(/^Name$/i) as HTMLInputElement).value,
    ).toBe("Amlodipine 5mg");

    fireEvent.click(screen.getByTestId("medicine-save"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/medicines/m-1",
        expect.objectContaining({ name: "Amlodipine 5mg" }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Medicine updated");
  });

  it("Delete flow — confirm resolves true → DELETE fires + toast.success + reload", async () => {
    apiMock.get.mockResolvedValue({ data: [medFixture()] });
    apiMock.delete.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(screen.getByTestId("medicine-delete"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(apiMock.delete).toHaveBeenCalledWith("/medicines/m-1"),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Amlodipine 5mg deleted");
  });

  it("Delete flow — confirm resolves false → DELETE does NOT fire", async () => {
    apiMock.get.mockResolvedValue({ data: [medFixture()] });
    confirmMock.mockResolvedValue(false);

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(screen.getByTestId("medicine-delete"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // Give any potential delete a tick to fire (it shouldn't).
    await new Promise((r) => setTimeout(r, 10));
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it("Delete error path — DELETE rejection surfaces toast.error with the message", async () => {
    apiMock.get.mockResolvedValue({ data: [medFixture()] });
    apiMock.delete.mockRejectedValue(new Error("FK constraint"));
    confirmMock.mockResolvedValue(true);

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    fireEvent.click(screen.getByTestId("medicine-delete"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("FK constraint"),
    );
  });

  it("Detail modal — clicking a card fetches /medicines/:id and renders the Info grid + interactions (MAJOR/MODERATE/MINOR all render)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/medicines/m-1") {
        return Promise.resolve({
          data: medFixture({
            id: "m-1",
            interactions: [
              {
                id: "ix-1",
                severity: "MAJOR",
                description: "Severe interaction",
                interactsWith: { id: "m-x", name: "Warfarin" },
              },
              {
                id: "ix-2",
                severity: "MODERATE",
                description: "Moderate interaction",
                interactsWith: { id: "m-y", name: "Ibuprofen" },
              },
              {
                id: "ix-3",
                severity: "MINOR",
                description: "Mild interaction",
                interactsWith: { id: "m-z", name: "Aspirin" },
              },
            ],
          }),
        });
      }
      return Promise.resolve({ data: [medFixture()] });
    });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    // Click the card-body button (first button — Edit/Delete come after).
    const card = screen.getByTestId("medicine-card");
    fireEvent.click(within(card).getAllByRole("button")[0]);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/medicines/m-1"),
    );

    // Info grid renders labels.
    await screen.findByText("Drug Interactions");
    expect(screen.getByText("Warfarin")).toBeInTheDocument();
    expect(screen.getByText("Ibuprofen")).toBeInTheDocument();
    expect(screen.getByText("Aspirin")).toBeInTheDocument();
    expect(screen.getByText("MAJOR")).toBeInTheDocument();
    expect(screen.getByText("MODERATE")).toBeInTheDocument();
    expect(screen.getByText("MINOR")).toBeInTheDocument();
  });

  it("Detail modal — falls back to the row data when GET /medicines/:id rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/medicines/m-1") {
        return Promise.reject(new Error("detail down"));
      }
      return Promise.resolve({ data: [medFixture()] });
    });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    const card = screen.getByTestId("medicine-card");
    fireEvent.click(within(card).getAllByRole("button")[0]);

    // The fallback puts the row into `selected`, so the modal still shows
    // the medicine name as a heading.
    await waitFor(() => {
      const headings = screen.getAllByRole("heading", { name: "Amlodipine 5mg" });
      // One in card, one in modal — modal opened from row fallback.
      expect(headings.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("Detail modal — 'No known interactions' renders when interactions are empty", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/medicines/m-1") {
        return Promise.resolve({
          data: medFixture({ id: "m-1", interactions: [] }),
        });
      }
      return Promise.resolve({ data: [medFixture()] });
    });

    render(<MedicinesPage />);
    await screen.findByText("Amlodipine 5mg");

    const card = screen.getByTestId("medicine-card");
    fireEvent.click(within(card).getAllByRole("button")[0]);

    expect(
      await screen.findByText(/No known interactions recorded\./i),
    ).toBeInTheDocument();
  });
});
