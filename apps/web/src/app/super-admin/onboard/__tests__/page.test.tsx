/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for the super-admin onboarding wizard (gap #6 piece 2 of 4).
//
// Covers:
//   - Step 1 renders by default. Filling tenant fields + clicking Next
//     advances to step 2 (renders onboarding-step-2).
//   - Filling step-2 → Next → step-3 → submit triggers a fetch to
//     /api/v1/tenant-onboarding.
//   - A server-side 409 with {error, field} renders the
//     onboarding-error-banner and bounces back to step 1.
//
// Layout gate is exercised by the existing landing.page.test.tsx; this
// file mocks next/navigation but not the layout itself (the wizard page
// has no gate logic of its own — it relies on the layout).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { routerPush } = vi.hoisted(() => ({
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/super-admin/onboard",
}));

import OnboardingWizardPage from "../page";

describe("Super-admin onboarding wizard — gap #6 piece 2 of 4", () => {
  beforeEach(() => {
    routerPush.mockReset();
    (global.fetch as any) = vi.fn();
  });

  it("renders step 1 by default and advances to step 2 on Next", async () => {
    render(<OnboardingWizardPage />);

    expect(screen.getByTestId("onboarding-step-1")).toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-step-2")).not.toBeInTheDocument();

    // Fill the minimum step-1 fields.
    fireEvent.change(screen.getByTestId("onboarding-tenant-name"), {
      target: { value: "Sunrise Hospital" },
    });
    fireEvent.change(screen.getByTestId("onboarding-tenant-subdomain"), {
      target: { value: "sunrise" },
    });

    fireEvent.click(screen.getByTestId("onboarding-next"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-2")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("onboarding-step-1")).not.toBeInTheDocument();
  });

  it("submits the full payload to /api/v1/tenant-onboarding on step 3", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        data: { tenant: { id: "new-id" }, branch: { id: "b1" }, admin: { id: "u1" } },
        error: null,
      }),
    });

    render(<OnboardingWizardPage />);

    // Step 1
    fireEvent.change(screen.getByTestId("onboarding-tenant-name"), {
      target: { value: "Sunrise Hospital" },
    });
    fireEvent.change(screen.getByTestId("onboarding-tenant-subdomain"), {
      target: { value: "sunrise" },
    });
    fireEvent.click(screen.getByTestId("onboarding-next"));

    // Step 2
    await waitFor(() => screen.getByTestId("onboarding-step-2"));
    fireEvent.change(screen.getByTestId("onboarding-branch-name"), {
      target: { value: "Main Branch" },
    });
    fireEvent.click(screen.getByTestId("onboarding-next"));

    // Step 3
    await waitFor(() => screen.getByTestId("onboarding-step-3"));
    fireEvent.change(screen.getByTestId("onboarding-admin-name"), {
      target: { value: "Admin User" },
    });
    fireEvent.change(screen.getByTestId("onboarding-admin-email"), {
      target: { value: "admin@sunrise.test" },
    });
    fireEvent.change(screen.getByTestId("onboarding-admin-phone"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByTestId("onboarding-admin-password"), {
      target: { value: "secret-pass-1" },
    });

    fireEvent.click(screen.getByTestId("onboarding-submit"));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/v1/tenant-onboarding",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const callArgs = (global.fetch as any).mock.calls[0][1];
    const sent = JSON.parse(callArgs.body);
    expect(sent.tenant.subdomain).toBe("sunrise");
    expect(sent.branch.name).toBe("Main Branch");
    expect(sent.admin.email).toBe("admin@sunrise.test");
  });

  it("surfaces a server-side 409 inline via onboarding-error-banner", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        data: null,
        error: "Subdomain already taken",
        field: "tenant.subdomain",
      }),
    });

    render(<OnboardingWizardPage />);

    // Walk through all 3 steps with valid data, then submit.
    fireEvent.change(screen.getByTestId("onboarding-tenant-name"), {
      target: { value: "Sunrise Hospital" },
    });
    fireEvent.change(screen.getByTestId("onboarding-tenant-subdomain"), {
      target: { value: "sunrise" },
    });
    fireEvent.click(screen.getByTestId("onboarding-next"));

    await waitFor(() => screen.getByTestId("onboarding-step-2"));
    fireEvent.change(screen.getByTestId("onboarding-branch-name"), {
      target: { value: "Main Branch" },
    });
    fireEvent.click(screen.getByTestId("onboarding-next"));

    await waitFor(() => screen.getByTestId("onboarding-step-3"));
    fireEvent.change(screen.getByTestId("onboarding-admin-name"), {
      target: { value: "Admin User" },
    });
    fireEvent.change(screen.getByTestId("onboarding-admin-email"), {
      target: { value: "admin@sunrise.test" },
    });
    fireEvent.change(screen.getByTestId("onboarding-admin-phone"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByTestId("onboarding-admin-password"), {
      target: { value: "secret-pass-1" },
    });
    fireEvent.click(screen.getByTestId("onboarding-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-error-banner")).toHaveTextContent(
        /subdomain already taken/i,
      );
    });
    // Server returned field=tenant.subdomain → wizard bounces to step 1.
    expect(screen.getByTestId("onboarding-step-1")).toBeInTheDocument();
  });
});
