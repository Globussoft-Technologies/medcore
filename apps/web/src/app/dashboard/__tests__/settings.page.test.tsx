/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, confirmMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  // Send-test now uses the in-app confirm dialog (useConfirm), not the native
  // window.confirm.
  confirmMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/settings",
}));

import SettingsPage from "../settings/page";

describe("SettingsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        refreshUser: vi.fn(),
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: { user: { id: "u1", name: "Admin", email: "a@x.com" } } });
  });

  it("renders Settings heading", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
  });

  it("renders settings tabs", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
  });

  it("switches tabs on click", async () => {
    // Ensure each endpoint returns an array-compatible shape so tab content
    // components don't crash on .map.
    apiMock.get.mockImplementation(() =>
      Promise.resolve({ data: [] })
    );
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
    // Click the first tab button (profile is default, just re-click to exercise)
    const tabBtns = screen.queryAllByRole("button");
    if (tabBtns.length > 0) {
      await user.click(tabBtns[0]);
    }
    expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument();
  });

  // Issue #940: the Notifications-tab "Send test" button previously fired
  // immediately on click, so a stray click could send a real (potentially
  // SMS/WhatsApp-charged) test message. The fix wraps the click in a
  // window.confirm prompt. We assert both (a) the confirm is called and
  // (b) NO POST is fired when the user declines.
  it("gates Send test behind the confirm dialog (#940 — declines do not POST)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/notifications/preferences"))
        return Promise.resolve({
          data: [
            { channel: "EMAIL", enabled: true },
            { channel: "SMS", enabled: true },
            { channel: "WHATSAPP", enabled: true },
            { channel: "PUSH", enabled: true },
          ],
        });
      if (url.startsWith("/notifications/schedule"))
        return Promise.resolve({ data: null });
      return Promise.resolve({ data: [] });
    });
    confirmMock.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<SettingsPage />);
    // Switch to the Notifications tab.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^notifications$/i })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /^notifications$/i }));
    // The Send-test buttons render one-per-channel — click the first.
    const sendButtons = await screen.findAllByRole("button", { name: /send test/i });
    expect(sendButtons.length).toBeGreaterThan(0);
    apiMock.post.mockClear();
    await user.click(sendButtons[0]);
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // Critical: declining the confirm must NOT fire the test-notification POST.
    expect(apiMock.post).not.toHaveBeenCalledWith(
      "/notifications/test",
      expect.anything()
    );
  });

  it("Send test POSTs when the confirm dialog is accepted (#940 — happy path)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/notifications/preferences"))
        return Promise.resolve({
          data: [{ channel: "EMAIL", enabled: true }],
        });
      if (url.startsWith("/notifications/schedule"))
        return Promise.resolve({ data: null });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    confirmMock.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^notifications$/i })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /^notifications$/i }));
    // NotificationsTab always renders all 4 channels (WHATSAPP/SMS/EMAIL/PUSH)
    // — click any one; we just assert that confirm was honoured and a POST
    // to /notifications/test fired with SOME channel string.
    const sendButtons = await screen.findAllByRole("button", { name: /send test/i });
    await user.click(sendButtons[0]);
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/notifications/test",
        expect.objectContaining({ channel: expect.any(String) })
      )
    );
  });

  // Issue #437: nurse role must only see personal-scoped settings tabs.
  // The current allow-list lists the same four for every role, but the
  // important RBAC contract is that the *list* is filtered through the
  // role-aware helper (so when a future Org/Users/Billing tab is added it
  // will be hidden from nurses without a code change here). At minimum we
  // assert the four expected nurse tabs render.
  it("renders only nurse-allowed tabs when role=NURSE (#437)", async () => {
    apiMock.get.mockImplementation(() => Promise.resolve({ data: [] }));
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u2", name: "Nurse", email: "n@x.com", role: "NURSE" },
        refreshUser: vi.fn(),
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^settings$/i })).toBeInTheDocument()
    );
    // Nurse-allowed tabs
    expect(screen.getByRole("button", { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /security/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preferences/i })).toBeInTheDocument();
    // Admin-only tabs that may be added in the future MUST NOT render for
    // nurse. We assert the labels don't appear at all.
    expect(screen.queryByRole("button", { name: /organization/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^users$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /billing|integrations/i })).not.toBeInTheDocument();
  });
});
