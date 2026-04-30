/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

const { apiMock, authMock, toastMock, routerReplace } = vi.hoisted(() => ({
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
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-fraud",
}));

import AiFraudPage from "../ai-fraud/page";

function mockAlert(overrides: Partial<any> = {}): any {
  return {
    id: "fa-1",
    type: "DUPLICATE_BILLING",
    severity: "HIGH_RISK",
    status: "OPEN", // server uses legacy "OPEN"; UI maps to NEW.
    entityType: "Invoice",
    entityId: "inv-1",
    description: "3 identical invoices in 5 minutes",
    evidence: { llmReason: "Sequential billing pattern is unusual" },
    detectedAt: new Date("2026-04-29T10:00:00Z").toISOString(),
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockImplementation((selector: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asReception() {
  authMock.mockImplementation((selector: any) => {
    const state = {
      user: { id: "u2", name: "Reception", email: "r@x.com", role: "RECEPTION" },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asDoctor() {
  authMock.mockImplementation((selector: any) => {
    const state = {
      user: { id: "u3", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("AiFraudPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    asAdmin();

    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/ai/fraud/alerts?")) {
        return Promise.resolve({ data: [mockAlert()] });
      }
      if (url.match(/^\/ai\/fraud\/alerts\/[^/]+\/comments$/)) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: {} });
    apiMock.post.mockResolvedValue({ data: {} });
  });

  it("renders the alert list and the status pill in the new vocabulary", async () => {
    render(<AiFraudPage />);
    await waitFor(() => {
      expect(screen.getByText(/3 identical invoices in 5 minutes/)).toBeInTheDocument();
    });
    // Page wrapper testid
    expect(screen.getByTestId("ai-fraud-page")).toBeInTheDocument();
    // Row testid
    expect(screen.getByTestId("ai-fraud-row-fa-1")).toBeInTheDocument();
    // Status pill should render the NEW vocab (OPEN -> NEW mapping)
    const pill = screen.getByTestId("ai-fraud-status-fa-1");
    expect(pill.textContent).toMatch(/NEW/);
  });

  it("status pill dropdown shows allowed transitions for NEW (INVESTIGATING + DISMISSED)", async () => {
    render(<AiFraudPage />);
    const pill = await screen.findByTestId("ai-fraud-status-fa-1");
    fireEvent.click(pill);
    // Both options should appear
    const menu = await screen.findByTestId("ai-fraud-status-menu-fa-1");
    expect(menu.textContent).toMatch(/INVESTIGATING/);
    expect(menu.textContent).toMatch(/DISMISSED/);
    // RESOLVED is NOT a direct transition from NEW
    expect(menu.textContent).not.toMatch(/RESOLVED/);
  });

  it("DISMISSED transition opens the resolution modal and requires a reason", async () => {
    render(<AiFraudPage />);
    const pill = await screen.findByTestId("ai-fraud-status-fa-1");
    fireEvent.click(pill);
    const dismissOpt = await screen.findByTestId(
      "ai-fraud-status-option-fa-1-DISMISSED",
    );
    fireEvent.click(dismissOpt);

    // The in-DOM modal should be visible (no native window.prompt!)
    const modal = await screen.findByTestId("ai-fraud-resolve-modal");
    expect(modal).toBeInTheDocument();

    // The confirm button should start disabled (no reason yet)
    const confirm = screen.getByTestId("ai-fraud-resolve-confirm");
    expect(confirm).toBeDisabled();
    // No PATCH should have fired yet
    expect(apiMock.patch).not.toHaveBeenCalled();

    // Type a reason — confirm enables and PATCH fires with status + reason
    const input = screen.getByTestId("ai-fraud-resolve-reason-input");
    fireEvent.change(input, { target: { value: "False positive — duplicate import row" } });
    expect(confirm).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ai/fraud/alerts/fa-1/status",
        expect.objectContaining({
          status: "DISMISSED",
          reason: "False positive — duplicate import row",
        }),
      );
    });
  });

  it("posts a comment via /ai/fraud/alerts/:id/comments and refreshes inline", async () => {
    apiMock.post.mockImplementation((url: string, body: any) => {
      if (url === "/ai/fraud/alerts/fa-1/comments") {
        return Promise.resolve({
          data: {
            id: "c-1",
            authorId: "u1",
            authorName: "Admin",
            body: body.body,
            createdAt: new Date().toISOString(),
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(<AiFraudPage />);
    // Expand the row
    const row = await screen.findByTestId("ai-fraud-row-fa-1");
    fireEvent.click(row);

    // The empty-comments hint appears, plus the input
    await screen.findByTestId("ai-fraud-comments-empty-fa-1");
    const input = screen.getByTestId("ai-fraud-comment-input-fa-1");
    fireEvent.change(input, { target: { value: "Reviewed — flagging for billing audit" } });
    const submit = screen.getByTestId("ai-fraud-comment-submit-fa-1");
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => {
      const comment = screen.getByTestId("ai-fraud-comment-c-1");
      expect(comment.textContent).toMatch(/Reviewed/);
      expect(comment.textContent).toMatch(/Admin/);
    });
    expect(apiMock.post).toHaveBeenCalledWith(
      "/ai/fraud/alerts/fa-1/comments",
      { body: "Reviewed — flagging for billing audit" },
    );
  });

  it("non-investigator roles (DOCTOR) see the read-only restricted notice", async () => {
    asDoctor();
    render(<AiFraudPage />);
    expect(screen.getByTestId("ai-fraud-page")).toBeInTheDocument();
    expect(screen.getByText(/Restricted/i)).toBeInTheDocument();
    // The list is NOT loaded for non-investigators
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("RECEPTION can transition + comment (write access)", async () => {
    asReception();
    render(<AiFraudPage />);
    // Status pill is interactive (not just a static span)
    const pill = await screen.findByTestId("ai-fraud-status-fa-1");
    fireEvent.click(pill);
    const menu = await screen.findByTestId("ai-fraud-status-menu-fa-1");
    expect(menu.textContent).toMatch(/INVESTIGATING/);
  });
});
