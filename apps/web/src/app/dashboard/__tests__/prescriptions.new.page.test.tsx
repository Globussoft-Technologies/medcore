/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams("patientId=pat-9"),
  usePathname: () => "/dashboard/prescriptions/new",
}));

import WritePrescriptionRedirectPage from "../prescriptions/new/page";

describe("WritePrescriptionRedirectPage", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

  it("renders the redirect placeholder", () => {
    render(<WritePrescriptionRedirectPage />);
    expect(screen.getByTestId("rx-new-redirect")).toBeInTheDocument();
  });

  it("shows the 'Opening prescription form' message", () => {
    render(<WritePrescriptionRedirectPage />);
    expect(screen.getByText(/opening prescription form/i)).toBeInTheDocument();
  });

  it("calls router.replace with /dashboard/prescriptions?new=1&patientId=…", async () => {
    render(<WritePrescriptionRedirectPage />);
    await waitFor(() => expect(routerReplace).toHaveBeenCalled());
    const calledWith = String(routerReplace.mock.calls[0]?.[0] ?? "");
    expect(calledWith).toMatch(/^\/dashboard\/prescriptions\?/);
    expect(calledWith).toContain("new=1");
    expect(calledWith).toContain("patientId=pat-9");
  });

  it("does not throw when re-rendered", () => {
    expect(() => {
      render(<WritePrescriptionRedirectPage />);
      render(<WritePrescriptionRedirectPage />);
    }).not.toThrow();
  });
});
