/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for the super-admin onboarding wizard (gap #6 piece 2 of 4
// + piece 2b wizard steps — WhatsApp (step 4) and HFR (step 5)).
//
// Covers:
//   - Step 1 renders by default. Filling tenant fields + clicking Next
//     advances to step 2 (renders onboarding-step-2).
//   - Filling step-2 → Next → step-3 → submit triggers a fetch to
//     /api/v1/tenant-onboarding.
//   - On successful tenant creation, the wizard advances to step 4
//     (WhatsApp Business API).
//   - A server-side 409 with {error, field} renders the
//     onboarding-error-banner and bounces back to step 1.
//   - Step 4 ("WhatsApp") renders Gupshup fields, has a "Skip for now"
//     button that advances to step 5, and a "Configure WhatsApp" save
//     action that stores a sessionStorage draft + surfaces the
//     deferred-config CTA.
//   - Step 4 validation rejects malformed source phones inline.
//   - Step 5 ("HFR") renders the facility fields, has a "Skip for now"
//     button that completes the wizard, and a "Configure HFR" save
//     action that stores a sessionStorage draft + surfaces the
//     /dashboard/settings/abdm CTA.
//   - Step 5 validation rejects malformed HFR IDs inline.
//   - Skip-for-now on step 5 bypasses without persisting.
//   - 44px touch invariant on the primary wizard buttons (incl. step 5).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { routerPush } = vi.hoisted(() => ({
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/super-admin/onboard"
}));

import OnboardingWizardPage from "../page";

const SUCCESS_RESPONSE = {
  success: true,
  data: {
    tenant: { id: "new-id", name: "Sunrise Hospital", subdomain: "sunrise" },
    branch: { id: "b1" },
    admin: { id: "u1" },
  },
  error: null,
};

async function walkToStep4() {
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

  await waitFor(() => screen.getByTestId("onboarding-step-4"));
}

async function walkToStep5() {
  await walkToStep4();
  // The cheapest way to step into 5 is via the Skip button on step 4 —
  // it bypasses Gupshup field requirements and advances directly.
  fireEvent.click(screen.getByTestId("onboarding-wa-skip"));
  await waitFor(() => screen.getByTestId("onboarding-step-5"));
}

describe("Super-admin onboarding wizard — gap #6 piece 2 (+ piece 2b WhatsApp & HFR steps)", () => {
  beforeEach(() => {
    routerPush.mockReset();
    (global.fetch as any) = vi.fn();
    try {
      sessionStorage.clear();
    } catch {
      /* jsdom in some configs lacks sessionStorage — best-effort */
    }
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

  it("renders a 5-step indicator (WhatsApp is the 4th, HFR is the 5th)", () => {
    render(<OnboardingWizardPage />);
    expect(
      screen.getByTestId("onboarding-step-indicator-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-2"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-3"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-4"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-4"),
    ).toHaveTextContent(/whatsapp/i);
    expect(
      screen.getByTestId("onboarding-step-indicator-5"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-5"),
    ).toHaveTextContent(/hfr/i);
  });

  it("submits the full payload to /api/v1/tenant-onboarding and advances to step 4", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
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

    // After tenant creation, step 4 (WhatsApp) is shown.
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-4")).toBeInTheDocument();
    });
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

  it("step 4 surfaces a 'Skip for now' button that advances to step 5 (HFR)", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep4();

    const skipBtn = screen.getByTestId("onboarding-wa-skip");
    expect(skipBtn).toBeInTheDocument();
    fireEvent.click(skipBtn);

    // Step 5 (HFR) is the new post-WhatsApp step — the wizard no longer
    // completes after skipping WhatsApp.
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-5")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("onboarding-success")).not.toBeInTheDocument();
  });

  it("step 4 saves a Gupshup draft to sessionStorage + surfaces the deferred-config CTA", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep4();

    // Fill the Gupshup fields.
    fireEvent.change(screen.getByTestId("onboarding-wa-apikey"), {
      target: { value: "gupshup-key-xyz" },
    });
    fireEvent.change(screen.getByTestId("onboarding-wa-appname"), {
      target: { value: "sunrise-prod" },
    });
    fireEvent.change(screen.getByTestId("onboarding-wa-sourcephone"), {
      target: { value: "+919876543210" },
    });

    fireEvent.click(screen.getByTestId("onboarding-wa-save"));

    // Saved-banner + CTA renders.
    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-wa-saved-banner"),
      ).toBeInTheDocument();
    });
    const cta = screen.getByTestId("onboarding-wa-cta");
    expect(cta).toHaveAttribute("href", "/dashboard/settings/whatsapp");

    // Draft stashed in sessionStorage under the new tenant's id.
    const raw = sessionStorage.getItem("medcore_wa_draft:new-id");
    expect(raw).toBeTruthy();
    const draft = JSON.parse(raw!);
    expect(draft.credentials.provider).toBe("GUPSHUP");
    expect(draft.credentials.apiKey).toBe("gupshup-key-xyz");
    expect(draft.credentials.appName).toBe("sunrise-prod");
    expect(draft.credentials.sourcePhone).toBe("+919876543210");
    expect(draft.autoReply).toBe(true);
  });

  it("step 4 rejects a malformed source phone inline", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep4();

    fireEvent.change(screen.getByTestId("onboarding-wa-apikey"), {
      target: { value: "gupshup-key-xyz" },
    });
    fireEvent.change(screen.getByTestId("onboarding-wa-appname"), {
      target: { value: "sunrise-prod" },
    });
    fireEvent.change(screen.getByTestId("onboarding-wa-sourcephone"), {
      // Missing leading + → not E.164.
      target: { value: "919876543210" },
    });

    fireEvent.click(screen.getByTestId("onboarding-wa-save"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-error-banner")).toHaveTextContent(
        /e\.164/i,
      );
    });
    // The save-banner did NOT render.
    expect(
      screen.queryByTestId("onboarding-wa-saved-banner"),
    ).not.toBeInTheDocument();
  });

  it("step 5 renders HFR fields and surfaces the Skip-for-now + Configure HFR buttons", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep5();

    expect(screen.getByTestId("onboarding-step-5")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-facilityname")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-id")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-facilitytype")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-state")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-district")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-skip")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hfr-save")).toBeInTheDocument();
  });

  it("step 5 'Skip for now' bypasses without persisting a draft and completes the wizard", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep5();

    fireEvent.click(screen.getByTestId("onboarding-hfr-skip"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-success")).toBeInTheDocument();
    });
    // No HFR draft written to sessionStorage when the user skips.
    expect(sessionStorage.getItem("medcore_hfr_draft:new-id")).toBeNull();
  });

  it("step 5 saves an HFR draft to sessionStorage + surfaces the deferred-config CTA", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep5();

    fireEvent.change(screen.getByTestId("onboarding-hfr-facilityname"), {
      target: { value: "Sunrise Hospital" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hfr-id"), {
      target: { value: "1234567890" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hfr-facilitytype"), {
      target: { value: "CLINIC" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hfr-state"), {
      target: { value: "Karnataka" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hfr-district"), {
      target: { value: "Bengaluru Urban" },
    });

    fireEvent.click(screen.getByTestId("onboarding-hfr-save"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-hfr-saved-banner"),
      ).toBeInTheDocument();
    });
    const cta = screen.getByTestId("onboarding-hfr-cta");
    expect(cta).toHaveAttribute("href", "/dashboard/settings/abdm");

    const raw = sessionStorage.getItem("medcore_hfr_draft:new-id");
    expect(raw).toBeTruthy();
    const draft = JSON.parse(raw!);
    expect(draft.facilityName).toBe("Sunrise Hospital");
    expect(draft.hfrId).toBe("1234567890");
    expect(draft.facilityType).toBe("CLINIC");
    expect(draft.state).toBe("Karnataka");
    expect(draft.district).toBe("Bengaluru Urban");
  });

  it("step 5 rejects a malformed HFR ID inline", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep5();

    fireEvent.change(screen.getByTestId("onboarding-hfr-facilityname"), {
      target: { value: "Sunrise Hospital" },
    });
    // Numeric-only filter on the input strips letters, so to exercise
    // the validator we pass a too-short numeric value.
    fireEvent.change(screen.getByTestId("onboarding-hfr-id"), {
      target: { value: "12345" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hfr-state"), {
      target: { value: "Karnataka" },
    });

    fireEvent.click(screen.getByTestId("onboarding-hfr-save"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-error-banner")).toHaveTextContent(
        /hfr id must be 10-12 digits/i,
      );
    });
    // The save-banner did NOT render.
    expect(
      screen.queryByTestId("onboarding-hfr-saved-banner"),
    ).not.toBeInTheDocument();
    // And no draft written.
    expect(sessionStorage.getItem("medcore_hfr_draft:new-id")).toBeNull();
  });

  it("primary wizard buttons honour the 44px touch invariant", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);

    // step-1 Next button
    const nextBtn = screen.getByTestId("onboarding-next");
    expect(nextBtn.style.minHeight).toBe("44px");

    // Step 3 submit button
    fireEvent.change(screen.getByTestId("onboarding-tenant-name"), {
      target: { value: "Sunrise Hospital" },
    });
    fireEvent.change(screen.getByTestId("onboarding-tenant-subdomain"), {
      target: { value: "sunrise" },
    });
    fireEvent.click(screen.getByTestId("onboarding-next"));
    await waitFor(() => screen.getByTestId("onboarding-step-2"));
    fireEvent.change(screen.getByTestId("onboarding-branch-name"), {
      target: { value: "Main" },
    });
    fireEvent.click(screen.getByTestId("onboarding-next"));
    await waitFor(() => screen.getByTestId("onboarding-step-3"));

    const submitBtn = screen.getByTestId("onboarding-submit");
    expect(submitBtn.style.minHeight).toBe("44px");

    // Step 4 skip/save buttons
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

    await waitFor(() => screen.getByTestId("onboarding-step-4"));
    expect(
      (screen.getByTestId("onboarding-wa-skip") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
    expect(
      (screen.getByTestId("onboarding-wa-save") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");

    // Advance to step 5 and check the HFR action buttons too.
    fireEvent.click(screen.getByTestId("onboarding-wa-skip"));
    await waitFor(() => screen.getByTestId("onboarding-step-5"));
    expect(
      (screen.getByTestId("onboarding-hfr-skip") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
    expect(
      (screen.getByTestId("onboarding-hfr-save") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
  });
});
