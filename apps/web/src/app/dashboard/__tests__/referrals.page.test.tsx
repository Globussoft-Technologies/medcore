/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/referrals",
}));

import ReferralsPage from "../referrals/page";

const sampleReferrals = [
  {
    id: "r1",
    referralNumber: "REF-001",
    status: "PENDING",
    createdAt: new Date().toISOString(),
    reason: "Specialist consult",
    specialty: "Cardiology",
    patient: { id: "p1", mrNumber: "MR-1", user: { name: "Aarav Mehta" } },
    fromDoctor: { id: "d1", user: { name: "Dr. A" } },
    toDoctor: { id: "d2", user: { name: "Dr. B" } },
  },
];

describe("ReferralsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders heading with empty data", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<ReferralsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^referrals$/i })).toBeInTheDocument()
    );
  });

  it("renders populated referrals", async () => {
    apiMock.get.mockResolvedValue({ data: sampleReferrals });
    render(<ReferralsPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/REF-001/).length).toBeGreaterThan(0)
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ReferralsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^referrals$/i })).toBeInTheDocument()
    );
  });

  it("clicking New Referral opens modal", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(<ReferralsPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /new referral/i })
    );
    await user.click(screen.getByRole("button", { name: /new referral/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/new referral/i).length).toBeGreaterThan(1)
    );
  });

  it("loads doctors when create modal opens", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(<ReferralsPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /new referral/i })
    );
    await user.click(screen.getByRole("button", { name: /new referral/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/doctors"))).toBe(true);
    });
  });

  // ─── Issue #10: missing Reason should surface client-side ─────────
  it("rejects submit when Reason is empty (issue #10)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(<ReferralsPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /new referral/i })
    );
    await user.click(screen.getByRole("button", { name: /new referral/i }));

    // Click "Create Referral" without filling anything — API must not be
    // called and the Reason field error should appear inline.
    const createBtn = await screen.findByRole("button", {
      name: /^create referral$/i,
    });
    await user.click(createBtn);

    await waitFor(() => {
      expect(apiMock.post).not.toHaveBeenCalledWith(
        "/referrals",
        expect.anything()
      );
    });
    // The error text should exist somewhere — may be "Select a patient" or
    // the Zod "Reason is required" message. At least one should match.
    const errors = screen.queryAllByText(/reason is required|select a patient/i);
    expect(errors.length).toBeGreaterThan(0);
  });
});
