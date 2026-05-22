// Unit tests for the NHCX cashless stub stepper (Pearl §4.2 — gap row 103).
//
// Covers:
//  • 4 Pearl stages render with correct labels (Submitted, In Review,
//    Approved, Settled).
//  • Current stage is highlighted; past stages get the done marker;
//    future stages stay ghosted (via data-active / data-done attrs so
//    we don't have to assert against Tailwind class strings).
//  • Variant pill renders for off-happy-path statuses (REJECTED,
//    QUERY_RAISED, PARTIALLY_APPROVED) and is absent for happy-path.
//  • "Move to next stage" button is ADMIN-only AND only when there's a
//    next stage; RECEPTION/DOCTOR/PATIENT never see it.
//  • Advance button calls onAdvance with the correct next status and
//    surfaces errors via the data-testid="nhcx-stepper-error" node.
//  • The button is at least 44px tall (Pearl §6.2 touch target — h-11
//    = 44px in Tailwind's spacing scale; we assert via the class
//    presence rather than measured height because jsdom doesn't lay
//    out CSS).

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NHCXStepper, {
  NHCX_STAGES,
  stageIndexFor,
  nextHappyPathStatus,
} from "../NHCXStepper";

const baseClaim = {
  id: "claim-1",
  status: "SUBMITTED",
  insuranceProvider: "Acme Insure",
  claimAmount: 12500,
  approvedAmount: null,
};

describe("NHCXStepper — Pearl §4.2 stub stepper", () => {
  it("renders all 4 Pearl stages", () => {
    render(<NHCXStepper claim={baseClaim} />);
    NHCX_STAGES.forEach((stage, idx) => {
      const node = screen.getByTestId(`nhcx-stepper-stage-${idx}`);
      expect(node).toHaveAttribute("data-stage-key", stage.key);
      expect(node.textContent).toMatch(stage.label);
    });
  });

  it("highlights the current stage based on claim.status", () => {
    render(<NHCXStepper claim={{ ...baseClaim, status: "APPROVED" }} />);
    // APPROVED → stage idx 2
    expect(screen.getByTestId("nhcx-stepper-stage-0")).toHaveAttribute(
      "data-done",
      "true",
    );
    expect(screen.getByTestId("nhcx-stepper-stage-1")).toHaveAttribute(
      "data-done",
      "true",
    );
    expect(screen.getByTestId("nhcx-stepper-stage-2")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("nhcx-stepper-stage-3")).toHaveAttribute(
      "data-done",
      "false",
    );
    expect(screen.getByTestId("nhcx-stepper-stage-3")).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("renders the variant pill for off-happy-path statuses", () => {
    const { rerender } = render(
      <NHCXStepper claim={{ ...baseClaim, status: "REJECTED" }} />,
    );
    expect(screen.getByTestId("nhcx-stepper-variant")).toHaveTextContent(
      /rejected/i,
    );
    rerender(<NHCXStepper claim={{ ...baseClaim, status: "QUERY_RAISED" }} />);
    expect(screen.getByTestId("nhcx-stepper-variant")).toHaveTextContent(
      /query raised/i,
    );
    rerender(
      <NHCXStepper claim={{ ...baseClaim, status: "PARTIALLY_APPROVED" }} />,
    );
    expect(screen.getByTestId("nhcx-stepper-variant")).toHaveTextContent(
      /partially approved/i,
    );
  });

  it("does NOT render a variant pill for happy-path statuses", () => {
    const happyPath = ["SUBMITTED", "IN_REVIEW", "APPROVED", "SETTLED"];
    for (const status of happyPath) {
      const { unmount } = render(
        <NHCXStepper claim={{ ...baseClaim, status }} />,
      );
      expect(screen.queryByTestId("nhcx-stepper-variant")).toBeNull();
      unmount();
    }
  });

  it("shows the Move-to-next-stage button only for ADMIN with onAdvance wired", () => {
    const noop = vi.fn(async () => undefined);
    const { rerender } = render(
      <NHCXStepper claim={baseClaim} userRole="ADMIN" onAdvance={noop} />,
    );
    expect(screen.getByTestId("nhcx-stepper-advance-btn")).toBeInTheDocument();

    for (const role of ["RECEPTION", "DOCTOR", "PATIENT", null, undefined]) {
      rerender(
        <NHCXStepper
          claim={baseClaim}
          userRole={role as string | null | undefined}
          onAdvance={noop}
        />,
      );
      expect(screen.queryByTestId("nhcx-stepper-advance-btn")).toBeNull();
    }
  });

  it("hides the Move-to-next-stage button at terminal status SETTLED", () => {
    render(
      <NHCXStepper
        claim={{ ...baseClaim, status: "SETTLED" }}
        userRole="ADMIN"
        onAdvance={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.queryByTestId("nhcx-stepper-advance-btn")).toBeNull();
  });

  it("calls onAdvance with the correct next status (SUBMITTED → APPROVED)", async () => {
    const onAdvance = vi.fn(async () => undefined);
    render(
      <NHCXStepper claim={baseClaim} userRole="ADMIN" onAdvance={onAdvance} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("nhcx-stepper-advance-btn"));
    expect(onAdvance).toHaveBeenCalledWith("APPROVED");
  });

  it("calls onAdvance with SETTLED when current is APPROVED", async () => {
    const onAdvance = vi.fn(async () => undefined);
    render(
      <NHCXStepper
        claim={{ ...baseClaim, status: "APPROVED" }}
        userRole="ADMIN"
        onAdvance={onAdvance}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("nhcx-stepper-advance-btn"));
    expect(onAdvance).toHaveBeenCalledWith("SETTLED");
  });

  it("surfaces an error message when onAdvance rejects", async () => {
    const onAdvance = vi.fn(async () => {
      throw new Error("Server said no");
    });
    render(
      <NHCXStepper claim={baseClaim} userRole="ADMIN" onAdvance={onAdvance} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("nhcx-stepper-advance-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("nhcx-stepper-error")).toHaveTextContent(
        /server said no/i,
      ),
    );
  });

  it("renders the advance button with the 44px touch-target class (h-11)", () => {
    render(
      <NHCXStepper
        claim={baseClaim}
        userRole="ADMIN"
        onAdvance={vi.fn(async () => undefined)}
      />,
    );
    const btn = screen.getByTestId("nhcx-stepper-advance-btn");
    // h-11 = 2.75rem = 44px (Tailwind default spacing scale).
    // min-w-11 is the canonical form of min-w-[44px].
    expect(btn.className).toMatch(/\bh-11\b/);
    expect(btn.className).toMatch(/\bmin-w-11\b/);
  });

  it("falls back to v2 field names (insurerName / amountClaimed)", () => {
    render(
      <NHCXStepper
        claim={{
          id: "c2",
          status: "SUBMITTED",
          insurerName: "TPA Plus",
          amountClaimed: 7500,
          amountApproved: 6000,
        }}
      />,
    );
    expect(screen.getByTestId("nhcx-stepper-provider")).toHaveTextContent(
      /TPA Plus/,
    );
    expect(screen.getByTestId("nhcx-stepper-provider")).toHaveTextContent(
      /Claimed/,
    );
    expect(screen.getByTestId("nhcx-stepper-provider")).toHaveTextContent(
      /Approved/,
    );
  });
});

describe("NHCXStepper helpers", () => {
  it("stageIndexFor maps known statuses correctly", () => {
    expect(stageIndexFor("SUBMITTED")).toBe(0);
    expect(stageIndexFor("IN_REVIEW")).toBe(1);
    expect(stageIndexFor("APPROVED")).toBe(2);
    expect(stageIndexFor("PARTIALLY_APPROVED")).toBe(2);
    expect(stageIndexFor("SETTLED")).toBe(3);
    expect(stageIndexFor("REJECTED")).toBe(1);
    expect(stageIndexFor("CANCELLED")).toBe(0);
    expect(stageIndexFor(null)).toBe(-1);
    expect(stageIndexFor(undefined)).toBe(-1);
  });

  it("nextHappyPathStatus advances along the legacy 4-enum path", () => {
    expect(nextHappyPathStatus("SUBMITTED")).toBe("APPROVED");
    expect(nextHappyPathStatus("APPROVED")).toBe("SETTLED");
    expect(nextHappyPathStatus("SETTLED")).toBe(null);
    expect(nextHappyPathStatus("REJECTED")).toBe(null);
    expect(nextHappyPathStatus(null)).toBe(null);
  });
});
