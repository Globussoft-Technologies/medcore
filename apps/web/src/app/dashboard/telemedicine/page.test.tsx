/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression test for issue #956: the Doctor telemedicine "Upcoming" tab
// was listing past-dated SCHEDULED sessions (e.g. TEL000018) because the
// list was filtered only by status, not by `scheduledAt > now`. This file
// covers the page-level filter introduced in `loadSessions()` that drops
// SCHEDULED rows whose scheduled time has elapsed while keeping
// WAITING / IN_PROGRESS rows visible regardless of clock.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, socketMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  socketMock: {
    connected: false,
    connect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => vi.fn(async () => false),
  usePrompt: () => vi.fn(async () => null),
}));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/telemedicine",
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

import TelemedicinePage from "./page";

function makeSession(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "s-default",
    sessionNumber: over.sessionNumber ?? "TEL000001",
    scheduledAt: over.scheduledAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    startedAt: null,
    endedAt: null,
    durationMin: null,
    meetingUrl: null,
    meetingId: null,
    signedRoomUrl: null,
    status: over.status ?? "SCHEDULED",
    chiefComplaint: over.chiefComplaint ?? "Routine follow-up",
    doctorNotes: null,
    patientRating: null,
    fee: 500,
    patient: { id: "p1", mrNumber: "MR001", user: { name: "Alice Patient", phone: "1234" } },
    doctor: { id: "d1", specialization: "General", user: { name: "Bob Doctor" } },
    ...over,
  };
}

describe("TelemedicinePage Upcoming tab (Issue #956)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation(() => ({
      user: { id: "u1", userId: "u1", name: "Dr Sharma", email: "dr@x.com", role: "DOCTOR" },
    }));
  });

  it("excludes past-dated SCHEDULED sessions from the Upcoming tab (TEL000018 reproducer)", async () => {
    const pastScheduled = makeSession({
      id: "s-past",
      sessionNumber: "TEL000018",
      scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
      status: "SCHEDULED",
    });
    const futureScheduled = makeSession({
      id: "s-future",
      sessionNumber: "TEL000019",
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
      status: "SCHEDULED",
    });

    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("status=SCHEDULED")) {
        return Promise.resolve({ data: [pastScheduled, futureScheduled] });
      }
      // WAITING + IN_PROGRESS return empty
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicinePage />);

    // Future session should appear
    await waitFor(() => {
      expect(screen.getByText("TEL000019")).toBeInTheDocument();
    });
    // Past-dated session must NOT appear under Upcoming
    expect(screen.queryByText("TEL000018")).not.toBeInTheDocument();
  });

  it("keeps WAITING and IN_PROGRESS sessions in Upcoming even if their scheduledAt is in the past", async () => {
    const pastWaiting = makeSession({
      id: "s-waiting",
      sessionNumber: "TEL000020",
      scheduledAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
      status: "WAITING",
    });
    const pastInProgress = makeSession({
      id: "s-inprogress",
      sessionNumber: "TEL000021",
      scheduledAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      status: "IN_PROGRESS",
    });

    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("status=SCHEDULED")) return Promise.resolve({ data: [] });
      if (url.includes("status=WAITING")) return Promise.resolve({ data: [pastWaiting] });
      if (url.includes("status=IN_PROGRESS")) return Promise.resolve({ data: [pastInProgress] });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicinePage />);

    await waitFor(() => {
      expect(screen.getByText("TEL000020")).toBeInTheDocument();
      expect(screen.getByText("TEL000021")).toBeInTheDocument();
    });
  });
});
