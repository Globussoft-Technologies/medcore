/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * HelpPanel component coverage.
 *
 * What / which modules / why:
 *   - Verifies the floating help drawer rendered on every authed dashboard layout:
 *       1. The trigger button is always rendered; the panel only appears once opened.
 *       2. Close behaviour — close button (X), backdrop click, and the aside's
 *          stopPropagation guard against accidental backdrop-triggered closes.
 *       3. Per-route lookup of PAGE_HELP, including the prefix-fallback chain
 *          (e.g. /dashboard/appointments/123 → /dashboard/appointments entry).
 *       4. Role-aware copy for PATIENT users:
 *          - PATIENT_PAGE_HELP overrides override PAGE_HELP where present
 *            (Issue #878 — staff bullets must not leak to patients).
 *          - PATIENT_SHORTCUTS replace STAFF_SHORTCUTS (Issue #405 — patients
 *            were previously shown "Go to Patients" / "Go to Queue").
 *          - PATIENT_QUICK_LINKS section only renders for PATIENT.
 *       5. Default fallback to the /dashboard PAGE_HELP entry when no key matches.
 *       6. onStartTour optional prop — "Take the tour" button only renders when
 *          a handler is provided, fires the handler, and also closes the panel.
 *       7. NEXT_PUBLIC_DOCS_URL env-gated "Open full documentation" link.
 *
 *   - Source under test: apps/web/src/components/HelpPanel.tsx
 *   - Mocks next/navigation (usePathname) and @/lib/store (useAuthStore).
 *   - No API calls — HelpPanel is a fully client-side static-data component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { navMock, authMock } = vi.hoisted(() => ({
  navMock: { pathname: "/dashboard" as string },
  authMock: {
    user: { id: "u1", role: "DOCTOR", name: "Dr Test" } as
      | { id: string; role: string; name: string }
      | null,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navMock.pathname,
}));

vi.mock("@/lib/store", () => ({
  useAuthStore: (selector: (s: { user: typeof authMock.user }) => unknown) =>
    selector({ user: authMock.user }),
}));

import { HelpPanel } from "../HelpPanel";

const openPanel = () => {
  fireEvent.click(screen.getByRole("button", { name: /open help/i }));
};

describe("HelpPanel", () => {
  beforeEach(() => {
    cleanup();
    navMock.pathname = "/dashboard";
    authMock.user = { id: "u1", role: "DOCTOR", name: "Dr Test" };
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_DOCS_URL;
  });

  it("renders the floating help button but no panel in the initial closed state", () => {
    render(<HelpPanel />);

    expect(
      screen.getByRole("button", { name: /open help/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicking the help button opens the panel as an aria-modal dialog", () => {
    render(<HelpPanel />);
    openPanel();

    const dialog = screen.getByRole("dialog", { name: /help panel/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("clicking the close (X) button dismisses the panel", () => {
    render(<HelpPanel />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: /close help/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicking the backdrop dismisses the panel, but clicking inside the aside does NOT (stopPropagation)", () => {
    render(<HelpPanel />);
    openPanel();

    // The dialog wrapper itself is the backdrop — clicking it triggers onClick={setOpen(false)}.
    const backdrop = screen.getByRole("dialog", { name: /help panel/i });

    // Click the inner heading first — must NOT close.
    fireEvent.click(screen.getByRole("heading", { name: /^Help$/ }));
    expect(screen.queryByRole("dialog")).toBeInTheDocument();

    // Now click the backdrop directly — must close.
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the staff PAGE_HELP entry for the current pathname", () => {
    navMock.pathname = "/dashboard/appointments";
    render(<HelpPanel />);
    openPanel();

    expect(screen.getByText("Appointments")).toBeInTheDocument();
    expect(
      screen.getByText(/Book, reschedule and cancel appointments/),
    ).toBeInTheDocument();
  });

  it("falls back to a prefix-matched PAGE_HELP entry when the exact pathname is not in the map", () => {
    navMock.pathname = "/dashboard/appointments/abc-123";
    render(<HelpPanel />);
    openPanel();

    // Resolves to the /dashboard/appointments entry via the startsWith fallback.
    expect(screen.getByText("Appointments")).toBeInTheDocument();
  });

  it("falls back to the /dashboard entry when no key matches at all", () => {
    navMock.pathname = "/dashboard/totally-unknown-route";
    render(<HelpPanel />);
    openPanel();

    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(
      screen.getByText(/View KPIs and key metrics for today/),
    ).toBeInTheDocument();
  });

  it("renders the staff shortcuts list (includes 'Go to Patients' / 'Go to Queue') for non-patient roles", () => {
    render(<HelpPanel />);
    openPanel();

    expect(screen.getByText(/Go to Patients/)).toBeInTheDocument();
    expect(screen.getByText(/Go to Queue/)).toBeInTheDocument();
    // Staff-only role does NOT see patient quick links.
    expect(
      screen.queryByRole("heading", { name: /Quick links/i }),
    ).not.toBeInTheDocument();
  });

  it("replaces staff bullets with PATIENT_PAGE_HELP when the user is a PATIENT (Issue #878)", () => {
    authMock.user = { id: "pat-1", role: "PATIENT", name: "Patient X" };
    navMock.pathname = "/dashboard/billing";
    render(<HelpPanel />);
    openPanel();

    // Title swapped from "Billing" to "Bills".
    expect(screen.getByText("Bills")).toBeInTheDocument();
    expect(
      screen.getByText(/View your bills and outstanding balance/),
    ).toBeInTheDocument();
    // Staff-only bullets must NOT leak.
    expect(
      screen.queryByText(/Generate invoices from visits and admissions/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Apply discounts \(admin-approved\)/),
    ).not.toBeInTheDocument();
  });

  it("renders patient-specific shortcuts (and NOT 'Go to Patients') for PATIENT users (Issue #405)", () => {
    authMock.user = { id: "pat-1", role: "PATIENT", name: "Patient X" };
    render(<HelpPanel />);
    openPanel();

    expect(screen.getByText(/Go to My Appointments/)).toBeInTheDocument();
    expect(screen.queryByText(/Go to Patients/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Go to Queue/)).not.toBeInTheDocument();
  });

  it("renders the PATIENT_QUICK_LINKS section only for PATIENT users", () => {
    authMock.user = { id: "pat-1", role: "PATIENT", name: "Patient X" };
    render(<HelpPanel />);
    openPanel();

    expect(
      screen.getByRole("heading", { name: /Quick links/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Book an appointment/i }),
    ).toHaveAttribute("href", "/dashboard/ai-booking");
    expect(
      screen.getByRole("link", { name: /View my appointments/i }),
    ).toHaveAttribute("href", "/dashboard/appointments");
    expect(
      screen.getByRole("link", { name: /Change my password/i }),
    ).toHaveAttribute("href", "/dashboard/settings");
  });

  it("falls back to staff PAGE_HELP for a PATIENT when no PATIENT_PAGE_HELP override exists for the route", () => {
    // /dashboard/notifications is NOT in PATIENT_PAGE_HELP — should land on the staff entry.
    authMock.user = { id: "pat-1", role: "PATIENT", name: "Patient X" };
    navMock.pathname = "/dashboard/notifications";
    render(<HelpPanel />);
    openPanel();

    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("does NOT render the 'Take the tour' button when no onStartTour prop is provided", () => {
    render(<HelpPanel />);
    openPanel();

    expect(
      screen.queryByRole("button", { name: /Take the tour/i }),
    ).not.toBeInTheDocument();
  });

  it("renders 'Take the tour' when onStartTour is provided; clicking it fires the handler AND closes the panel", () => {
    const onStartTour = vi.fn();
    render(<HelpPanel onStartTour={onStartTour} />);
    openPanel();

    const tourBtn = screen.getByRole("button", { name: /Take the tour/i });
    fireEvent.click(tourBtn);

    expect(onStartTour).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does NOT render the docs link when NEXT_PUBLIC_DOCS_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_DOCS_URL;
    render(<HelpPanel />);
    openPanel();

    expect(
      screen.queryByRole("link", { name: /Open full documentation/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the docs link when NEXT_PUBLIC_DOCS_URL is set, with target=_blank and rel=noreferrer", () => {
    process.env.NEXT_PUBLIC_DOCS_URL = "https://docs.medcore.test";
    render(<HelpPanel />);
    openPanel();

    const link = screen.getByRole("link", { name: /Open full documentation/i });
    expect(link).toHaveAttribute("href", "https://docs.medcore.test");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("renders patient quick-link clicks as anchor navigations that ALSO close the panel via onClick", () => {
    authMock.user = { id: "pat-1", role: "PATIENT", name: "Patient X" };
    render(<HelpPanel />);
    openPanel();

    fireEvent.click(
      screen.getByRole("link", { name: /View my prescriptions/i }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
