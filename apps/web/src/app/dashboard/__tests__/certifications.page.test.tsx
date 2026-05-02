/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
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

import CertificationsPage from "../certifications/page";

const sampleCert = {
  id: "c1",
  userId: "u1",
  type: "MEDICAL_LICENSE",
  title: "MBBS Reg",
  issuingBody: "MCI",
  certNumber: "MED-001",
  issuedDate: "2020-05-01",
  expiryDate: "2030-05-01",
  status: "ACTIVE",
  notes: null,
  user: { id: "u1", name: "Dr. Aarav", role: "DOCTOR" },
};

describe("CertificationsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    toastMock.error.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the heading", async () => {
    render(<CertificationsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /staff certifications/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the empty-state when no certs returned", async () => {
    render(<CertificationsPage />);
    await waitFor(() =>
      expect(screen.getByText(/no certifications found/i)).toBeInTheDocument()
    );
  });

  it("renders rows when certifications exist", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleCert] });
    render(<CertificationsPage />);
    await waitFor(() =>
      expect(screen.getByText(/mbbs reg/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/dr\. aarav/i)).toBeInTheDocument();
  });

  it("toasts an error when the load endpoint rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500 Server"));
    render(<CertificationsPage />);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/500 server|failed to load/i)
      )
    );
  });

  it("renders the All / Expiring / Expired filter buttons", async () => {
    render(<CertificationsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /expiring/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^expired$/i })).toBeInTheDocument();
  });
});
