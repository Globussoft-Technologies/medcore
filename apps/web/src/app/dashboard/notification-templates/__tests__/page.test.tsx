/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NotificationTemplatesPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/notification-templates/page.tsx`,
 *     an ADMIN-only client component that renders a NOTIFICATION_TYPES × CHANNELS
 *     matrix of template cells from `GET /notifications/templates` and offers
 *     per-cell create (POST) / update (PUT) via a modal editor.
 *   - Behaviours covered:
 *       1. Loading branch — `data-testid="notification-templates-loading"` +
 *          `aria-busy="true"` wrapper renders while the first fetch is in flight.
 *       2. Happy fetch — every row in NOTIFICATION_TYPES renders; cells with a
 *          matching template render "Edit"; cells without render "Add".
 *       3. Empty fetch — when API returns [], every cell renders "Add" (no Edit).
 *       4. Error fallback — `api.get` rejection is swallowed by inline try/catch
 *          so the matrix still renders (all "Add" buttons).
 *       5. Add (create) flow — clicking an "Add" cell opens the modal pre-filled
 *          with DEFAULT_BODIES content for that type; Save POSTs to
 *          `/notifications/templates` with the editor payload, toasts success,
 *          closes the modal, and reloads.
 *       6. Edit (update) flow — clicking an "Edit" cell on an existing template
 *          opens the modal with that template's id; Save PUTs to
 *          `/notifications/templates/:id` with only the editable fields.
 *       7. EMAIL channel — modal shows the Subject input only when channel === "EMAIL".
 *       8. Cancel — clicking Cancel closes the modal without an API call.
 *       9. Save error path — POST rejection fires an error toast with the
 *          thrown message; uses the `err instanceof Error` branch.
 *      10. Save error non-Error path — falls back to "Save failed" generic copy.
 *      11. Active checkbox toggles — flipping isActive is reflected in the save
 *          payload.
 *      12. RBAC — non-ADMIN user (DOCTOR / PATIENT) triggers
 *          `router.push('/dashboard')`. Null user → no push (pre-auth race).
 *
 *   - Source under test: apps/web/src/app/dashboard/notification-templates/page.tsx
 *   - Mocks: @/lib/api (api.get + api.post + api.put), @/lib/store (useAuthStore),
 *            @/lib/toast (toast.success / toast.error),
 *            next/navigation (useRouter), @/components/Skeleton (SkeletonTable
 *            passthrough).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";

const { apiMock, authMock, routerMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/notification-templates",
}));
// SkeletonTable passthrough — the real impl isn't under test.
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div data-testid="skeleton-table" data-rows={rows ?? 0} data-columns={columns ?? 0} />
  ),
}));

import NotificationTemplatesPage from "../page";

// Source uses `const { user } = useAuthStore()` (object-destructure, no
// selector callback) — so the mock returns the state object directly.
function setAuth(user: { id?: string; name?: string; email?: string; role?: string } | null) {
  authMock.mockReturnValue({ user });
}

function template(overrides: Partial<{
  id: string;
  type: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  isActive: boolean;
}> = {}) {
  return {
    id: "tpl-1",
    type: "APPOINTMENT_BOOKED",
    channel: "WHATSAPP",
    name: "Appointment Booked - WhatsApp",
    subject: null,
    body: "Hi {{patientName}}, your appointment with {{doctorName}} is booked for {{date}} at {{time}}.",
    isActive: true,
    ...overrides,
  };
}

// Helper: find the table row for a given notification TYPE, then return the
// button inside the cell at the given CHANNEL column index.
function getCellButton(type: string, channelIndex: number): HTMLElement {
  const typeCell = screen.getByText(type);
  const row = typeCell.closest("tr");
  if (!row) throw new Error(`Row for type ${type} not found`);
  // First <td> is the type label; channels start at index 1.
  const cells = row.querySelectorAll("td");
  const cell = cells[channelIndex + 1];
  if (!cell) throw new Error(`Cell for type ${type} channel index ${channelIndex} not found`);
  const button = cell.querySelector("button");
  if (!button) throw new Error(`Button in cell ${type}/${channelIndex} not found`);
  return button as HTMLElement;
}

describe("NotificationTemplatesPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    routerMock.push.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockReset();
    // Default: ADMIN user — RBAC effect is a no-op.
    setAuth({ id: "u-admin", name: "Admin", email: "a@x.com", role: "ADMIN" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton + aria-busy wrapper while the first fetch is in flight", async () => {
    // Never-settling promise keeps the component in the loading branch.
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<NotificationTemplatesPage />);

    const loadingWrapper = await screen.findByTestId(
      "notification-templates-loading"
    );
    expect(loadingWrapper).toBeInTheDocument();
    expect(loadingWrapper).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-table")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /notification templates/i })
    ).toBeInTheDocument();
  });

  it("renders the matrix with Edit on existing templates and Add on empty cells", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        template({
          id: "tpl-booked-wa",
          type: "APPOINTMENT_BOOKED",
          channel: "WHATSAPP",
        }),
        template({
          id: "tpl-token-sms",
          type: "TOKEN_CALLED",
          channel: "SMS",
          body: "Token {{tokenNumber}} — please proceed to {{room}}.",
        }),
      ],
    });

    render(<NotificationTemplatesPage />);

    // Initial fetch hits the templates endpoint exactly once.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });

    // All NOTIFICATION_TYPES rows present (sample a few).
    expect(await screen.findByText("APPOINTMENT_BOOKED")).toBeInTheDocument();
    expect(screen.getByText("TOKEN_CALLED")).toBeInTheDocument();
    expect(screen.getByText("LAB_RESULT_READY")).toBeInTheDocument();

    // Channel headers all rendered.
    expect(screen.getByRole("columnheader", { name: "WHATSAPP" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "SMS" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "EMAIL" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "PUSH" })).toBeInTheDocument();

    // Exactly two Edit buttons (the two seeded templates).
    const editButtons = screen.getAllByRole("button", { name: /^edit$/i });
    expect(editButtons).toHaveLength(2);

    // All other 13×4 − 2 = 50 cells are Add buttons.
    const addButtons = screen.getAllByRole("button", { name: /^add$/i });
    expect(addButtons).toHaveLength(13 * 4 - 2);

    // Loading marker has cleared.
    expect(
      screen.queryByTestId("notification-templates-loading")
    ).not.toBeInTheDocument();
  });

  it("renders all Add buttons when the API returns an empty array", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });

    // 13 types × 4 channels = 52 Add cells.
    const addButtons = await screen.findAllByRole("button", { name: /^add$/i });
    expect(addButtons).toHaveLength(52);
    // Zero Edit buttons.
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it("falls back to the empty matrix when the GET rejects (inner try/catch swallows)", async () => {
    apiMock.get.mockRejectedValue(new Error("API down"));

    render(<NotificationTemplatesPage />);

    // The page's inline `catch { /* ignore */ }` flips loading off WITHOUT
    // re-throwing — so the all-Add matrix still renders.
    const addButtons = await screen.findAllByRole("button", { name: /^add$/i });
    expect(addButtons).toHaveLength(52);
    // No toast surfaces on initial-load failure.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Add cell opens the modal pre-filled with DEFAULT_BODIES content and POSTs on Save", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<NotificationTemplatesPage />);

    // Wait for the matrix to render.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });

    // Click the APPOINTMENT_BOOKED × WHATSAPP cell (channel index 0).
    await screen.findByText("APPOINTMENT_BOOKED");
    fireEvent.click(getCellButton("APPOINTMENT_BOOKED", 0));

    // Modal heading reflects the type/channel pair.
    expect(
      await screen.findByRole("heading", { name: /APPOINTMENT_BOOKED — WHATSAPP/i })
    ).toBeInTheDocument();

    // Body textarea pre-filled with the DEFAULT_BODIES copy.
    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toContain("{{patientName}}");
    expect(bodyInput.value).toContain("{{doctorName}}");

    // Name pre-filled with the type/channel composite.
    const nameInput = screen.getByLabelText(/template name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("APPOINTMENT_BOOKED - WHATSAPP");

    // EMAIL-only Subject input must NOT render for WHATSAPP.
    expect(screen.queryByLabelText(/subject/i)).not.toBeInTheDocument();

    // Click Save.
    const initialGetCount = apiMock.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/notifications/templates",
        expect.objectContaining({
          type: "APPOINTMENT_BOOKED",
          channel: "WHATSAPP",
          name: "APPOINTMENT_BOOKED - WHATSAPP",
          body: expect.stringContaining("{{patientName}}"),
          isActive: true,
        })
      );
    });
    // PUT path must not have fired.
    expect(apiMock.put).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Template saved")
    );
    // Reload — at least one more GET fires after save.
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(initialGetCount)
    );
    // Modal closed → heading no longer in DOM.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /APPOINTMENT_BOOKED — WHATSAPP/i })
      ).not.toBeInTheDocument()
    );
  });

  it("Edit cell on an existing template opens with that id and PUTs on Save", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        template({
          id: "tpl-booked-wa",
          type: "APPOINTMENT_BOOKED",
          channel: "WHATSAPP",
          name: "Custom Name",
          body: "Custom body {{patientName}}",
          isActive: true,
        }),
      ],
    });
    apiMock.put.mockResolvedValue({ data: { ok: true } });

    render(<NotificationTemplatesPage />);

    // Wait for the Edit button to appear.
    const editBtn = await screen.findByRole("button", { name: /^edit$/i });
    fireEvent.click(editBtn);

    // Modal pre-filled with the template's existing values.
    const nameInput = screen.getByLabelText(/template name/i) as HTMLInputElement;
    expect(nameInput.value).toBe("Custom Name");
    const bodyInput = screen.getByLabelText(/body/i) as HTMLTextAreaElement;
    expect(bodyInput.value).toBe("Custom body {{patientName}}");

    // Mutate name + uncheck active.
    fireEvent.change(nameInput, { target: { value: "Updated Name" } });
    const activeCheckbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(activeCheckbox.checked).toBe(true);
    fireEvent.click(activeCheckbox);
    expect(activeCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith(
        "/notifications/templates/tpl-booked-wa",
        expect.objectContaining({
          name: "Updated Name",
          body: "Custom body {{patientName}}",
          isActive: false,
        })
      )
    );
    // POST path must not have fired.
    expect(apiMock.post).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Template saved")
    );
  });

  it("renders the Subject input only when the chosen channel is EMAIL", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });

    // CHANNELS = ["WHATSAPP", "SMS", "EMAIL", "PUSH"] → EMAIL is index 2.
    await screen.findByText("APPOINTMENT_BOOKED");
    fireEvent.click(getCellButton("APPOINTMENT_BOOKED", 2));

    expect(
      await screen.findByRole("heading", { name: /APPOINTMENT_BOOKED — EMAIL/i })
    ).toBeInTheDocument();
    // Subject input is only rendered for EMAIL.
    const subjectInput = screen.getByLabelText(/^subject$/i) as HTMLInputElement;
    expect(subjectInput).toBeInTheDocument();
    // Pre-filled with humanised type label.
    expect(subjectInput.value).toBe("APPOINTMENT BOOKED");

    // Mutate subject and save → POST payload carries it.
    fireEvent.change(subjectInput, { target: { value: "Your booking confirmation" } });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/notifications/templates",
        expect.objectContaining({
          channel: "EMAIL",
          subject: "Your booking confirmation",
        })
      )
    );
  });

  it("Cancel button closes the modal without firing any API call", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });
    await screen.findByText("APPOINTMENT_BOOKED");

    fireEvent.click(getCellButton("APPOINTMENT_BOOKED", 0));
    expect(
      await screen.findByRole("heading", { name: /APPOINTMENT_BOOKED — WHATSAPP/i })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /APPOINTMENT_BOOKED — WHATSAPP/i })
      ).not.toBeInTheDocument()
    );
    // Neither POST nor PUT fired.
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it("Save POST rejection fires an error toast carrying the thrown message", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("Validation failed"));

    render(<NotificationTemplatesPage />);

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });
    // Wait for the matrix to render (loading skeleton gone) before the
    // synchronous getCellButton lookup — otherwise it races the fetch.
    await screen.findByText("APPOINTMENT_BOOKED");

    fireEvent.click(getCellButton("APPOINTMENT_BOOKED", 0));
    fireEvent.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Validation failed")
    );
    expect(toastMock.success).not.toHaveBeenCalled();
    // Modal stays open on error.
    expect(
      screen.getByRole("heading", { name: /APPOINTMENT_BOOKED — WHATSAPP/i })
    ).toBeInTheDocument();
  });

  it("Save PUT rejection with a non-Error rejection falls back to the generic message", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        template({
          id: "tpl-x",
          type: "APPOINTMENT_BOOKED",
          channel: "WHATSAPP",
        }),
      ],
    });
    // Reject with a plain string — exercises the `err instanceof Error ? … : "Save failed"` else-branch.
    apiMock.put.mockRejectedValue("boom");

    render(<NotificationTemplatesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Save failed")
    );
  });

  it("redirects non-ADMIN users (e.g. DOCTOR) to /dashboard via router.push", async () => {
    setAuth({ id: "u-doc", name: "Dr. Sharma", email: "d@x.com", role: "DOCTOR" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("redirects PATIENT users to /dashboard via router.push", async () => {
    setAuth({ id: "p1", name: "Asha", email: "a@x.com", role: "PATIENT" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("does NOT redirect when user is null (pre-auth-resolution race window)", async () => {
    setAuth(null);
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates")
    );
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("renders the Type column for every NOTIFICATION_TYPES entry (13 rows)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<NotificationTemplatesPage />);

    // Wait for the load to settle.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/notifications/templates");
    });

    const expected = [
      "APPOINTMENT_BOOKED",
      "APPOINTMENT_REMINDER",
      "APPOINTMENT_CANCELLED",
      "TOKEN_CALLED",
      "PRESCRIPTION_READY",
      "BILL_GENERATED",
      "PAYMENT_RECEIVED",
      "SCHEDULE_SUMMARY",
      "ADMISSION",
      "DISCHARGE",
      "LAB_RESULT_READY",
      "MEDICATION_DUE",
      "LOW_STOCK_ALERT",
    ];
    for (const t of expected) {
      expect(await screen.findByText(t)).toBeInTheDocument();
    }
    // Quick sanity — `within` table body row count equals 13.
    const table = screen.getByRole("table");
    const bodyRows = within(table).getAllByRole("row");
    // 1 header row + 13 body rows = 14.
    expect(bodyRows).toHaveLength(14);
  });
});
