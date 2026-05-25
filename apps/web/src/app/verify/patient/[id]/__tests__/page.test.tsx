// Unit tests for the public patient-verification page (server component) at
// /verify/patient/[id]/page.tsx. The page is reached via QR scan from the
// printed patient ID card and consumes /api/v1/public/verify/patient/:id.
// Mirrors the contract proven by the API-side integration suite
// (apps/api/src/test/integration/public-patient.test.ts):
//   - happy path renders the safe summary fields (name, MR#, age, gender,
//     blood group, emergency contact, hospital letterhead).
//   - 404 / fetch error renders the "Patient Not Found" shell, NOT a crash.
//   - the rendered HTML MUST NOT include patient address, DOB, insurance, or
//     any other field outside the published VerifyData type.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import VerifyPatientPage from "../page";

const safeData = {
  ok: true,
  patientId: "patient-123",
  mrNumber: "MR-000042",
  name: "Verify Test Patient",
  age: 42,
  gender: "MALE",
  bloodGroup: "A+",
  emergencyContactName: "Spouse Of Patient",
  emergencyContactPhone: "9999988888",
  hospital: {
    name: "MedCore Demo Hospital",
    address: "1 Demo Lane, Bangalore",
    phone: "+91-80-12345678",
    email: "info@medcore-demo.test",
    logoUrl: "",
    tagline: "Care, codified",
  },
};

function mockFetchOk(body: unknown) {
  (globalThis as any).fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function mockFetchStatus(status: number, body: unknown = "") {
  (globalThis as any).fetch = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })
  );
}

async function renderPage(id: string) {
  const params = Promise.resolve({ id });
  const node = await VerifyPatientPage({ params } as any);
  return render(node as any);
}

describe("VerifyPatientPage (server component)", () => {
  beforeEach(() => {
    mockFetchOk(safeData);
  });

  it("renders the Verified Patient hero on happy path", async () => {
    await renderPage("patient-123");
    expect(
      screen.getByRole("heading", { name: /verified patient/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/verified — authentic patient id/i)
    ).toBeInTheDocument();
  });

  it("renders name, MR number, age/gender, blood group and emergency contact", async () => {
    await renderPage("patient-123");
    expect(screen.getByText("Verify Test Patient")).toBeInTheDocument();
    expect(screen.getByText("MR-000042")).toBeInTheDocument();
    expect(screen.getByText(/42 \/ MALE/)).toBeInTheDocument();
    expect(screen.getByText("A+")).toBeInTheDocument();
    expect(screen.getByText("Spouse Of Patient")).toBeInTheDocument();

    const tel = screen.getByRole("link", { name: /9999988888/ });
    expect(tel).toHaveAttribute("href", "tel:9999988888");
  });

  it("renders the hospital letterhead (name, tagline, address)", async () => {
    await renderPage("patient-123");
    expect(
      screen.getByRole("heading", { name: /medcore demo hospital/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/care, codified/i)).toBeInTheDocument();
    expect(screen.getByText(/1 demo lane, bangalore/i)).toBeInTheDocument();
    expect(screen.getByText(/registered with medcore demo hospital/i)).toBeInTheDocument();
  });

  it("falls back to a letter-avatar when hospital logoUrl is empty", async () => {
    await renderPage("patient-123");
    // logoUrl is "" → no <img>, the initial-letter badge is rendered instead.
    // The badge shows the first character of the hospital name ("M").
    expect(screen.queryByRole("img", { name: /logo/i })).toBeNull();
  });

  it("renders the hospital logo <img> when logoUrl is provided", async () => {
    mockFetchOk({
      ...safeData,
      hospital: { ...safeData.hospital, logoUrl: "https://cdn.example/logo.png" },
    });
    await renderPage("patient-123");
    const img = screen.getByRole("img", { name: /medcore demo hospital logo/i });
    expect(img).toHaveAttribute("src", "https://cdn.example/logo.png");
  });

  it("renders Patient Not Found when API returns 404", async () => {
    mockFetchStatus(404, "not found");
    await renderPage("missing-id");
    expect(
      screen.getByRole("heading", { name: /patient not found/i })
    ).toBeInTheDocument();
    // The unverified id is echoed for the scanner's benefit.
    expect(screen.getByText("missing-id")).toBeInTheDocument();
  });

  it("renders Patient Not Found when the response body is { ok: false }", async () => {
    mockFetchOk({ ok: false, error: "Patient not found" });
    await renderPage("any-id");
    expect(
      screen.getByRole("heading", { name: /patient not found/i })
    ).toBeInTheDocument();
  });

  it("renders Patient Not Found when fetch throws (network error)", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    await renderPage("any-id");
    expect(
      screen.getByRole("heading", { name: /patient not found/i })
    ).toBeInTheDocument();
  });

  it("omits the blood group row when bloodGroup is null", async () => {
    mockFetchOk({ ...safeData, bloodGroup: null });
    await renderPage("patient-123");
    expect(screen.queryByText(/^Blood Group$/)).toBeNull();
  });

  it("omits the emergency contact row when emergencyContactPhone is null", async () => {
    mockFetchOk({
      ...safeData,
      emergencyContactName: null,
      emergencyContactPhone: null,
    });
    await renderPage("patient-123");
    expect(screen.queryByText(/^Emergency Contact$/)).toBeNull();
  });

  it("renders an em-dash when age is null", async () => {
    mockFetchOk({ ...safeData, age: null });
    await renderPage("patient-123");
    // "— / MALE"
    expect(screen.getByText(/— \/ MALE/)).toBeInTheDocument();
  });

  it("PII-leak guard: does NOT render address, DOB, insurance or other denied fields even if the API leaks them", async () => {
    // Simulate an API leak: a hostile/buggy backend returns the safe summary
    // PLUS extra fields. The page MUST silently ignore them — it only reads
    // the keys it explicitly knows about.
    mockFetchOk({
      ...safeData,
      // Field-level deny-list canaries (must NOT appear in rendered HTML):
      address: "Secret-Address-PII-LEAK-CANARY-13579",
      dateOfBirth: "1984-01-02",
      insurancePolicyNumber: "POL-PII-LEAK-CANARY-24680",
      insuranceProvider: "Provider-PII-LEAK-CANARY-Acme",
      noShowCount: 7,
      preferredLanguage: "kn",
      user: {
        email: "leaked-email-CANARY@example.test",
        phone: "8888877777",
      },
    });

    const { container } = await renderPage("patient-123");
    const html = container.innerHTML;
    expect(html).not.toContain("Secret-Address-PII-LEAK-CANARY-13579");
    expect(html).not.toContain("1984-01-02");
    expect(html).not.toContain("POL-PII-LEAK-CANARY-24680");
    expect(html).not.toContain("Provider-PII-LEAK-CANARY-Acme");
    expect(html).not.toContain("leaked-email-CANARY@example.test");
    expect(html).not.toContain("8888877777");
  });

  it("renders the Print Verification action button", async () => {
    await renderPage("patient-123");
    const print = screen.getByRole("link", { name: /print verification/i });
    expect(print).toBeInTheDocument();
  });

  it("calls the public verify endpoint with the encoded id", async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify(safeData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    (globalThis as any).fetch = spy;
    await renderPage("patient with spaces/123");
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toMatch(/\/public\/verify\/patient\/patient%20with%20spaces%2F123$/);
  });
});
