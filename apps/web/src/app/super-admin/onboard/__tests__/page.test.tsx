/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for the super-admin onboarding wizard (gap #6 piece 2 of 4
// + piece 2b wizard steps — WhatsApp (step 4), HFR (step 5), HPR
// (step 6), Razorpay (step 7)).
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
//     button that advances to step 6 (no longer completes the wizard
//     since HPR was appended), and a "Configure HFR" save action that
//     stores a sessionStorage draft + surfaces the
//     /dashboard/settings/abdm CTA.
//   - Step 5 validation rejects malformed HFR IDs inline.
//   - Skip-for-now on step 5 bypasses without persisting + advances to
//     step 6.
//   - Step 6 ("HPR") renders the professional-registry fields with
//     prefilled doctor name, has a "Skip for now" button that advances
//     to step 7 (Razorpay was appended), and a "Configure HPR" save
//     action that stores a sessionStorage draft + surfaces the
//     /dashboard/settings/abdm CTA.
//   - Step 6 validation rejects malformed HPR IDs inline.
//   - Skip-for-now on step 6 bypasses without persisting + advances to
//     step 7.
//   - Step 7 ("Razorpay") renders payment-gateway fields with mode
//     defaulting to TEST and business name prefilled from step-1
//     tenant name, has a "Skip for now" button that completes the
//     wizard, and a "Configure Razorpay" save action that stores a
//     sessionStorage draft + surfaces the /dashboard/settings/payments
//     CTA.
//   - Step 7 validation rejects malformed Razorpay key IDs inline.
//   - Skip-for-now on step 7 bypasses without persisting + completes
//     the wizard.
//   - Step indicator renders all 7 steps.
//   - 44px touch invariant on the primary wizard buttons (incl. steps
//     5, 6 + 7).

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

async function walkToStep6() {
  await walkToStep5();
  // Same skip-trick — the HFR skip button now advances to step 6
  // (HPR) instead of completing the wizard.
  fireEvent.click(screen.getByTestId("onboarding-hfr-skip"));
  await waitFor(() => screen.getByTestId("onboarding-step-6"));
}

async function walkToStep7() {
  await walkToStep6();
  // Same skip-trick — the HPR skip button now advances to step 7
  // (Razorpay) instead of completing the wizard.
  fireEvent.click(screen.getByTestId("onboarding-hpr-skip"));
  await waitFor(() => screen.getByTestId("onboarding-step-7"));
}

describe("Super-admin onboarding wizard — gap #6 piece 2 (+ piece 2b WhatsApp, HFR, HPR & Razorpay steps)", () => {
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

  it("renders a 7-step indicator (WhatsApp is the 4th, HFR is the 5th, HPR is the 6th, Razorpay is the 7th)", () => {
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
    expect(
      screen.getByTestId("onboarding-step-indicator-6"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-6"),
    ).toHaveTextContent(/hpr/i);
    expect(
      screen.getByTestId("onboarding-step-indicator-7"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-step-indicator-7"),
    ).toHaveTextContent(/razorpay/i);
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

  it("step 5 'Skip for now' bypasses without persisting a draft and advances to step 6 (HPR)", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep5();

    fireEvent.click(screen.getByTestId("onboarding-hfr-skip"));

    // Step 6 (HPR) is the new post-HFR step — the wizard no longer
    // completes after skipping HFR.
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-6")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("onboarding-success")).not.toBeInTheDocument();
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

  it("step 6 renders HPR fields with doctor name prefilled from step-3 super-admin", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep6();

    expect(screen.getByTestId("onboarding-step-6")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hpr-id")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hpr-doctorname")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hpr-specialty")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hpr-councilreg")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hpr-skip")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-hpr-save")).toBeInTheDocument();

    // Prefill convention: the doctor-name field defaults to the super-
    // admin name typed in step 3 ("Admin User" in walkToStep4).
    expect(
      (screen.getByTestId("onboarding-hpr-doctorname") as HTMLInputElement)
        .value,
    ).toBe("Admin User");
  });

  it("step 6 'Skip for now' bypasses without persisting a draft and advances to step 7 (Razorpay)", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep6();

    fireEvent.click(screen.getByTestId("onboarding-hpr-skip"));

    // Step 7 (Razorpay) is the new post-HPR step — the wizard no
    // longer completes after skipping HPR.
    await waitFor(() => {
      expect(screen.getByTestId("onboarding-step-7")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("onboarding-success")).not.toBeInTheDocument();
    // No HPR draft written to sessionStorage when the user skips.
    expect(sessionStorage.getItem("medcore_hpr_draft:new-id")).toBeNull();
  });

  it("step 6 saves an HPR draft to sessionStorage + surfaces the deferred-config CTA", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep6();

    fireEvent.change(screen.getByTestId("onboarding-hpr-id"), {
      target: { value: "9876543210" },
    });
    // Override the prefilled doctor name.
    fireEvent.change(screen.getByTestId("onboarding-hpr-doctorname"), {
      target: { value: "Dr. Asha Rao" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hpr-specialty"), {
      target: { value: "CARDIOLOGY" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hpr-councilreg"), {
      target: { value: "MMC-12345" },
    });

    fireEvent.click(screen.getByTestId("onboarding-hpr-save"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-hpr-saved-banner"),
      ).toBeInTheDocument();
    });
    const cta = screen.getByTestId("onboarding-hpr-cta");
    expect(cta).toHaveAttribute("href", "/dashboard/settings/abdm");

    const raw = sessionStorage.getItem("medcore_hpr_draft:new-id");
    expect(raw).toBeTruthy();
    const draft = JSON.parse(raw!);
    expect(draft.hprId).toBe("9876543210");
    expect(draft.doctorName).toBe("Dr. Asha Rao");
    expect(draft.specialty).toBe("CARDIOLOGY");
    expect(draft.councilRegNo).toBe("MMC-12345");
  });

  it("step 6 rejects a malformed HPR ID inline", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep6();

    // Numeric-only filter on the input strips letters; a too-short
    // numeric value exercises the validator.
    fireEvent.change(screen.getByTestId("onboarding-hpr-id"), {
      target: { value: "12345" },
    });
    fireEvent.change(screen.getByTestId("onboarding-hpr-councilreg"), {
      target: { value: "MMC-1" },
    });

    fireEvent.click(screen.getByTestId("onboarding-hpr-save"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-error-banner")).toHaveTextContent(
        /hpr id must be 10-12 digits/i,
      );
    });
    // The save-banner did NOT render.
    expect(
      screen.queryByTestId("onboarding-hpr-saved-banner"),
    ).not.toBeInTheDocument();
    // And no draft written.
    expect(sessionStorage.getItem("medcore_hpr_draft:new-id")).toBeNull();
  });

  it("step 7 renders Razorpay fields with mode defaulting to TEST and business name prefilled from tenant", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep7();

    expect(screen.getByTestId("onboarding-step-7")).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-rzp-businessname"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-rzp-keyid")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-rzp-keysecret")).toBeInTheDocument();
    expect(
      screen.getByTestId("onboarding-rzp-webhooksecret"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-rzp-mode")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-rzp-skip")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-rzp-save")).toBeInTheDocument();

    // Business name defaults to the step-1 tenant name ("Sunrise Hospital").
    expect(
      (screen.getByTestId("onboarding-rzp-businessname") as HTMLInputElement)
        .value,
    ).toBe("Sunrise Hospital");
    // Mode toggle defaults to TEST.
    expect(
      screen.getByTestId("onboarding-rzp-mode-test"),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByTestId("onboarding-rzp-mode-live"),
    ).toHaveAttribute("aria-checked", "false");
    // Secret inputs default to password type (masked).
    expect(
      (screen.getByTestId("onboarding-rzp-keysecret") as HTMLInputElement)
        .type,
    ).toBe("password");
    expect(
      (screen.getByTestId("onboarding-rzp-webhooksecret") as HTMLInputElement)
        .type,
    ).toBe("password");
  });

  it("step 7 'Skip for now' bypasses without persisting a draft and completes the wizard", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep7();

    fireEvent.click(screen.getByTestId("onboarding-rzp-skip"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-success")).toBeInTheDocument();
    });
    // No Razorpay draft written to sessionStorage when the user skips.
    expect(
      sessionStorage.getItem("medcore_razorpay_draft:new-id"),
    ).toBeNull();
  });

  it("step 7 saves a Razorpay draft to sessionStorage + surfaces the deferred-config CTA", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep7();

    fireEvent.change(screen.getByTestId("onboarding-rzp-keyid"), {
      target: { value: "rzp_test_ABCDEF1234567890" },
    });
    fireEvent.change(screen.getByTestId("onboarding-rzp-keysecret"), {
      target: { value: "shhh-secret-1" },
    });
    fireEvent.change(screen.getByTestId("onboarding-rzp-webhooksecret"), {
      target: { value: "webhook-secret-1" },
    });
    // Switch mode to LIVE.
    fireEvent.click(screen.getByTestId("onboarding-rzp-mode-live"));

    fireEvent.click(screen.getByTestId("onboarding-rzp-save"));

    await waitFor(() => {
      expect(
        screen.getByTestId("onboarding-rzp-saved-banner"),
      ).toBeInTheDocument();
    });
    const cta = screen.getByTestId("onboarding-rzp-cta");
    expect(cta).toHaveAttribute("href", "/dashboard/settings/payments");

    const raw = sessionStorage.getItem("medcore_razorpay_draft:new-id");
    expect(raw).toBeTruthy();
    const draft = JSON.parse(raw!);
    expect(draft.businessName).toBe("Sunrise Hospital");
    expect(draft.keyId).toBe("rzp_test_ABCDEF1234567890");
    expect(draft.keySecret).toBe("shhh-secret-1");
    expect(draft.webhookSecret).toBe("webhook-secret-1");
    expect(draft.mode).toBe("LIVE");
  });

  it("step 7 rejects a malformed Razorpay key ID inline", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => SUCCESS_RESPONSE,
    });

    render(<OnboardingWizardPage />);
    await walkToStep7();

    fireEvent.change(screen.getByTestId("onboarding-rzp-keyid"), {
      target: { value: "rzp_mystery_xxx" },
    });
    fireEvent.change(screen.getByTestId("onboarding-rzp-keysecret"), {
      target: { value: "shhh-secret-1" },
    });
    fireEvent.change(screen.getByTestId("onboarding-rzp-webhooksecret"), {
      target: { value: "webhook-secret-1" },
    });

    fireEvent.click(screen.getByTestId("onboarding-rzp-save"));

    await waitFor(() => {
      expect(screen.getByTestId("onboarding-error-banner")).toHaveTextContent(
        /rzp_live_xxxxxxxxxxxx or rzp_test_xxxxxxxxxxxx/i,
      );
    });
    // The save-banner did NOT render.
    expect(
      screen.queryByTestId("onboarding-rzp-saved-banner"),
    ).not.toBeInTheDocument();
    // And no draft written.
    expect(
      sessionStorage.getItem("medcore_razorpay_draft:new-id"),
    ).toBeNull();
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

    // Advance to step 6 and check the HPR action buttons too.
    fireEvent.click(screen.getByTestId("onboarding-hfr-skip"));
    await waitFor(() => screen.getByTestId("onboarding-step-6"));
    expect(
      (screen.getByTestId("onboarding-hpr-skip") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
    expect(
      (screen.getByTestId("onboarding-hpr-save") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");

    // Advance to step 7 and check the Razorpay action buttons too.
    fireEvent.click(screen.getByTestId("onboarding-hpr-skip"));
    await waitFor(() => screen.getByTestId("onboarding-step-7"));
    expect(
      (screen.getByTestId("onboarding-rzp-skip") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
    expect(
      (screen.getByTestId("onboarding-rzp-save") as HTMLButtonElement).style
        .minHeight,
    ).toBe("44px");
  });
});
