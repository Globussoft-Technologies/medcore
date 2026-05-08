/**
 * apps/web/src/app/dashboard/emergency/intake-modal.test.tsx
 *
 * Issue #576 — Register New Case modal validation hardening.
 *
 * Covers the two web-side concerns from the bug report that are not already
 * covered by the shared-schema test or the API route handler:
 *   1. Empty submit produces inline field errors AND a toast (no longer
 *      "the button does nothing").
 *   2. The arrival-mode dropdown emits the canonical enum values
 *      (WALK_IN / AMBULANCE / POLICE / REFERRED) so a direct API call
 *      from the form cannot bypass the schema-level enum gate.
 *
 * Mocks the API + auth + toast layers — no network, no DB.
 */
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
vi.mock("@/lib/socket", () => ({
  getSocket: () => ({
    connected: true,
    connect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: any) => <a {...rest}>{children}</a>,
}));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import EmergencyPage from "./page";

describe("EmergencyPage Register New Case modal (Issue #576)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // /emergency/cases/active + /emergency/stats + /doctors all return empty.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/emergency/cases/active"))
        return Promise.resolve({ data: [] });
      if (url.startsWith("/emergency/stats"))
        return Promise.resolve({
          data: {
            totalActive: 0,
            totalWaiting: 0,
            byTriage: {},
            avgWaitMin: 0,
            availableBeds: 0,
          },
        });
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: {} });
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", role: "RECEPTION" },
        token: "tok",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("submitting empty modal surfaces inline errors AND a toast (no silent failure)", async () => {
    const user = userEvent.setup();
    render(<EmergencyPage />);

    // Wait for the page to load, then open the intake modal.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /register new case/i })
      ).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /register new case/i })
    );

    // Modal is open, click Register without filling anything.
    await user.click(screen.getByRole("button", { name: /^register$/i }));

    // No API call fired — the validation guards short-circuit the submit.
    expect(apiMock.post).not.toHaveBeenCalled();

    // Toast and inline errors both surface (the modal previously did neither).
    expect(toastMock.error).toHaveBeenCalled();
    // At least one of the two missing-field errors must show inline.
    const inlineErrors = [
      screen.queryByTestId("error-intake-patient"),
      screen.queryByTestId("error-chief-complaint"),
    ].filter(Boolean);
    expect(inlineErrors.length).toBeGreaterThan(0);
  });

  it("arrival-mode dropdown emits canonical enum values (WALK_IN / AMBULANCE / POLICE / REFERRED)", async () => {
    const user = userEvent.setup();
    render(<EmergencyPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /register new case/i })
      ).toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: /register new case/i })
    );

    const select = screen.getByTestId("er-arrival-mode") as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    // Issue #576: previously the option values were the human labels
    // ("Walk-in" etc.) which let a forged direct API call submit any
    // free-text mode. The dropdown now binds to the canonical enum.
    expect(optionValues).toEqual([
      "WALK_IN",
      "AMBULANCE",
      "POLICE",
      "REFERRED",
    ]);
    expect(select.value).toBe("WALK_IN");
  });
});
