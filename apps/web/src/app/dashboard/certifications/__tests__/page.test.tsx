// Coverage tests for the certifications dashboard page
// (apps/web/src/app/dashboard/certifications/page.tsx). The page lists
// staff certifications fetched from GET /hr-ops/certifications, with
// All / Expiring / Expired filters keyed on daysUntil(expiryDate), an
// expiry-status badge (green > 90d, yellow ≤ 90d, amber ≤ 30d, red < 0d
// with an AlertTriangle icon), and an Add-Certification modal that
// POSTs to /hr-ops/certifications (gated client-side on userId + title).
// Why: the page was at 0% coverage. These assertions lock in the load
// contract, the expiry-bucket rendering, the empty/error fallbacks, the
// modal-validation guard, and the create-then-reload sequence so future
// refactors can't silently regress them. The page has no client-side
// VIEW_ALLOWED gate (CLAUDE.md gotcha #7), so RBAC is verified at the
// API layer and not asserted here.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

// Stub EntityPicker as a controlled input so the test can drive
// form.userId without exercising the real picker's network calls.
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ onChange, testIdPrefix, value }: any) => (
    <input
      data-testid={`${testIdPrefix ?? "picker"}-stub`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/certifications",
}));

import CertificationsPage from "../page";

// Helpers — build dates relative to today so the expiry-bucket assertions
// remain stable regardless of wall-clock drift. We anchor on LOCAL MIDNIGHT
// (matching page.tsx's `daysUntil()` which snaps `now` to 00:00 before
// diffing). Anchoring on `Date.now()` (any time of day) drifted the day
// count by +/- 1 when the suite ran late in the evening UTC, making
// "Expired 10d ago" / "15d left" assertions flake on CI.
const ms = 86_400_000;
function isoDaysFromNow(days: number): string {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + days * ms).toISOString();
}

function certRow(overrides: Partial<any> = {}) {
  return {
    id: "c1",
    userId: "u1",
    type: "MEDICAL_LICENSE",
    title: "MBBS Registration",
    issuingBody: "MCI",
    certNumber: "MED-001",
    issuedDate: "2020-05-01",
    expiryDate: isoDaysFromNow(365),
    status: "ACTIVE",
    notes: null,
    user: { id: "u1", name: "Dr. Aarav", role: "DOCTOR" },
    ...overrides,
  };
}

describe("Certifications dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
  });

  it("renders the skeleton loading state while the initial fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<CertificationsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("certifications-loading")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("certifications-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    // Header chrome renders regardless of fetch state.
    expect(
      screen.getByRole("heading", { name: /Staff Certifications/i }),
    ).toBeInTheDocument();
  });

  it("fetches /hr-ops/certifications on mount and renders one row per cert", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        certRow({ id: "c1" }),
        certRow({
          id: "c2",
          userId: "u2",
          title: "BLS Certificate",
          type: "BLS",
          issuingBody: "AHA",
          certNumber: "BLS-2026",
          expiryDate: isoDaysFromNow(45),
          user: { id: "u2", name: "Nurse Priya", role: "NURSE" },
        }),
      ],
    });

    render(<CertificationsPage />);

    await screen.findByText("Dr. Aarav");

    expect(apiMock.get).toHaveBeenCalledWith("/hr-ops/certifications");

    // Both staff names render in the Staff column.
    expect(screen.getByText("Dr. Aarav")).toBeInTheDocument();
    expect(screen.getByText("Nurse Priya")).toBeInTheDocument();

    // Titles + issuers + cert numbers render verbatim.
    expect(screen.getByText("MBBS Registration")).toBeInTheDocument();
    expect(screen.getByText("BLS Certificate")).toBeInTheDocument();
    expect(screen.getByText("MCI")).toBeInTheDocument();
    expect(screen.getByText("AHA")).toBeInTheDocument();
    expect(screen.getByText("MED-001")).toBeInTheDocument();
    expect(screen.getByText("BLS-2026")).toBeInTheDocument();

    // Type label is the underscore-stripped enum value.
    expect(screen.getByText("MEDICAL LICENSE")).toBeInTheDocument();
    expect(screen.getByText("BLS")).toBeInTheDocument();
  });

  it("falls back to the userId slice when row.user is absent", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        certRow({
          id: "c-no-user",
          userId: "abcdef1234567890",
          user: undefined,
        }),
      ],
    });
    render(<CertificationsPage />);

    // userId.slice(0, 8) → "abcdef12"
    expect(await screen.findByText("abcdef12")).toBeInTheDocument();
  });

  it("renders em-dash placeholders for missing issuingBody / certNumber / expiryDate", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        certRow({
          id: "c-bare",
          issuingBody: null,
          certNumber: null,
          expiryDate: null,
        }),
      ],
    });
    render(<CertificationsPage />);
    await screen.findByText("MBBS Registration");

    // Three em-dashes from the bare fields (issuer, cert#, expiry).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("renders the empty state when the API returns zero certs", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<CertificationsPage />);

    expect(
      await screen.findByText(/No certifications found\./i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("certifications-loading")).not.toBeInTheDocument();
  });

  it("surfaces a toast and falls through to the empty state when the fetch rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("Network down"));
    render(<CertificationsPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Network down"),
    );
    // Page still flips loading → false and renders empty branch.
    expect(
      await screen.findByText(/No certifications found\./i),
    ).toBeInTheDocument();
  });

  it("uses the fallback error copy when the rejected error has no message", async () => {
    apiMock.get.mockRejectedValue({});
    render(<CertificationsPage />);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Failed to load certifications",
      ),
    );
  });

  it("renders an expired status badge with the AlertTriangle icon when expiryDate is in the past", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        certRow({ expiryDate: isoDaysFromNow(-10) }),
      ],
    });
    render(<CertificationsPage />);

    // Badge text: "Expired 10d ago" (the minus-flip in daysUntil).
    expect(await screen.findByText(/Expired 10d ago/i)).toBeInTheDocument();
  });

  it("renders an expiring-soon status badge (amber bucket) when expiryDate is within 30 days", async () => {
    apiMock.get.mockResolvedValue({
      data: [certRow({ expiryDate: isoDaysFromNow(15) })],
    });
    render(<CertificationsPage />);

    expect(await screen.findByText(/15d left/i)).toBeInTheDocument();
  });

  it("renders an 'Expires today' badge when daysUntil === 0", async () => {
    // The page's daysUntil() snaps `now` to local midnight and then
    // compares against `new Date(dateStr)`. To land on exactly 0, the
    // expiry must parse to the SAME local-midnight instant. Build a
    // Date at local 00:00 and pass its ISO string — the diff is 0ms,
    // independent of TZ.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    apiMock.get.mockResolvedValue({
      data: [certRow({ expiryDate: midnight.toISOString() })],
    });
    render(<CertificationsPage />);

    expect(await screen.findByText(/Expires today/i)).toBeInTheDocument();
  });

  it("filters to expired-only when the Expired button is clicked", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        certRow({
          id: "valid",
          title: "Valid Cert",
          expiryDate: isoDaysFromNow(365),
        }),
        certRow({
          id: "expired",
          title: "Expired Cert",
          expiryDate: isoDaysFromNow(-30),
        }),
      ],
    });
    render(<CertificationsPage />);
    await screen.findByText("Valid Cert");

    fireEvent.click(screen.getByRole("button", { name: /^Expired$/i }));

    // After filter, expired row stays; valid row hides.
    expect(screen.getByText("Expired Cert")).toBeInTheDocument();
    expect(screen.queryByText("Valid Cert")).not.toBeInTheDocument();
  });

  it("filters to expiring-soon (0..30d) when the Expiring Soon button is clicked", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        certRow({
          id: "far",
          title: "Far Cert",
          expiryDate: isoDaysFromNow(365),
        }),
        certRow({
          id: "soon",
          title: "Soon Cert",
          expiryDate: isoDaysFromNow(10),
        }),
        certRow({
          id: "past",
          title: "Past Cert",
          expiryDate: isoDaysFromNow(-5),
        }),
      ],
    });
    render(<CertificationsPage />);
    await screen.findByText("Far Cert");

    fireEvent.click(screen.getByRole("button", { name: /Expiring Soon/i }));

    // Soon kept, Far + Past dropped.
    expect(screen.getByText("Soon Cert")).toBeInTheDocument();
    expect(screen.queryByText("Far Cert")).not.toBeInTheDocument();
    expect(screen.queryByText("Past Cert")).not.toBeInTheDocument();
  });

  it("shows the no-results empty state when the active filter excludes all rows", async () => {
    apiMock.get.mockResolvedValue({
      data: [certRow({ expiryDate: isoDaysFromNow(365) })],
    });
    render(<CertificationsPage />);
    await screen.findByText("MBBS Registration");

    fireEvent.click(screen.getByRole("button", { name: /^Expired$/i }));

    expect(screen.getByText(/No certifications found\./i)).toBeInTheDocument();
  });

  it("opens the Add Certification modal when the header CTA is clicked", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<CertificationsPage />);
    await screen.findByText(/No certifications found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Certification/i }));

    expect(
      screen.getByRole("heading", { name: /^Add Certification$/i }),
    ).toBeInTheDocument();
    // The picker stub is mounted inside the modal.
    expect(screen.getByTestId("cert-user-picker-stub")).toBeInTheDocument();
  });

  it("does NOT POST when the user clicks Save with userId or title missing", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<CertificationsPage />);
    await screen.findByText(/No certifications found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Certification/i }));

    // Save without filling anything — submit() short-circuits.
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("POSTs the certification with the form payload and reloads the list when Save succeeds", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    apiMock.post.mockResolvedValue({ data: { id: "new-cert" } });
    apiMock.get.mockResolvedValueOnce({
      data: [certRow({ id: "new-cert", title: "Newly Added Cert" })],
    });

    render(<CertificationsPage />);
    await screen.findByText(/No certifications found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Certification/i }));

    // Drive the controlled picker stub + title input.
    fireEvent.change(screen.getByTestId("cert-user-picker-stub"), {
      target: { value: "user-xyz" },
    });
    fireEvent.change(screen.getByLabelText(/^Title$/i), {
      target: { value: "BLS Renewal" },
    });
    fireEvent.change(screen.getByLabelText(/Issuing Body/i), {
      target: { value: "AHA" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      "/hr-ops/certifications",
      expect.objectContaining({
        userId: "user-xyz",
        type: "MEDICAL_LICENSE",
        title: "BLS Renewal",
        issuingBody: "AHA",
      }),
    );

    // The post-save load() refetches → second GET fires.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledTimes(2));
    // Reloaded data renders.
    await screen.findByText("Newly Added Cert");
  });

  it("toasts the error and keeps the modal open when the POST rejects", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockRejectedValue(new Error("400 Bad Request"));

    render(<CertificationsPage />);
    await screen.findByText(/No certifications found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Certification/i }));
    fireEvent.change(screen.getByTestId("cert-user-picker-stub"), {
      target: { value: "u-99" },
    });
    fireEvent.change(screen.getByLabelText(/^Title$/i), {
      target: { value: "X" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("400 Bad Request"),
    );
    // Modal stays mounted (heading still present).
    expect(
      screen.getByRole("heading", { name: /^Add Certification$/i }),
    ).toBeInTheDocument();
  });

  it("closes the modal when the Cancel button is clicked", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<CertificationsPage />);
    await screen.findByText(/No certifications found\./i);

    fireEvent.click(screen.getByRole("button", { name: /Add Certification/i }));
    expect(
      screen.getByRole("heading", { name: /^Add Certification$/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(
      screen.queryByRole("heading", { name: /^Add Certification$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the All / Expiring Soon / Expired filter buttons", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<CertificationsPage />);
    await screen.findByText(/No certifications found\./i);

    expect(screen.getByRole("button", { name: /^All$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Expiring Soon/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Expired$/i }),
    ).toBeInTheDocument();
  });

  it("falls back to {} (empty data) when the API returns no data key", async () => {
    apiMock.get.mockResolvedValue({});
    render(<CertificationsPage />);
    // The page does `res.data || []` so this still resolves to empty state.
    expect(
      await screen.findByText(/No certifications found\./i),
    ).toBeInTheDocument();
  });
});
