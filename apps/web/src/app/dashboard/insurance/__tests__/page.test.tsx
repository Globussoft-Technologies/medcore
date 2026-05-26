/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * InsuranceProvidersPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/insurance/page.tsx, the
 *     admin Insurance Providers (TPA partners) onboarding screen.
 *     Endpoints:
 *       GET   /insurance-providers                           (list rows)
 *       POST  /insurance-providers                           (Add modal)
 *       PATCH /insurance-providers/:id                       (Edit modal)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-allowlisted role (DOCTOR) triggers router.replace
 *          to /dashboard/not-authorized with the encoded `from` qs.
 *       2. Auth-loading shows the spinner branch (no fetch).
 *       3. ADMIN renders chrome + fires the list GET on mount; Add
 *          button is visible.
 *       4. RECEPTION can list but does NOT see Add / row Edit buttons.
 *       5. Loading branch renders the SkeletonTable wrapper.
 *       6. Empty branch renders the dashed-border CTA.
 *       7. Happy fetch renders one row per provider with name/code/
 *          contact stack + Active vs Inactive pill colours.
 *       8. Initial GET rejection toasts the error and flips loading off
 *          (no rows, empty branch).
 *       9. Add modal opens, validates per-field (name length, code
 *          pattern, email shape, phone shape) → no POST fired.
 *      10. Add modal happy path POSTs the normalised body (code
 *          uppercased, blank optionals dropped), closes, reloads.
 *      11. Add modal POST "already exists" surfaces inline code error;
 *          other Errors surface via toast.error.
 *      12. Add modal Cancel + X buttons both close without POSTing.
 *      13. Edit modal opens pre-filled, PATCHes /:id with full body
 *          including isActive toggle.
 *      14. Edit modal validation parity (name/code/email/phone) blocks
 *          PATCH.
 *      15. Edit modal PATCH "already exists" → inline code error; other
 *          Errors → toast.error.
 *      16. Edit modal isActive checkbox toggles the body.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation, @/components/Skeleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/insurance",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import InsuranceProvidersPage from "../page";

type Row = {
  id: string;
  name: string;
  code: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  coverageDetails: string | null;
  isActive: boolean;
};

function rowFixture(overrides: Partial<Row> = {}): Row {
  return {
    id: "ip-1",
    name: "Star Health Insurance",
    code: "STAR_HEALTH",
    contactPerson: "Rina Sharma",
    contactEmail: "rina@starhealth.in",
    contactPhone: "+91 9876543210",
    coverageDetails: "Cashless across 10000+ hospitals; copay 10%.",
    isActive: true,
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin",
      email: "admin@test.local",
    },
    isLoading: false,
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: {
      id: "u-recep",
      userId: "u-recep",
      role: "RECEPTION",
      name: "Recep",
      email: "recep@test.local",
    },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: {
      id: "u-doc",
      userId: "u-doc",
      role: "DOCTOR",
      name: "Doc",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

function asAuthLoading() {
  authMock.mockReturnValue({ user: null, isLoading: true });
}

describe("Insurance Providers dashboard page (admin TPA onboarding)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects DOCTOR to /dashboard/not-authorized with the encoded from qs", async () => {
    asDoctor();

    render(<InsuranceProvidersPage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Finsurance",
      ),
    );
    // Page should NOT have fired the list fetch for an unauthorised role.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the auth-loading spinner branch (no fetch fired)", () => {
    asAuthLoading();

    const { container } = render(<InsuranceProvidersPage />);

    // Loader2 has the animate-spin class.
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders chrome + fires the list GET on mount for ADMIN", async () => {
    render(<InsuranceProvidersPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/insurance-providers"),
    );
    expect(
      screen.getByRole("heading", { name: /Insurance Providers/i }),
    ).toBeInTheDocument();
    // Admin sees the Add button.
    expect(
      screen.getByTestId("insurance-provider-add-button"),
    ).toBeInTheDocument();
  });

  it("RECEPTION can list but does NOT see the Add Provider button", async () => {
    asReception();
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<InsuranceProvidersPage />);

    await screen.findByText("Star Health Insurance");
    expect(
      screen.queryByTestId("insurance-provider-add-button"),
    ).not.toBeInTheDocument();
    // No per-row Edit either.
    expect(screen.queryByTestId("provider-edit-ip-1")).not.toBeInTheDocument();
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<InsuranceProvidersPage />);

    expect(
      screen.getByTestId("insurance-providers-loading"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the empty-state CTA when the list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<InsuranceProvidersPage />);

    expect(
      await screen.findByTestId("insurance-providers-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No insurance providers onboarded yet/i),
    ).toBeInTheDocument();
    // Admin sees the inline CTA hint.
    expect(
      screen.getByText(/Click.*to onboard your first TPA/i),
    ).toBeInTheDocument();
  });

  it("singular copy `1 provider onboarded` when exactly one row", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<InsuranceProvidersPage />);

    expect(await screen.findByText(/1 provider onboarded/i)).toBeInTheDocument();
  });

  it("renders one row per provider with name/code/contact stack + Active pill", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        rowFixture(),
        rowFixture({
          id: "ip-2",
          name: "Care Health",
          code: "CARE_HEALTH",
          isActive: false,
          coverageDetails: null,
          contactPerson: "Vikram Singh",
          contactEmail: "vikram@carehealth.in",
          contactPhone: "+91 9000000001",
        }),
      ],
    });

    render(<InsuranceProvidersPage />);

    expect(await screen.findByText("Star Health Insurance")).toBeInTheDocument();
    expect(screen.getByText("Care Health")).toBeInTheDocument();
    expect(screen.getByText("STAR_HEALTH")).toBeInTheDocument();
    expect(screen.getByText("CARE_HEALTH")).toBeInTheDocument();
    expect(screen.getByText("Rina Sharma")).toBeInTheDocument();
    expect(screen.getByText("rina@starhealth.in")).toBeInTheDocument();
    expect(screen.getByText("+91 9876543210")).toBeInTheDocument();

    // Pills: one Active (green), one Inactive (gray).
    const active = screen.getByText("Active");
    const inactive = screen.getByText("Inactive");
    expect(active.className).toMatch(/bg-emerald-100/);
    expect(inactive.className).toMatch(/bg-gray-200/);

    // Missing coverage falls back to em-dash.
    expect(screen.getByText("—")).toBeInTheDocument();
    // Two rows.
    expect(screen.getAllByTestId("insurance-provider-row")).toHaveLength(2);
  });

  it("surfaces toast.error and shows the empty branch when the initial GET rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));

    render(<InsuranceProvidersPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server down"),
    );
    expect(
      screen.getByTestId("insurance-providers-empty"),
    ).toBeInTheDocument();
  });

  it("Add modal opens, validates name min-length + code pattern → no POST", async () => {
    render(<InsuranceProvidersPage />);

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    expect(screen.getByTestId("insurance-provider-add-modal")).toBeInTheDocument();

    // Bad: name="A" (too short), code="1bad" (must start with letter).
    fireEvent.change(screen.getByTestId("provider-name"), {
      target: { value: "A" },
    });
    fireEvent.change(screen.getByTestId("provider-code"), {
      target: { value: "1bad" },
    });
    fireEvent.click(screen.getByTestId("provider-save"));

    expect(
      await screen.findByText(/Provider name is required \(min 2 chars\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Code must be 2.31 chars/i),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add modal flags bad email and bad phone shape (no POST)", async () => {
    render(<InsuranceProvidersPage />);

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    fireEvent.change(screen.getByTestId("provider-name"), {
      target: { value: "Acme TPA" },
    });
    fireEvent.change(screen.getByTestId("provider-code"), {
      target: { value: "ACME" },
    });
    fireEvent.change(screen.getByTestId("provider-contact-email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByTestId("provider-contact-phone"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByTestId("provider-save"));

    expect(
      await screen.findByText(/Enter a valid email address/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Enter a valid phone number/i),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add modal happy path POSTs normalised body (uppercased code, dropped blanks), closes, reloads", async () => {
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<InsuranceProvidersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    fireEvent.change(screen.getByTestId("provider-name"), {
      target: { value: "  Acme TPA  " },
    });
    fireEvent.change(screen.getByTestId("provider-code"), {
      // Source uppercases onChange, but trim happens on submit too.
      target: { value: "acme_tpa" },
    });
    fireEvent.change(screen.getByTestId("provider-coverage"), {
      target: { value: "Cashless network" },
    });
    // Leave contactPerson/email/phone blank → must be omitted from body.

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("provider-save"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/insurance-providers");
    expect(body).toEqual({
      name: "Acme TPA",
      code: "ACME_TPA",
      contactPerson: undefined,
      contactEmail: undefined,
      contactPhone: undefined,
      coverageDetails: "Cashless network",
    });

    expect(toastMock.success).toHaveBeenCalledWith("Provider onboarded.");

    // Modal closed.
    await waitFor(() =>
      expect(
        screen.queryByTestId("insurance-provider-add-modal"),
      ).not.toBeInTheDocument(),
    );
    // Reload fired.
    expect(apiMock.get).toHaveBeenCalledWith("/insurance-providers");
  });

  it("Add modal POST `already exists` surfaces inline code error (no toast)", async () => {
    apiMock.post.mockRejectedValue(
      new Error("Insurance provider already exists with that code"),
    );

    render(<InsuranceProvidersPage />);

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    fireEvent.change(screen.getByTestId("provider-name"), {
      target: { value: "Acme TPA" },
    });
    fireEvent.change(screen.getByTestId("provider-code"), {
      target: { value: "ACME" },
    });
    fireEvent.click(screen.getByTestId("provider-save"));

    expect(
      await screen.findByText(/Provider code already exists/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
    // Modal still open.
    expect(
      screen.getByTestId("insurance-provider-add-modal"),
    ).toBeInTheDocument();
  });

  it("Add modal POST generic Error surfaces toast.error and keeps modal open", async () => {
    apiMock.post.mockRejectedValue(new Error("backend on fire"));

    render(<InsuranceProvidersPage />);

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    fireEvent.change(screen.getByTestId("provider-name"), {
      target: { value: "Acme TPA" },
    });
    fireEvent.change(screen.getByTestId("provider-code"), {
      target: { value: "ACME" },
    });
    fireEvent.click(screen.getByTestId("provider-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("backend on fire"),
    );
    expect(
      screen.getByTestId("insurance-provider-add-modal"),
    ).toBeInTheDocument();
  });

  it("Add modal Cancel button closes without POSTing", async () => {
    render(<InsuranceProvidersPage />);

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    expect(
      screen.getByTestId("insurance-provider-add-modal"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByTestId("insurance-provider-add-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add modal header X button closes without POSTing", async () => {
    render(<InsuranceProvidersPage />);

    fireEvent.click(screen.getByTestId("insurance-provider-add-button"));
    const modal = screen.getByTestId("insurance-provider-add-modal");
    // Scope the Close lookup to inside the modal to avoid colliding with
    // any future global "Close" affordances.
    const closeBtn = modal.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement;
    fireEvent.click(closeBtn);

    await waitFor(() =>
      expect(
        screen.queryByTestId("insurance-provider-add-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Edit modal opens pre-filled and PATCHes the full body including isActive", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<InsuranceProvidersPage />);
    await screen.findByText("Star Health Insurance");

    fireEvent.click(screen.getByTestId("provider-edit-ip-1"));
    expect(
      screen.getByTestId("insurance-provider-edit-modal"),
    ).toBeInTheDocument();

    const nameInput = screen.getByTestId("edit-provider-name") as HTMLInputElement;
    const codeInput = screen.getByTestId("edit-provider-code") as HTMLInputElement;
    expect(nameInput.value).toBe("Star Health Insurance");
    expect(codeInput.value).toBe("STAR_HEALTH");

    // Edit the name + flip the active checkbox.
    fireEvent.change(nameInput, { target: { value: "Star Health Renamed" } });
    fireEvent.click(screen.getByTestId("edit-provider-active"));

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("edit-provider-save"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.patch.mock.calls[0];
    expect(url).toBe("/insurance-providers/ip-1");
    expect(body).toEqual({
      name: "Star Health Renamed",
      code: "STAR_HEALTH",
      contactPerson: "Rina Sharma",
      contactEmail: "rina@starhealth.in",
      contactPhone: "+91 9876543210",
      coverageDetails: "Cashless across 10000+ hospitals; copay 10%.",
      isActive: false,
    });
    expect(toastMock.success).toHaveBeenCalledWith("Provider updated.");

    // Modal closed + reload fired.
    await waitFor(() =>
      expect(
        screen.queryByTestId("insurance-provider-edit-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/insurance-providers");
  });

  it("Edit modal validation parity blocks PATCH on bad name / code / email / phone", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<InsuranceProvidersPage />);
    await screen.findByText("Star Health Insurance");

    fireEvent.click(screen.getByTestId("provider-edit-ip-1"));
    fireEvent.change(screen.getByTestId("edit-provider-name"), {
      target: { value: "A" },
    });
    fireEvent.change(screen.getByTestId("edit-provider-code"), {
      target: { value: "1bad" },
    });
    // Find the contact email + phone inputs by their id (the Edit
    // dialog doesn't testid these two — they were added pre-#692
    // convention).
    const emailInput = document.getElementById(
      "edit-provider-contact-email",
    ) as HTMLInputElement;
    const phoneInput = document.getElementById(
      "edit-provider-contact-phone",
    ) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "nope" } });
    fireEvent.change(phoneInput, { target: { value: "abc" } });

    fireEvent.click(screen.getByTestId("edit-provider-save"));

    expect(
      await screen.findByText(/Provider name is required \(min 2 chars\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Code must be 2.31 chars/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Enter a valid email address/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Enter a valid phone number/i),
    ).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Edit modal PATCH `already exists` surfaces inline code error (no toast)", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });
    apiMock.patch.mockRejectedValue(
      new Error("Insurance provider already exists with that code"),
    );

    render(<InsuranceProvidersPage />);
    await screen.findByText("Star Health Insurance");

    fireEvent.click(screen.getByTestId("provider-edit-ip-1"));
    fireEvent.click(screen.getByTestId("edit-provider-save"));

    expect(
      await screen.findByText(/Provider code already exists/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Edit modal PATCH generic Error surfaces toast.error and keeps modal open", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });
    apiMock.patch.mockRejectedValue(new Error("update blew up"));

    render(<InsuranceProvidersPage />);
    await screen.findByText("Star Health Insurance");

    fireEvent.click(screen.getByTestId("provider-edit-ip-1"));
    fireEvent.click(screen.getByTestId("edit-provider-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("update blew up"),
    );
    expect(
      screen.getByTestId("insurance-provider-edit-modal"),
    ).toBeInTheDocument();
  });

  it("Edit modal Cancel + X buttons both close without PATCHing", async () => {
    apiMock.get.mockResolvedValue({ data: [rowFixture()] });

    render(<InsuranceProvidersPage />);
    await screen.findByText("Star Health Insurance");

    // Cancel.
    fireEvent.click(screen.getByTestId("provider-edit-ip-1"));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("insurance-provider-edit-modal"),
      ).not.toBeInTheDocument(),
    );

    // Re-open and use the header X.
    fireEvent.click(screen.getByTestId("provider-edit-ip-1"));
    const modal = screen.getByTestId("insurance-provider-edit-modal");
    const closeBtn = modal.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement;
    fireEvent.click(closeBtn);
    await waitFor(() =>
      expect(
        screen.queryByTestId("insurance-provider-edit-modal"),
      ).not.toBeInTheDocument(),
    );

    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Edit modal omits blank optionals (drops to undefined) from PATCH body", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        rowFixture({
          id: "ip-blank",
          contactPerson: null,
          contactEmail: null,
          contactPhone: null,
          coverageDetails: null,
        }),
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<InsuranceProvidersPage />);
    await screen.findByText("Star Health Insurance");

    fireEvent.click(screen.getByTestId("provider-edit-ip-blank"));
    fireEvent.click(screen.getByTestId("edit-provider-save"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.patch.mock.calls[0];
    expect(body).toMatchObject({
      contactPerson: undefined,
      contactEmail: undefined,
      contactPhone: undefined,
      coverageDetails: undefined,
      isActive: true,
    });
  });
});
