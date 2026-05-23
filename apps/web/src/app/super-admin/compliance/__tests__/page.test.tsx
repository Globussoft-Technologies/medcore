/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/compliance — Pearl §8.6 (gap row 225).
//
// Covers:
//   - Table renders with tenant rows from mocked posture data.
//   - RED badge appears for a TOTP-violating tenant; AMBER for low ABHA.
//   - Summary cards show violation counts.
//   - API 403 path surfaces as an inline error alert.
//
// fetch is stubbed at the global level so the page can be unit-tested
// without the real API.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const sampleResponse = {
  success: true,
  data: {
    tenants: [
      {
        // TOTP-violating: requireAdminTOTP=true but 1/3 enrolled.
        tenantId: "t-violator",
        tenantName: "Violator Hospital",
        active: true,
        patientCount: 500,
        abhaLinkedCount: 250,
        abhaLinkedPct: 0.5,
        dpdpRequestsLast30d: 2,
        auditRowsLast30d: 1500,
        adminCount: 3,
        totpEnrolledAdminCount: 1,
        requireAdminTOTP: true,
        lastDpdpAt: new Date(
          Date.now() - 2 * 24 * 60 * 60_000,
        ).toISOString(),
        lastAuditAt: new Date(
          Date.now() - 1 * 60 * 60_000,
        ).toISOString(),
      },
      {
        // Low-ABHA: 200 patients, 5% ABHA-linked.
        tenantId: "t-low-abha",
        tenantName: "LowAbha Clinic",
        active: true,
        patientCount: 200,
        abhaLinkedCount: 10,
        abhaLinkedPct: 0.05,
        dpdpRequestsLast30d: 0,
        auditRowsLast30d: 500,
        adminCount: 2,
        totpEnrolledAdminCount: 2,
        requireAdminTOTP: true,
        lastDpdpAt: null,
        lastAuditAt: new Date(
          Date.now() - 3 * 60 * 60_000,
        ).toISOString(),
      },
      {
        // Compliant tenant.
        tenantId: "t-ok",
        tenantName: "Healthy Hospital",
        active: true,
        patientCount: 1000,
        abhaLinkedCount: 800,
        abhaLinkedPct: 0.8,
        dpdpRequestsLast30d: 0,
        auditRowsLast30d: 3000,
        adminCount: 4,
        totpEnrolledAdminCount: 4,
        requireAdminTOTP: true,
        lastDpdpAt: null,
        lastAuditAt: new Date(
          Date.now() - 30 * 60_000,
        ).toISOString(),
      },
    ],
    snapshotAt: new Date().toISOString(),
  },
  error: null,
};

const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
}));

function mockOk() {
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => sampleResponse,
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  mockOk();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminCompliancePage from "../page";

describe("Super-admin /super-admin/compliance page — Pearl §8.6", () => {
  it("renders one row per tenant with the expected values", async () => {
    render(<SuperAdminCompliancePage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-compliance-row-t-violator"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("super-admin-compliance-row-t-low-abha"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("super-admin-compliance-row-t-ok"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("super-admin-compliance-abha-t-violator")
        .textContent,
    ).toMatch(/50\.0%/);
    expect(
      screen.getByTestId("super-admin-compliance-totp-t-violator")
        .textContent,
    ).toMatch(/1\/3/);
  });

  it("applies RED badge to TOTP-violating tenant + AMBER to low-ABHA tenant", async () => {
    render(<SuperAdminCompliancePage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-compliance-row-t-violator"),
      ).toBeInTheDocument();
    });
    // RED badge for the violator.
    expect(
      screen.getByTestId(
        "super-admin-compliance-badge-red-t-violator",
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId("super-admin-compliance-row-t-violator")
        .getAttribute("data-posture"),
    ).toBe("red");

    // AMBER badge for the low-ABHA tenant.
    expect(
      screen.getByTestId(
        "super-admin-compliance-badge-amber-t-low-abha",
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getByTestId("super-admin-compliance-row-t-low-abha")
        .getAttribute("data-posture"),
    ).toBe("amber");

    // Compliant tenant has neither badge.
    expect(
      screen
        .getByTestId("super-admin-compliance-row-t-ok")
        .getAttribute("data-posture"),
    ).toBe("ok");
    expect(
      screen.queryByTestId("super-admin-compliance-badge-red-t-ok"),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        "super-admin-compliance-badge-amber-t-ok",
      ),
    ).toBeNull();
  });

  it("summary cards count violations correctly", async () => {
    render(<SuperAdminCompliancePage />);
    await waitFor(() => {
      expect(
        screen.getByTestId(
          "super-admin-compliance-summary-totp-violations",
        ).textContent,
      ).toMatch(/1/);
    });
    expect(
      screen.getByTestId(
        "super-admin-compliance-summary-low-abha",
      ).textContent,
    ).toMatch(/1/);
    expect(
      screen.getByTestId("super-admin-compliance-summary-tenants")
        .textContent,
    ).toMatch(/3/);
  });

  it("surfaces an API failure as an inline error alert", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        data: null,
        error: "Only super-admins can view per-tenant compliance posture",
      }),
    }));
    render(<SuperAdminCompliancePage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-compliance-error").textContent,
      ).toMatch(/super-admins/i);
    });
  });
});
