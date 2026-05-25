// Smoke tests for /dashboard/settings/whatsapp — Pearl §6.1 gap row 167
// piece 3j-i of 4.
//
// Covers:
//   - Provider dropdown renders all 5 options (Gupshup, WATI, AiSensei,
//     Interakt, Meta).
//   - Switching provider swaps the field set (Gupshup → Meta exposes
//     `accessToken`).
//   - Save submits PUT /wa/config with the expected discriminated-union
//     body shape (provider + cred fields nested under `credentials`).
//   - Server 401 surfaces the sign-in nudge.
//   - 44px (h-11) touch invariant on the Save button.
//   - Non-ADMIN role renders the not-allowed surface.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

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

import WhatsAppSettingsPage from "../page";

function asAdmin() {
  authMock.mockImplementation((selector: any) => {
    const state = { user: { id: "u1", role: "ADMIN", name: "Admin", email: "a@x.com" } };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asReception() {
  authMock.mockImplementation((selector: any) => {
    const state = { user: { id: "u2", role: "RECEPTION", name: "R", email: "r@x.com" } };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("WhatsApp settings page — Pearl §6.1 piece 3j-i", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.put.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    apiMock.get.mockResolvedValue({ data: { config: null } });
  });

  it("renders the provider dropdown with all 5 provider options", async () => {
    asAdmin();
    render(<WhatsAppSettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-settings-provider-select")).toBeInTheDocument(),
    );
    const select = screen.getByTestId("wa-settings-provider-select") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["GUPSHUP", "WATI", "AISENSEI", "INTERAKT", "META"]);
  });

  it("switching to Meta swaps the field set (accessToken is shown, Gupshup's apiKey/appName disappear)", async () => {
    asAdmin();
    render(<WhatsAppSettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-settings-field-apiKey")).toBeInTheDocument(),
    );
    // Default = Gupshup
    expect(screen.getByTestId("wa-settings-field-appName")).toBeInTheDocument();
    expect(screen.queryByTestId("wa-settings-field-accessToken")).not.toBeInTheDocument();

    const select = screen.getByTestId("wa-settings-provider-select");
    fireEvent.change(select, { target: { value: "META" } });

    await waitFor(() => {
      expect(screen.getByTestId("wa-settings-field-accessToken")).toBeInTheDocument();
    });
    expect(screen.getByTestId("wa-settings-field-phoneNumberId")).toBeInTheDocument();
    expect(screen.getByTestId("wa-settings-field-appSecret")).toBeInTheDocument();
    expect(screen.getByTestId("wa-settings-field-verifyToken")).toBeInTheDocument();
    // Gupshup-only fields are gone.
    expect(screen.queryByTestId("wa-settings-field-appName")).not.toBeInTheDocument();
  });

  it("Save submits PUT /wa/config with the discriminated-union body shape", async () => {
    asAdmin();
    apiMock.put.mockResolvedValue({ data: { config: { id: "c1" } } });
    render(<WhatsAppSettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-settings-field-apiKey")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("wa-settings-field-apiKey"), {
      target: { value: "sk-test-1" },
    });
    fireEvent.change(screen.getByTestId("wa-settings-field-appName"), {
      target: { value: "hospital_prod" },
    });
    fireEvent.change(screen.getByTestId("wa-settings-field-sourcePhone"), {
      target: { value: "+919876543210" },
    });

    fireEvent.click(screen.getByTestId("wa-settings-save"));

    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledTimes(1);
    });
    const [url, body] = apiMock.put.mock.calls[0];
    expect(url).toBe("/wa/config");
    expect(body).toEqual({
      credentials: {
        provider: "GUPSHUP",
        apiKey: "sk-test-1",
        appName: "hospital_prod",
        sourcePhone: "+919876543210",
      },
      defaultProductId: null,
      autoReply: true,
      active: true,
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("surfaces the sign-in nudge when GET returns 401", async () => {
    asAdmin();
    apiMock.get.mockRejectedValueOnce(new Error("Request failed with 401"));
    render(<WhatsAppSettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-settings-unauth")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-settings-signin-cta")).toBeInTheDocument();
  });

  it("Save button uses an h-11 touch target", async () => {
    asAdmin();
    render(<WhatsAppSettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-settings-save")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-settings-save").className).toMatch(/h-11/);
  });

  it("renders the not-allowed surface for non-ADMIN roles", async () => {
    asReception();
    render(<WhatsAppSettingsPage />);
    expect(screen.getByTestId("wa-settings-not-allowed")).toBeInTheDocument();
    // No provider dropdown for non-admins.
    expect(screen.queryByTestId("wa-settings-provider-select")).not.toBeInTheDocument();
  });
});
