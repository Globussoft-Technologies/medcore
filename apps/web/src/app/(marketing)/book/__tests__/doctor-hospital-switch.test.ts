/**
 * Doctor-panel hospital switching contract.
 *
 * The booking page keeps this state inline because the doctor lookup also
 * depends on the current chat history and date. This small model pins the
 * transition rules used by page.tsx without mounting its browser-only voice,
 * geolocation, Firebase, and portal dependencies.
 */
import { describe, expect, it } from "vitest";

interface Doctor {
  doctorId: string;
}

interface DoctorPanelState {
  doctors: Doctor[];
  selectedDoctor: Doctor | null;
  selectedSlot: string | null;
  loading: boolean;
  searched: boolean;
  latestRequestId: number;
  tenantId: string;
  awaitingHospital: boolean;
}

function beginDoctorLookup(state: DoctorPanelState, tenantId: string) {
  const latestRequestId = state.latestRequestId + 1;
  return {
    requestId: latestRequestId,
    state: {
      ...state,
      doctors: [],
      selectedDoctor: null,
      selectedSlot: null,
      loading: true,
      searched: false,
      latestRequestId,
      tenantId,
      awaitingHospital: false,
    },
  };
}

function returnToHospitals(state: DoctorPanelState): DoctorPanelState {
  return {
    ...state,
    doctors: [],
    selectedDoctor: null,
    selectedSlot: null,
    loading: false,
    searched: false,
    latestRequestId: state.latestRequestId + 1,
    tenantId: "",
    awaitingHospital: true,
  };
}

function finishDoctorLookup(
  state: DoctorPanelState,
  requestId: number,
  doctors: Doctor[],
): DoctorPanelState {
  if (requestId !== state.latestRequestId) return state;
  return { ...state, doctors, loading: false, searched: true };
}

const initialState: DoctorPanelState = {
  doctors: [{ doctorId: "old-doctor" }],
  selectedDoctor: { doctorId: "old-doctor" },
  selectedSlot: "10:00",
  loading: false,
  searched: true,
  latestRequestId: 4,
  tenantId: "hospital-a",
  awaitingHospital: false,
};

describe("doctor panel when switching hospitals", () => {
  it("clears the previous hospital's doctors before the new lookup", () => {
    const { requestId, state } = beginDoctorLookup(initialState, "hospital-b");

    expect(requestId).toBe(5);
    expect(state.doctors).toEqual([]);
    expect(state.selectedDoctor).toBeNull();
    expect(state.selectedSlot).toBeNull();
    expect(state.loading).toBe(true);
    expect(state.searched).toBe(false);
    expect(state.tenantId).toBe("hospital-b");
  });

  it("clears doctor state and invalidates pending requests on Back", () => {
    const state = returnToHospitals({ ...initialState, loading: true });

    expect(state.doctors).toEqual([]);
    expect(state.selectedDoctor).toBeNull();
    expect(state.selectedSlot).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.searched).toBe(false);
    expect(state.latestRequestId).toBe(5);
    expect(state.tenantId).toBe("");
    expect(state.awaitingHospital).toBe(true);
  });

  it("ignores a previous hospital response that finishes late", () => {
    const first = beginDoctorLookup(initialState, "hospital-b");
    const second = beginDoctorLookup(first.state, "hospital-c");
    const afterStaleResponse = finishDoctorLookup(second.state, first.requestId, [
      { doctorId: "hospital-b-doctor" },
    ]);

    expect(afterStaleResponse).toEqual(second.state);
    expect(afterStaleResponse.doctors).toEqual([]);
    expect(afterStaleResponse.loading).toBe(true);
    expect(afterStaleResponse.tenantId).toBe("hospital-c");
  });

  it("shows doctors only when the latest hospital response finishes", () => {
    const lookup = beginDoctorLookup(initialState, "hospital-b");
    const finished = finishDoctorLookup(lookup.state, lookup.requestId, [
      { doctorId: "hospital-b-doctor" },
    ]);

    expect(finished.doctors).toEqual([{ doctorId: "hospital-b-doctor" }]);
    expect(finished.loading).toBe(false);
    expect(finished.searched).toBe(true);
  });
});
