/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import VerifyPrescriptionPage from "./page";

const verifyData = {
  ok: true,
  prescriptionId: "rx-9",
  patientInitial: "A",
  doctorName: "Asha Gupta",
  dateIssued: "12 May 2026",
  status: "Issued",
  hospital: {
    name: "MedCore Hospital",
    address: "Bangalore",
    phone: "+919999999999",
    email: "info@medcore.test",
  },
};

async function renderPage(id: string) {
  const params = Promise.resolve({ id });
  const node = await VerifyPrescriptionPage({ params } as any);
  return render(node as any);
}

describe("VerifyPrescriptionPage (server component)", () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify(verifyData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("renders Verified Prescription card on happy path", async () => {
    await renderPage("rx-9");
    expect(
      screen.getByRole("heading", { name: /verified prescription/i })
    ).toBeInTheDocument();
  });

  it("renders the prescription ID and doctor name", async () => {
    await renderPage("rx-9");
    expect(screen.getByText("rx-9")).toBeInTheDocument();
    expect(screen.getAllByText(/asha gupta/i).length).toBeGreaterThan(0);
  });

  it("renders the hospital letterhead name", async () => {
    await renderPage("rx-9");
    expect(
      screen.getByRole("heading", { name: /medcore hospital/i })
    ).toBeInTheDocument();
  });

  it("renders Prescription Not Found when API returns 404", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response("not found", { status: 404 })
    );
    await renderPage("missing-id");
    expect(
      screen.getByRole("heading", { name: /prescription not found/i })
    ).toBeInTheDocument();
  });

  it("renders Prescription Not Found when fetch throws", async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    await renderPage("any-id");
    expect(
      screen.getByRole("heading", { name: /prescription not found/i })
    ).toBeInTheDocument();
  });
});
