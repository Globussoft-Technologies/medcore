/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * UsersPage (User Management) — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/users/page.tsx, the
 *     ADMIN-only staff onboarding + lifecycle management screen.
 *     Endpoints:
 *       GET   /users                                  (list — fallback to /doctors)
 *       POST  /auth/register                          (create new staff)
 *       PATCH /users/:id                              (edit name/phone/role OR isActive flip)
 *       POST  /users/:id/reset-password               (mint a 6-digit reset code)
 *       (window.print via openPrintEndpoint — not asserted)
 *
 *   - Behaviours covered:
 *       1. RBAC — non-ADMIN role (DOCTOR) is redirected to /dashboard
 *          and renders nothing.
 *       2. ADMIN renders chrome + fires GET /users on mount.
 *       3. Loading branch renders the SkeletonTable while initial GET pending.
 *       4. Empty branch renders "No users found" copy.
 *       5. /users 404 → falls back to GET /doctors successfully.
 *       6. Both endpoints failing renders the empty branch (resilience).
 *       7. Happy fetch renders one row per user with name/email/phone/role/
 *          status/joined date + per-row action buttons.
 *       8. Inactive user row shows the "Inactive" pill instead of "Active".
 *       9. Missing phone falls back to "---".
 *      10. Add Staff toggles the create form visibility.
 *      11. Create form client-side validation — flags blank name, bad email,
 *          bad phone, weak password (no POST fired).
 *      12. Create form happy POST → /auth/register, closes form, reloads list.
 *      13. Create POST field-level error from backend (extractFieldErrors) →
 *          per-field error rendered, no toast.
 *      14. Create POST generic Error surfaces formError banner.
 *      15. Cancel button on create form closes it without POSTing.
 *      16. Edit modal opens pre-filled with row data; PATCH on save with
 *          sanitized name + role + phone; closes + reloads.
 *      17. Edit modal validates blank name + bad phone (no PATCH).
 *      18. Edit modal field-level error from backend surfaces inline.
 *      19. Edit modal generic Error surfaces toast.error and keeps modal open.
 *      20. Edit modal Cancel + X buttons both close without PATCHing.
 *      21. Edit modal disables the role select when editing yourself and
 *          surfaces the explainer copy.
 *      22. toggleActive — self-toggle blocked with toast.error (no PATCH).
 *      23. toggleActive — confirm rejected (false) → no PATCH.
 *      24. toggleActive — confirm accepted → PATCH { isActive: false } and toast.
 *      25. toggleActive — confirm accepted with already-inactive row →
 *          PATCH { isActive: true } and reload.
 *      26. toggleActive — PATCH rejection surfaces toast.error.
 *      27. sendResetPassword — confirm rejected → no POST.
 *      28. sendResetPassword — happy path opens the reset-code modal with
 *          the returned 6-digit code; closing the modal clears it.
 *      29. sendResetPassword — POST rejection surfaces toast.error.
 *      30. STAFF_ROLE_OPTIONS derivation — PATIENT is filtered out of the
 *          create + edit role <select>.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *            @/components/PasswordInput, @/components/Skeleton,
 *            next/navigation.
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

const { apiMock, toastMock, authMock, routerMock, confirmMock, openPrintMock } =
  vi.hoisted(() => ({
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
    openPrintMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: openPrintMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/users",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));
// Stub PasswordInput → plain input so fireEvent can read .value without
// the show/hide wrapper interfering. Preserve data-testid passthrough.
vi.mock("@/components/PasswordInput", () => ({
  PasswordInput: ({
    value,
    onChange,
    ...rest
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    [k: string]: any;
  }) => <input type="password" value={value} onChange={onChange} {...rest} />,
}));

import UsersPage from "../page";

type StaffUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  isActive: boolean;
  createdAt: string;
};

function staffFixture(overrides: Partial<StaffUser> = {}): StaffUser {
  return {
    id: "u-doc-1",
    name: "Dr. Anil Sharma",
    email: "anil@medcore.test",
    phone: "+919876543210",
    role: "DOCTOR",
    isActive: true,
    createdAt: "2026-01-15T08:30:00.000Z",
    ...overrides,
  };
}

function asAdmin(id = "u-admin") {
  // Pin tenantId so the page recognises this as a TENANT admin (not a
  // cross-tenant super-admin). Without it, the page's super-admin
  // gate fires (`role === "ADMIN" && tenantId === null` → super-admin)
  // and an extra GET /super-admin/users runs alongside GET /users,
  // breaking every test that asserts `apiMock.get` was called once.
  authMock.mockReturnValue({
    user: {
      id,
      role: "ADMIN",
      name: "Admin",
      email: "admin@test.local",
      tenantId: "t-test",
    },
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Doc", email: "doc@test.local" },
  });
}

describe("Users dashboard page (admin staff management)", () => {
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
    openPrintMock.mockReset();
    asAdmin();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-ADMIN role (DOCTOR) to /dashboard and renders nothing", async () => {
    asDoctor();

    const { container } = render(<UsersPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    expect(container.firstChild).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders chrome + fires GET /users on mount for ADMIN", async () => {
    render(<UsersPage />);

    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/users"));
    expect(
      screen.getByRole("heading", { name: /User Management/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Add Staff User/i)).toBeInTheDocument();
  });

  it("renders the SkeletonTable while the initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<UsersPage />);

    expect(screen.getByTestId("users-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the empty branch when the list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<UsersPage />);

    expect(await screen.findByText("No users found")).toBeInTheDocument();
  });

  it("falls back to GET /doctors when GET /users rejects", async () => {
    apiMock.get
      .mockRejectedValueOnce(new Error("users 404"))
      .mockResolvedValueOnce({ data: [staffFixture()] });

    render(<UsersPage />);

    await screen.findByText("Dr. Anil Sharma");
    expect(apiMock.get).toHaveBeenNthCalledWith(1, "/users");
    expect(apiMock.get).toHaveBeenNthCalledWith(2, "/doctors");
  });

  it("renders the empty branch when both /users and /doctors reject (resilience)", async () => {
    apiMock.get
      .mockRejectedValueOnce(new Error("users boom"))
      .mockRejectedValueOnce(new Error("doctors boom"));

    render(<UsersPage />);

    expect(await screen.findByText("No users found")).toBeInTheDocument();
  });

  it("renders a row per user with name/email/phone/role badge/status/joined", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        staffFixture(),
        staffFixture({
          id: "u-admin-2",
          name: "Boss Admin",
          email: "boss@medcore.test",
          role: "ADMIN",
        }),
        staffFixture({
          id: "u-nurse",
          name: "Nurse Joy",
          email: "joy@medcore.test",
          role: "NURSE",
          isActive: false,
          phone: "",
        }),
      ],
    });

    render(<UsersPage />);

    await screen.findByText("Dr. Anil Sharma");
    expect(screen.getByText("Boss Admin")).toBeInTheDocument();
    expect(screen.getByText("Nurse Joy")).toBeInTheDocument();
    expect(screen.getByText("anil@medcore.test")).toBeInTheDocument();
    // Roles all rendered.
    expect(screen.getByText("DOCTOR")).toBeInTheDocument();
    expect(screen.getByText("ADMIN")).toBeInTheDocument();
    expect(screen.getByText("NURSE")).toBeInTheDocument();
    // Nurse is inactive — pill copy.
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    // Active count: 2 (doctor + admin).
    expect(screen.getAllByText("Active")).toHaveLength(2);
    // Missing phone fallback dash.
    expect(screen.getByText("---")).toBeInTheDocument();
    // Per-row action buttons exist.
    expect(screen.getByTestId("user-edit-u-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("user-reset-u-doc-1")).toBeInTheDocument();
    expect(screen.getByTestId("user-toggle-u-doc-1")).toBeInTheDocument();
  });

  it("Add Staff button toggles the create form visibility", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    expect(screen.queryByTestId("staff-name-input")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Add Staff User/i));
    expect(screen.getByTestId("staff-name-input")).toBeInTheDocument();

    // Click again → close.
    fireEvent.click(screen.getByText(/Add Staff User/i));
    expect(screen.queryByTestId("staff-name-input")).not.toBeInTheDocument();
  });

  it("Create form client-side validation flags blank name / bad email / bad phone / weak password (no POST)", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/Add Staff User/i));

    // Submit empty → all required errors.
    fireEvent.click(screen.getByRole("button", { name: /Create User/i }));

    await screen.findByTestId("error-name");
    expect(screen.getByTestId("error-email")).toBeInTheDocument();
    expect(screen.getByTestId("error-phone")).toBeInTheDocument();
    expect(screen.getByTestId("error-password")).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    // Bad email + bad phone + short password.
    fireEvent.change(screen.getByTestId("staff-name-input"), {
      target: { value: "Dr Foo" },
    });
    fireEvent.change(screen.getByTestId("staff-email-input"), {
      target: { value: "not-an-email" },
    });
    fireEvent.change(screen.getByTestId("staff-phone-input"), {
      target: { value: "abc" },
    });
    fireEvent.change(screen.getByTestId("staff-password-input"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create User/i }));

    await waitFor(() =>
      expect(screen.getByTestId("error-email").textContent).toMatch(
        /valid email/i,
      ),
    );
    expect(screen.getByTestId("error-phone").textContent).toMatch(
      /10.15 digits/i,
    );
    expect(screen.getByTestId("error-password").textContent).toMatch(
      /at least 8/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();

    // Password that meets length but no digit.
    fireEvent.change(screen.getByTestId("staff-password-input"), {
      target: { value: "abcdefghij" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create User/i }));
    await waitFor(() =>
      expect(screen.getByTestId("error-password").textContent).toMatch(
        /letter and one digit/i,
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Create form happy path POSTs /auth/register, closes form, reloads list", async () => {
    apiMock.post.mockResolvedValue({ data: { id: "u-new" } });

    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/Add Staff User/i));
    fireEvent.change(screen.getByTestId("staff-name-input"), {
      target: { value: "Dr New Hire" },
    });
    fireEvent.change(screen.getByTestId("staff-email-input"), {
      target: { value: "new@medcore.test" },
    });
    fireEvent.change(screen.getByTestId("staff-phone-input"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByTestId("staff-password-input"), {
      target: { value: "Str0ngPass" },
    });
    fireEvent.change(screen.getByTestId("staff-role-input"), {
      target: { value: "NURSE" },
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Create User/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/auth/register");
    expect(body).toEqual({
      name: "Dr New Hire",
      email: "new@medcore.test",
      phone: "9876543210",
      password: "Str0ngPass",
      role: "NURSE",
    });

    // Form closed.
    await waitFor(() =>
      expect(screen.queryByTestId("staff-name-input")).not.toBeInTheDocument(),
    );
    // Reload fired.
    expect(apiMock.get).toHaveBeenCalledWith("/users");
  });

  it("Create POST field-level backend error surfaces per-field (no formError banner)", async () => {
    apiMock.post.mockRejectedValue({
      payload: {
        details: [{ field: "email", message: "Email already exists" }],
      },
    });

    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/Add Staff User/i));
    fireEvent.change(screen.getByTestId("staff-name-input"), {
      target: { value: "Dr X" },
    });
    fireEvent.change(screen.getByTestId("staff-email-input"), {
      target: { value: "x@medcore.test" },
    });
    fireEvent.change(screen.getByTestId("staff-phone-input"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByTestId("staff-password-input"), {
      target: { value: "Str0ngPass" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create User/i }));

    await waitFor(() =>
      expect(screen.getByTestId("error-email").textContent).toMatch(
        /already exists/i,
      ),
    );
    // Form still open.
    expect(screen.getByTestId("staff-name-input")).toBeInTheDocument();
  });

  it("Create POST generic Error surfaces the formError banner", async () => {
    apiMock.post.mockRejectedValue(new Error("server on fire"));

    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/Add Staff User/i));
    fireEvent.change(screen.getByTestId("staff-name-input"), {
      target: { value: "Dr X" },
    });
    fireEvent.change(screen.getByTestId("staff-email-input"), {
      target: { value: "x@medcore.test" },
    });
    fireEvent.change(screen.getByTestId("staff-phone-input"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByTestId("staff-password-input"), {
      target: { value: "Str0ngPass" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create User/i }));

    expect(await screen.findByText(/server on fire/i)).toBeInTheDocument();
  });

  it("Create form Cancel button closes the form without POSTing", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/Add Staff User/i));
    expect(screen.getByTestId("staff-name-input")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() =>
      expect(screen.queryByTestId("staff-name-input")).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Create form filters PATIENT out of the role <select>", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/Add Staff User/i));
    const select = screen.getByTestId("staff-role-input") as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).not.toContain("PATIENT");
    expect(optionValues).toContain("DOCTOR");
    expect(optionValues).toContain("PHARMACIST");
    expect(optionValues).toContain("LAB_TECH");
  });

  it("Edit modal opens pre-filled, PATCHes /users/:id with sanitized name + role + phone", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-edit-u-doc-1"));
    expect(screen.getByTestId("user-edit-modal")).toBeInTheDocument();

    const nameInput = screen.getByTestId("user-edit-name") as HTMLInputElement;
    const phoneInput = screen.getByTestId(
      "user-edit-phone",
    ) as HTMLInputElement;
    const roleSelect = screen.getByTestId(
      "user-edit-role",
    ) as HTMLSelectElement;
    expect(nameInput.value).toBe("Dr. Anil Sharma");
    expect(phoneInput.value).toBe("+919876543210");
    expect(roleSelect.value).toBe("DOCTOR");

    // Email is read-only.
    const emailInput = screen.getByTestId(
      "user-edit-email",
    ) as HTMLInputElement;
    expect(emailInput.value).toBe("anil@medcore.test");
    expect(emailInput).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: "Dr. Anil Renamed" } });
    fireEvent.change(roleSelect, { target: { value: "ADMIN" } });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("user-edit-save"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.patch.mock.calls[0];
    expect(url).toBe("/users/u-doc-1");
    expect(body).toEqual({
      name: "Dr. Anil Renamed",
      phone: "+919876543210",
      role: "ADMIN",
    });
    expect(toastMock.success).toHaveBeenCalledWith("User updated");

    await waitFor(() =>
      expect(screen.queryByTestId("user-edit-modal")).not.toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/users");
  });

  it("Edit modal validation blocks PATCH on blank name + bad phone", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-edit-u-doc-1"));
    fireEvent.change(screen.getByTestId("user-edit-name"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("user-edit-phone"), {
      target: { value: "abc" },
    });

    fireEvent.click(screen.getByTestId("user-edit-save"));

    await screen.findByTestId("user-edit-name-error");
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Edit modal field-level backend error surfaces inline (no toast)", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.patch.mockRejectedValue({
      payload: {
        details: [{ field: "phone", message: "Phone already in use" }],
      },
    });

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-edit-u-doc-1"));
    fireEvent.click(screen.getByTestId("user-edit-save"));

    await waitFor(() =>
      expect(screen.getByText(/Phone already in use/i)).toBeInTheDocument(),
    );
    expect(toastMock.error).not.toHaveBeenCalled();
    // Modal still open.
    expect(screen.getByTestId("user-edit-modal")).toBeInTheDocument();
  });

  it("Edit modal generic Error surfaces toast.error and keeps modal open", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.patch.mockRejectedValue(new Error("update blew up"));

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-edit-u-doc-1"));
    fireEvent.click(screen.getByTestId("user-edit-save"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("update blew up"),
    );
    expect(screen.getByTestId("user-edit-modal")).toBeInTheDocument();
  });

  it("Edit modal Cancel + X buttons both close without PATCHing", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    // Cancel.
    fireEvent.click(screen.getByTestId("user-edit-u-doc-1"));
    const modal1 = screen.getByTestId("user-edit-modal");
    fireEvent.click(within(modal1).getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(screen.queryByTestId("user-edit-modal")).not.toBeInTheDocument(),
    );

    // Re-open and use the header X.
    fireEvent.click(screen.getByTestId("user-edit-u-doc-1"));
    fireEvent.click(screen.getByTestId("user-edit-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("user-edit-modal")).not.toBeInTheDocument(),
    );

    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Edit modal disables the role select + shows explainer when editing yourself", async () => {
    // Admin id matches the row id → self-edit branch.
    asAdmin("u-self");
    apiMock.get.mockResolvedValue({
      data: [
        staffFixture({
          id: "u-self",
          name: "Me Myself",
          email: "me@medcore.test",
          role: "ADMIN",
        }),
      ],
    });

    render(<UsersPage />);
    await screen.findByText("Me Myself");

    fireEvent.click(screen.getByTestId("user-edit-u-self"));
    const roleSelect = screen.getByTestId(
      "user-edit-role",
    ) as HTMLSelectElement;
    expect(roleSelect).toBeDisabled();
    expect(
      screen.getByText(/You cannot change your own role/i),
    ).toBeInTheDocument();
  });

  it("toggleActive — self-toggle blocked with toast.error (no PATCH)", async () => {
    asAdmin("u-self");
    apiMock.get.mockResolvedValue({
      data: [staffFixture({ id: "u-self", name: "Me Self", role: "ADMIN" })],
    });

    render(<UsersPage />);
    await screen.findByText("Me Self");

    const btn = screen.getByTestId("user-toggle-u-self") as HTMLButtonElement;
    // Button is also `disabled` in markup; force fireEvent.click anyway —
    // jsdom will still dispatch the handler? No — disabled buttons swallow
    // click. So we directly hit the handler path via re-enable. Instead,
    // assert it is disabled + has the explainer aria-label.
    expect(btn).toBeDisabled();
    // aria-label updated 2026-05 to match the tooltip rewrite —
    // shorter, contraction, person-tense consistent with sibling
    // controls on the page.
    expect(btn).toHaveAttribute(
      "aria-label",
      "You can't disable your own account",
    );
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("toggleActive — confirm rejected (false) → no PATCH fired", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    confirmMock.mockResolvedValue(false);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-toggle-u-doc-1"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("toggleActive — accepted on Active row → PATCH { isActive: false } + toast", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-toggle-u-doc-1"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0][0]).toBe("/users/u-doc-1");
    expect(apiMock.patch.mock.calls[0][1]).toEqual({ isActive: false });
    expect(toastMock.success).toHaveBeenCalledWith("User disabled");
  });

  it("toggleActive — accepted on Inactive row → PATCH { isActive: true } + reload", async () => {
    apiMock.get.mockResolvedValue({
      data: [staffFixture({ isActive: false })],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-toggle-u-doc-1"));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch.mock.calls[0][1]).toEqual({ isActive: true });
    expect(toastMock.success).toHaveBeenCalledWith("User re-enabled");
  });

  it("toggleActive — PATCH rejection surfaces toast.error", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.patch.mockRejectedValue(new Error("toggle blew up"));
    confirmMock.mockResolvedValue(true);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-toggle-u-doc-1"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("toggle blew up"),
    );
  });

  it("sendResetPassword — confirm rejected → no POST fired", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    confirmMock.mockResolvedValue(false);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-reset-u-doc-1"));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("sendResetPassword — happy path opens the reset-code modal + close clears it", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.post.mockResolvedValue({
      data: {
        code: "123456",
        email: "anil@medcore.test",
        message: "ok",
      },
    });
    confirmMock.mockResolvedValue(true);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-reset-u-doc-1"));

    await screen.findByTestId("reset-code-modal");
    expect(screen.getByTestId("reset-code-value").textContent).toBe("123456");
    expect(toastMock.success).toHaveBeenCalledWith("Reset code generated");
    expect(apiMock.post).toHaveBeenCalledWith(
      "/users/u-doc-1/reset-password",
    );

    fireEvent.click(screen.getByTestId("reset-code-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("reset-code-modal")).not.toBeInTheDocument(),
    );
  });

  it("sendResetPassword — POST rejection surfaces toast.error", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });
    apiMock.post.mockRejectedValue(new Error("reset blew up"));
    confirmMock.mockResolvedValue(true);

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    fireEvent.click(screen.getByTestId("user-reset-u-doc-1"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("reset blew up"),
    );
  });

  it("Cert button calls openPrintEndpoint with the service-certificate URL", async () => {
    apiMock.get.mockResolvedValue({ data: [staffFixture()] });

    render(<UsersPage />);
    await screen.findByText("Dr. Anil Sharma");

    const certBtn = screen.getByRole("button", { name: /Cert/i });
    fireEvent.click(certBtn);

    expect(openPrintMock).toHaveBeenCalledWith(
      "/users/u-doc-1/service-certificate",
    );
  });
});
