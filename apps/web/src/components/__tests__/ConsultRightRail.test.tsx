/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pearl ERP Stage 1 §2.1.3 (gap row 46) — ConsultRightRail smoke test.
 *
 * What / which modules / why:
 *   - Verifies the right-rail component:
 *       1. Renders the rail container.
 *       2. Fetches favourites + visits via api.get() with the doctor/patient
 *          ids the parent passes in.
 *       3. Click on a favourite diagnosis triggers the onPasteDiagnosis
 *          callback with the diagnosis value (click-to-paste contract).
 *       4. Last 3 visits render one card per visit (gap-doc acceptance).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { ConsultRightRail } from "../ConsultRightRail";

const FAVOURITES_RESPONSE = {
  success: true,
  data: {
    diagnoses: [
      { value: "Acute viral fever", count: 12 },
      { value: "Type 2 diabetes mellitus", count: 7 },
    ],
    medicines: [
      { value: "Paracetamol 500mg", count: 22 },
      { value: "Metformin 500mg", count: 9 },
    ],
    sampledFrom: 50,
  },
  error: null,
};

const VISITS_RESPONSE = {
  success: true,
  data: [
    {
      id: "rx-1",
      createdAt: "2026-05-20T10:00:00.000Z",
      diagnosis: "Acute viral fever",
      advice: "Hydration; rest 3 days",
      followUpDate: null,
      items: [
        { medicineName: "Paracetamol 500mg", dosage: "1 tab", frequency: "TID", duration: "3 days" },
      ],
    },
    {
      id: "rx-2",
      createdAt: "2026-04-10T10:00:00.000Z",
      diagnosis: "Hypertension review",
      advice: null,
      followUpDate: null,
      items: [],
    },
    {
      id: "rx-3",
      createdAt: "2026-03-01T10:00:00.000Z",
      diagnosis: "Type 2 diabetes mellitus",
      advice: null,
      followUpDate: null,
      items: [],
    },
  ],
  error: null,
};

describe("ConsultRightRail (Pearl §2.1.3, gap row 46)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/consult-rail/favourites/")) {
        return Promise.resolve(FAVOURITES_RESPONSE);
      }
      if (endpoint.startsWith("/consult-rail/visits/")) {
        return Promise.resolve(VISITS_RESPONSE);
      }
      return Promise.reject(new Error(`Unexpected endpoint: ${endpoint}`));
    });
  });

  it("renders the rail container, fetches favourites + visits, and shows top diagnoses + 3 visits", async () => {
    render(
      <ConsultRightRail
        doctorId="doc-1"
        patientId="pat-1"
        token="t1"
        onPasteDiagnosis={() => {}}
        onPasteMedicine={() => {}}
      />,
    );

    expect(screen.getByTestId("consult-right-rail")).toBeInTheDocument();

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        "/consult-rail/favourites/doc-1",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
      expect(apiMock.get).toHaveBeenCalledWith(
        "/consult-rail/visits/pat-1",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    // Favourites: at least one diagnosis chip rendered with the expected value.
    await waitFor(() => {
      const chips = screen.getAllByTestId("consult-rail-fav-diagnosis");
      expect(chips.length).toBeGreaterThanOrEqual(1);
      expect(chips[0]).toHaveTextContent("Acute viral fever");
    });

    // Last-3 visits: exactly 3 visit cards rendered.
    const visitCards = await screen.findAllByTestId("consult-rail-visit");
    expect(visitCards).toHaveLength(3);
  });

  it("fires onPasteDiagnosis with the diagnosis value when a favourite chip is clicked (click-to-paste contract)", async () => {
    const onPaste = vi.fn();
    render(
      <ConsultRightRail
        doctorId="doc-1"
        patientId="pat-1"
        token="t1"
        onPasteDiagnosis={onPaste}
      />,
    );

    const chips = await screen.findAllByTestId("consult-rail-fav-diagnosis");
    const target = chips.find((el) => el.getAttribute("data-value") === "Acute viral fever");
    expect(target).toBeDefined();
    await userEvent.click(target!);
    expect(onPaste).toHaveBeenCalledWith("Acute viral fever");
  });

  it("fires onPasteMedicine with the medicine name when a favourite-medicine chip is clicked", async () => {
    const onPaste = vi.fn();
    render(
      <ConsultRightRail
        doctorId="doc-1"
        patientId="pat-1"
        token="t1"
        onPasteMedicine={onPaste}
      />,
    );

    const chips = await screen.findAllByTestId("consult-rail-fav-medicine");
    const target = chips.find((el) => el.getAttribute("data-value") === "Paracetamol 500mg");
    expect(target).toBeDefined();
    await userEvent.click(target!);
    expect(onPaste).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Paracetamol 500mg" }),
    );
  });
});
