// Smoke tests for /dashboard/whatsapp/[id] — Pearl §6.1 gap row 167 piece 3j-iii of 4.
//
// What / which modules / why:
//   - Asserts the thread page renders chat bubbles with the correct
//     direction styling, surfaces the reply-coming-next-piece banner,
//     wires up the Mark all read / Snooze / Close / Assign-me actions
//     to the correct API endpoints, and observes the 44px touch-target
//     invariant on every CTA.
//   - Covers apps/web/src/app/dashboard/whatsapp/[id]/page.tsx.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiMock, authMock, paramsMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  paramsMock: vi.fn(() => ({ id: "c1" })),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => paramsMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/whatsapp/c1",
}));

import WhatsAppThreadPage from "../page";

function asRole(role: string) {
  authMock.mockImplementation((selector: any) => {
    const state = {
      user: { id: `u-${role}`, role, name: role, email: `${role}@x.com` },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function threadFixture(overrides: Partial<any> = {}) {
  return {
    data: {
      conversation: {
        id: "c1",
        phone: "+919876543210",
        status: "OPEN",
        unreadCount: 0,
        lastMessageAt: new Date().toISOString(),
        assignedToUserId: null,
        patient: {
          id: "p1",
          mrNumber: "MR0001",
          user: { id: "u1", name: "Aarav Sharma" },
        },
        ...(overrides.conversation ?? {}),
      },
      messages: [
        {
          id: "m1",
          direction: "INBOUND",
          body: "Hi doctor, my appointment for tomorrow?",
          mediaUrl: null,
          sentAt: new Date(Date.now() - 600_000).toISOString(),
          deliveredAt: null,
          readAt: null,
          status: "DELIVERED",
          createdAt: new Date(Date.now() - 600_000).toISOString(),
        },
        {
          id: "m2",
          direction: "OUTBOUND",
          body: "Yes confirmed for 10am.",
          mediaUrl: null,
          sentAt: new Date(Date.now() - 300_000).toISOString(),
          deliveredAt: null,
          readAt: null,
          status: "SENT",
          createdAt: new Date(Date.now() - 300_000).toISOString(),
        },
      ],
      olderCursor: null,
      ...(overrides.thread ?? {}),
    },
  };
}

describe("/dashboard/whatsapp/[id] — Pearl §6.1 piece 3j-iii (thread)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.get.mockResolvedValue(threadFixture());
    apiMock.post.mockResolvedValue({});
    apiMock.patch.mockResolvedValue({});
    paramsMock.mockReturnValue({ id: "c1" });
    // Clear sessionStorage between tests so the mark-read-once latch
    // doesn't bleed across cases.
    try {
      window.sessionStorage.clear();
    } catch {
      // ignore
    }
  });

  it("renders chat bubbles for INBOUND and OUTBOUND messages", async () => {
    asRole("RECEPTION");
    render(<WhatsAppThreadPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("wa-thread-message")).toHaveLength(2),
    );
    const messages = screen.getAllByTestId("wa-thread-message");
    expect(messages[0].getAttribute("data-direction")).toBe("INBOUND");
    expect(messages[1].getAttribute("data-direction")).toBe("OUTBOUND");
    expect(screen.getByText("Hi doctor, my appointment for tomorrow?")).toBeInTheDocument();
    expect(screen.getByText("Yes confirmed for 10am.")).toBeInTheDocument();
  });

  it("renders the patient name in the header + the 'reply coming next piece' banner", async () => {
    asRole("RECEPTION");
    render(<WhatsAppThreadPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-thread-title")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("wa-thread-title").textContent).toBe("Aarav Sharma");
    const banner = screen.getByTestId("wa-thread-reply-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/reply support coming/i);
  });

  it("Mark all read button POSTs to /wa/inbox/conversations/c1/read", async () => {
    asRole("RECEPTION");
    render(<WhatsAppThreadPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-thread-mark-read")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("wa-thread-mark-read"));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/wa/inbox/conversations/c1/read"),
    );
  });

  it("Snooze button PATCHes /wa/inbox/conversations/c1 with {status:'SNOOZED'}", async () => {
    asRole("RECEPTION");
    render(<WhatsAppThreadPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-thread-snooze")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("wa-thread-snooze"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/wa/inbox/conversations/c1",
        { status: "SNOOZED" },
      ),
    );
  });

  it("Assign to me PATCHes with the current user id", async () => {
    asRole("RECEPTION");
    render(<WhatsAppThreadPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-thread-assign-me")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("wa-thread-assign-me"));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/wa/inbox/conversations/c1",
        { assignedToUserId: "u-RECEPTION" },
      ),
    );
  });

  it("all CTAs carry the h-11 + min-w-[44px] touch-target invariant", async () => {
    asRole("RECEPTION");
    render(<WhatsAppThreadPage />);
    await waitFor(() =>
      expect(screen.getByTestId("wa-thread-mark-read")).toBeInTheDocument(),
    );
    for (const tid of [
      "wa-thread-mark-read",
      "wa-thread-snooze",
      "wa-thread-close",
      "wa-thread-assign-me",
      "wa-thread-back",
    ]) {
      const el = screen.getByTestId(tid);
      expect(el.className).toMatch(/h-11/);
      expect(el.className).toMatch(/min-w-\[44px\]/);
    }
  });

  it("renders the not-allowed surface for the PATIENT role", () => {
    asRole("PATIENT");
    render(<WhatsAppThreadPage />);
    expect(screen.getByTestId("wa-thread-not-allowed")).toBeInTheDocument();
    expect(screen.queryByTestId("wa-thread-actions")).not.toBeInTheDocument();
  });
});
