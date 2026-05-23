// Smoke tests for /dashboard/campaigns — Pearl §5.1 gap #4 piece 4 of 4.
//
// What / which modules / why:
//   - Asserts the list view renders the heading + New Campaign CTA,
//     fetches /campaigns, renders each row's name (as a link to the
//     detail page) + kind + channels + status badge + send count, and
//     bounces a non-ADMIN caller to /dashboard.
//   - Status filter is server-side (re-fetch); Kind filter is client-side
//     (post-fetch). Both are exercised.
//   - Covers apps/web/src/app/dashboard/campaigns/page.tsx.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/campaigns",
}));

import CampaignsPage from "../page";

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u1", role: "ADMIN", name: "Admin", email: "a@x.com" },
    isLoading: false,
  });
}

function rowFixture(overrides: Partial<any> = {}) {
  return {
    id: "c1",
    name: "Diwali outreach 2026",
    kind: "BROADCAST",
    status: "DRAFT",
    channels: ["WHATSAPP", "SMS"],
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-22T10:00:00Z").toISOString(),
    _count: { sends: 0 },
    ...overrides,
  };
}

describe("CampaignsPage (list)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerMock.push.mockReset();
    asAdmin();
  });

  it("renders the heading and the New Campaign CTA", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(<CampaignsPage />);
    expect(
      screen.getByRole("heading", { name: /campaigns/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /new campaign/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/campaigns"));
  });

  it("renders a row per campaign with link, kind, status badge and sends count", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        rowFixture(),
        rowFixture({
          id: "c2",
          name: "Diabetes drip",
          kind: "DRIP",
          status: "RUNNING",
          _count: { sends: 42 },
        }),
      ],
    });
    render(<CampaignsPage />);
    await waitFor(() =>
      expect(screen.getByText(/Diwali outreach 2026/)).toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: /Diwali outreach 2026/ });
    expect(link).toHaveAttribute("href", "/dashboard/campaigns/c1");
    // Status + kind + channels all appear both in filter <option>s and
    // in the table row cells. Scope assertions to the row cells.
    const rows = screen.getAllByTestId("campaign-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("BROADCAST");
    expect(rows[1]).toHaveTextContent("DRIP");
    expect(rows[1]).toHaveTextContent("RUNNING");
    expect(rows[1]).toHaveTextContent("42");
  });

  it("shows the empty state when there are no campaigns", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(<CampaignsPage />);
    await waitFor(() =>
      expect(screen.getByText(/no campaigns yet/i)).toBeInTheDocument(),
    );
  });

  it("filters by kind client-side without re-fetching", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        rowFixture({ id: "c1", kind: "BROADCAST" }),
        rowFixture({ id: "c2", name: "Drip 1", kind: "DRIP" }),
      ],
    });
    const user = userEvent.setup();
    render(<CampaignsPage />);
    await waitFor(() =>
      expect(screen.getByText(/Diwali outreach 2026/)).toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledTimes(1);

    const kindSelect = screen.getByLabelText(/^kind$/i);
    await user.selectOptions(kindSelect, "DRIP");

    expect(screen.queryByText(/Diwali outreach 2026/)).not.toBeInTheDocument();
    expect(screen.getByText(/Drip 1/)).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledTimes(1); // no re-fetch
  });

  it("re-fetches with ?status= query param when status filter changes", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: [rowFixture()] })
      .mockResolvedValueOnce({ data: [] });
    const user = userEvent.setup();
    render(<CampaignsPage />);
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith("/campaigns"));

    const statusSelect = screen.getByLabelText(/^status$/i);
    await user.selectOptions(statusSelect, "SCHEDULED");

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/campaigns?status=SCHEDULED"),
    );
  });

  it("redirects a non-ADMIN user away from the page", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", role: "DOCTOR", name: "Doc", email: "d@x.com" },
      isLoading: false,
    });
    render(<CampaignsPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders an inline error when the fetch fails", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("Boom"));
    render(<CampaignsPage />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/boom/i),
    );
  });
});
