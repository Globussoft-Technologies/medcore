// Smoke tests for /dashboard/campaigns/[id] — Pearl §5.1 gap #4 piece 4 of 4.
//
// What / which modules / why:
//   - Asserts the detail view: header meta (name/kind/status badge), the
//     audience panel (name + last-computed size + pretty-printed rules
//     JSON), the SCHEDULED hint, the gated Edit CTA (DRAFT only), and the
//     stats-rollup panel falling back to the "no sends yet" empty state
//     when /campaigns/:id/stats returns totals=0.
//   - Covers apps/web/src/app/dashboard/campaigns/[id]/page.tsx.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, paramsMock, routerMock, toastMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    authMock: vi.fn(),
    paramsMock: vi.fn(() => ({ id: "c1" })),
    routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useParams: () => paramsMock(),
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/campaigns/c1",
}));

import CampaignDetailPage from "../page";

function campaignFixture(overrides: Partial<any> = {}) {
  return {
    id: "c1",
    name: "Diwali outreach 2026",
    description: null,
    kind: "BROADCAST",
    status: "DRAFT",
    channels: ["WHATSAPP"],
    subject: null,
    body: "Hi {{first_name}}!",
    audienceId: "aud-1",
    audience: {
      id: "aud-1",
      name: "Over-55s",
      description: null,
      estimatedSize: 137,
      lastComputedAt: new Date("2026-05-22T08:00:00Z").toISOString(),
      rules: {
        filters: [{ field: "age", op: "gte", value: 55 }],
        matchMode: "ALL",
      },
    },
    scheduledAt: null,
    sendWindowStart: 540,
    sendWindowEnd: 1260,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date("2026-05-22T07:00:00Z").toISOString(),
    _count: { sends: 0 },
    ...overrides,
  };
}

function statsFixture(overrides: Partial<any> = {}) {
  return {
    campaignId: "c1",
    campaignName: "Diwali outreach 2026",
    status: "DRAFT",
    total: 0,
    byStatus: {},
    byChannel: {},
    byVariant: {},
    clicked: 0,
    converted: 0,
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.patch.mockReset();
  routerMock.push.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  paramsMock.mockReturnValue({ id: "c1" });
  authMock.mockReturnValue({
    user: { id: "u1", role: "ADMIN", name: "Admin", email: "a@x.com" },
    isLoading: false,
  });
});

describe("CampaignDetailPage", () => {
  it("renders header meta, audience panel and rules JSON", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: campaignFixture() })
      .mockResolvedValueOnce({ data: statsFixture() });
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Diwali outreach 2026/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("BROADCAST")).toBeInTheDocument();
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
    expect(screen.getByText("Over-55s")).toBeInTheDocument();
    expect(screen.getByTestId("audience-size")).toHaveTextContent("137");

    const rulesPre = screen.getByTestId("audience-rules-json");
    expect(rulesPre.textContent).toContain('"field": "age"');
    expect(rulesPre.textContent).toContain('"value": 55');
  });

  it("shows the SCHEDULED dispatch hint when status is SCHEDULED", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: campaignFixture({ status: "SCHEDULED" }) })
      .mockResolvedValueOnce({ data: statsFixture() });
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("scheduled-hint")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("scheduled-hint")).toHaveTextContent(
      /will dispatch on next worker tick/i,
    );
  });

  it("hides the Edit CTA when status is not DRAFT", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: campaignFixture({ status: "RUNNING" }) })
      .mockResolvedValueOnce({ data: statsFixture() });
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("RUNNING")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /^edit$/i }),
    ).not.toBeInTheDocument();
  });

  it("PATCHes name + status when the Edit form is saved", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: campaignFixture() })
      .mockResolvedValueOnce({ data: statsFixture() })
      .mockResolvedValueOnce({ data: campaignFixture({ status: "SCHEDULED" }) })
      .mockResolvedValueOnce({ data: statsFixture({ status: "SCHEDULED" }) });
    apiMock.patch.mockResolvedValueOnce({ data: {} });

    const user = userEvent.setup();
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(screen.getByText("Diwali outreach 2026")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.selectOptions(screen.getByLabelText(/^status$/i), "SCHEDULED");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/campaigns/c1",
        expect.objectContaining({ status: "SCHEDULED" }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith("Campaign updated");
  });

  it("falls back to the 'no sends yet' empty state when stats returns 0 totals", async () => {
    apiMock.get
      .mockResolvedValueOnce({ data: campaignFixture() })
      .mockResolvedValueOnce({ data: statsFixture({ total: 0 }) });
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no campaignsend rows yet/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders the rollup with by-channel breakdown when stats has data", async () => {
    apiMock.get.mockResolvedValueOnce({ data: campaignFixture() }).mockResolvedValueOnce({
      data: statsFixture({
        total: 100,
        byStatus: { SENT: 80, DELIVERED: 70, READ: 50, FAILED: 5 },
        byChannel: {
          WHATSAPP: { SENT: 80, DELIVERED: 70, READ: 50, FAILED: 5, total: 100 },
        },
        clicked: 12,
        converted: 3,
      }),
    });
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/Total:/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Clicked:/)).toBeInTheDocument();
    // WHATSAPP appears in both the header channels line and the rollup
    // table — confirm there's at least one occurrence per region.
    expect(screen.getAllByText("WHATSAPP").length).toBeGreaterThanOrEqual(2);
  });

  it("redirects a non-ADMIN user away from the page", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", role: "DOCTOR", name: "Doc", email: "d@x.com" },
      isLoading: false,
    });
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
  });

  it("renders an inline error when the campaign fetch fails", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("404 not found"));
    render(<CampaignDetailPage />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/404 not found/),
    );
  });
});
