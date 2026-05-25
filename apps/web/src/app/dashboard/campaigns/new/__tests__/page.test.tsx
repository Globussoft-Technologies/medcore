// Smoke tests for /dashboard/campaigns/new — Pearl §5.1 gap #4 piece 4 of 4.
//
// What / which modules / why:
//   - Asserts the audience-builder form: adding/removing filter rows,
//     mapping UI filters → the DSL save payload, the "Save audience &
//     preview size" flow (POST /campaign-audiences then POST
//     /campaign-audiences/:id/compile), and the final campaign-create
//     POST that bundles the saved audienceId.
//   - Submit button stays disabled until the audience is saved (audienceId
//     is required server-side for downstream dispatch).
//   - Covers apps/web/src/app/dashboard/campaigns/new/page.tsx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
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
  usePathname: () => "/dashboard/campaigns/new",
}));

import NewCampaignPage from "../page";

beforeEach(() => {
  apiMock.post.mockReset();
  apiMock.get.mockReset();
  routerMock.push.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  authMock.mockReturnValue({
    user: { id: "u1", role: "ADMIN", name: "Admin", email: "a@x.com" },
    isLoading: false,
  });
});

describe("NewCampaignPage", () => {
  it("renders the heading and default channel selection (WHATSAPP on)", () => {
    render(<NewCampaignPage />);
    expect(
      screen.getByRole("heading", { name: /new campaign/i }),
    ).toBeInTheDocument();
    expect(
      (screen.getByTestId("channel-WHATSAPP") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId("channel-SMS") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("redirects a non-ADMIN user away from the page", async () => {
    authMock.mockReturnValue({
      user: { id: "u2", role: "DOCTOR", name: "Doc", email: "d@x.com" },
      isLoading: false,
    });
    render(<NewCampaignPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard"),
    );
  });

  it("disables Create until audience is saved + previewed", async () => {
    const user = userEvent.setup();
    render(<NewCampaignPage />);
    await user.type(
      screen.getByLabelText(/^name/i),
      "Diwali outreach 2026",
    );
    const submit = screen.getByRole("button", { name: /create campaign/i });
    expect(submit).toBeDisabled();
  });

  it("adds + removes filter rows", async () => {
    const user = userEvent.setup();
    render(<NewCampaignPage />);
    expect(screen.getAllByTestId("audience-filter-row")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /add filter/i }));
    expect(screen.getAllByTestId("audience-filter-row")).toHaveLength(2);
    await user.click(screen.getAllByLabelText(/remove filter/i)[0]);
    expect(screen.getAllByTestId("audience-filter-row")).toHaveLength(1);
  });

  it("previews audience size by saving the audience then compiling", async () => {
    apiMock.post
      .mockResolvedValueOnce({
        data: { id: "aud-1", name: "Over-55s" },
      }) // POST /campaign-audiences
      .mockResolvedValueOnce({ data: { count: 137 } }); // POST .../compile
    const user = userEvent.setup();
    render(<NewCampaignPage />);

    await user.type(screen.getByLabelText(/audience name/i), "Over-55s");

    // First (and only) filter row defaults to ageMin — set its value.
    const numberInput = screen.getByLabelText(/filter numeric value/i);
    await user.clear(numberInput);
    await user.type(numberInput, "55");

    await user.click(
      screen.getByRole("button", { name: /save audience.*preview/i }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("audience-size")).toHaveTextContent(
        /137 patients/,
      ),
    );

    expect(apiMock.post).toHaveBeenNthCalledWith(
      1,
      "/campaign-audiences",
      expect.objectContaining({
        name: "Over-55s",
        active: true,
        rules: {
          filters: [{ field: "age", op: "gte", value: 55 }],
          matchMode: "ALL",
        },
      }),
    );
    expect(apiMock.post).toHaveBeenNthCalledWith(
      2,
      "/campaign-audiences/aud-1/compile",
    );
  });

  it("creates the campaign with the saved audienceId on submit + redirects to detail page", async () => {
    apiMock.post
      .mockResolvedValueOnce({ data: { id: "aud-1", name: "Over-55s" } })
      .mockResolvedValueOnce({ data: { count: 5 } })
      .mockResolvedValueOnce({ data: { id: "camp-1" } });
    const user = userEvent.setup();
    render(<NewCampaignPage />);

    await user.type(
      screen.getByLabelText(/^name/i),
      "Diwali outreach 2026",
    );
    await user.type(screen.getByLabelText(/audience name/i), "Over-55s");
    const numberInput = screen.getByLabelText(/filter numeric value/i);
    await user.clear(numberInput);
    await user.type(numberInput, "55");

    await user.click(
      screen.getByRole("button", { name: /save audience.*preview/i }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("audience-size")).toHaveTextContent(
        /5 patients/,
      ),
    );

    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/campaigns",
        expect.objectContaining({
          name: "Diwali outreach 2026",
          kind: "BROADCAST",
          channels: ["WHATSAPP"],
          audienceId: "aud-1",
          sendWindowStart: 9 * 60,
          sendWindowEnd: 21 * 60,
        }),
      ),
    );
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard/campaigns/camp-1"),
    );
  });

  it("surfaces a preview-API failure inline without breaking the form", async () => {
    apiMock.post.mockRejectedValueOnce(new Error("Compile blew up"));
    const user = userEvent.setup();
    render(<NewCampaignPage />);
    await user.type(screen.getByLabelText(/audience name/i), "Lapsed");
    const numberInput = screen.getByLabelText(/filter numeric value/i);
    await user.clear(numberInput);
    await user.type(numberInput, "30");
    await user.click(
      screen.getByRole("button", { name: /save audience.*preview/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/compile blew up/i),
    );
  });
});
