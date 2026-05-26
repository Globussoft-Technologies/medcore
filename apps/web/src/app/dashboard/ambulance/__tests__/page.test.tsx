/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AmbulancePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/ambulance/page.tsx, the ADMIN /
 *     RECEPTION / NURSE dispatch surface. DOCTOR is the gated-out role
 *     (Issue #89). Endpoints the page hits:
 *       GET   /ambulance                           (fleet card list)
 *       GET   /ambulance/trips?limit=100           (trip board)
 *       POST  /ambulance                           (Add Ambulance modal)
 *       POST  /ambulance/trips                     (Dispatch modal)
 *       PATCH /ambulance/trips/:id/{dispatch,arrived,enroute,complete,cancel}
 *       GET   /patients?search=...&limit=10        (Dispatch patient picker)
 *
 *   - Behaviours covered:
 *       1. RBAC redirect — DOCTOR triggers toast.error +
 *          router.replace("/dashboard/not-authorized?from=...").
 *       2. Loading branch — SkeletonTable shows while initial fetches pending.
 *       3. Happy path render — fleet cards + active-trip cards with stage
 *          tracker, pickup address, formatted caller phone.
 *       4. Empty branches — empty ambulance fleet, empty active-trip list.
 *       5. Tab switch — Active → All renders the full table with all trips
 *          including COMPLETED + CANCELLED.
 *       6. Trip state transitions — REQUESTED → DISPATCHED → ARRIVED_SCENE
 *          → EN_ROUTE_HOSPITAL → COMPLETED via the contextual buttons.
 *       7. Trip cancel — useConfirm gates the PATCH; cancel-on-confirm.
 *       8. Trip action API error — toast.error surfaces server message.
 *       9. Add Ambulance — validation (vehicle number required, phone regex),
 *          happy POST, server field-error projection, generic toast fallback.
 *      10. Dispatch — ambulance select, validation (ambulance, pickup
 *          length, drop length, caller phone, caller name), patient search,
 *          happy POST, server field-error projection.
 *      11. Complete trip — validation (end time, distance > 0, cost >= 0,
 *          notes), happy submit, parent rejection keeps modal open.
 *      12. Role gating UI — RECEPTION sees Dispatch but not Add Ambulance;
 *          ADMIN sees both.
 *      13. Initial fetch failure is logged and the page still renders chrome.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/use-dialog,
 *            @/lib/format-phone (passthrough), next/navigation,
 *            @/components/Skeleton.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock, routerMock, confirmMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
    authMock: vi.fn(),
    routerMock: {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    },
    confirmMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ambulance",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));

import AmbulancePage from "../page";

// ─── Fixtures ───────────────────────────────────────────

const AMBULANCES = [
  {
    id: "amb-1",
    vehicleNumber: "KA-01-AA-1111",
    make: "Force",
    model: "Traveller",
    type: "BLS",
    status: "AVAILABLE" as const,
    driverName: "Driver D",
    driverPhone: "+919876543210",
    paramedicName: "Para P",
  },
  {
    id: "amb-2",
    vehicleNumber: "KA-02-BB-2222",
    make: null,
    model: null,
    type: "ALS",
    status: "ON_TRIP" as const,
    driverName: null,
    driverPhone: null,
    paramedicName: null,
  },
  {
    id: "amb-3",
    vehicleNumber: "KA-03-CC-3333",
    make: "Tata",
    model: "Winger",
    type: "ICU",
    status: "MAINTENANCE" as const,
    driverName: null,
    driverPhone: null,
    paramedicName: null,
  },
];

const ACTIVE_TRIP_REQUESTED = {
  id: "trip-req",
  tripNumber: "T-001",
  status: "REQUESTED",
  callerName: "Alice",
  callerPhone: "+917321588452",
  pickupAddress: "12 MG Road, Bangalore",
  dropAddress: "City Hospital",
  chiefComplaint: "Chest pain",
  requestedAt: "2026-05-26T10:00:00.000Z",
  dispatchedAt: null,
  arrivedAt: null,
  completedAt: null,
  distanceKm: null,
  cost: null,
  ambulance: AMBULANCES[0],
  patient: null,
};

const ACTIVE_TRIP_DISPATCHED = {
  ...ACTIVE_TRIP_REQUESTED,
  id: "trip-dis",
  tripNumber: "T-002",
  status: "DISPATCHED",
};

const ACTIVE_TRIP_ARRIVED = {
  ...ACTIVE_TRIP_REQUESTED,
  id: "trip-arr",
  tripNumber: "T-003",
  status: "ARRIVED_SCENE",
};

const ACTIVE_TRIP_ENROUTE = {
  ...ACTIVE_TRIP_REQUESTED,
  id: "trip-enr",
  tripNumber: "T-004",
  status: "EN_ROUTE_HOSPITAL",
};

const COMPLETED_TRIP = {
  ...ACTIVE_TRIP_REQUESTED,
  id: "trip-done",
  tripNumber: "T-005",
  status: "COMPLETED",
  distanceKm: 12.5,
  cost: 1500,
  patient: { id: "p-1", user: { name: "Patient Pat" } },
  callerName: null,
};

function adminAuth() {
  return {
    user: { id: "u-admin", role: "ADMIN", name: "Admin", email: "a@h.com" },
    isLoading: false,
  };
}

function mockHappyFetches(opts?: {
  ambulances?: any[];
  trips?: any[];
  patients?: any[];
}) {
  apiMock.get.mockImplementation((endpoint: string) => {
    if (endpoint === "/ambulance") {
      return Promise.resolve({ data: opts?.ambulances ?? AMBULANCES });
    }
    if (endpoint.startsWith("/ambulance/trips")) {
      return Promise.resolve({
        data:
          opts?.trips ?? [
            ACTIVE_TRIP_REQUESTED,
            ACTIVE_TRIP_DISPATCHED,
            ACTIVE_TRIP_ARRIVED,
            ACTIVE_TRIP_ENROUTE,
            COMPLETED_TRIP,
          ],
      });
    }
    if (endpoint.startsWith("/patients")) {
      return Promise.resolve({ data: opts?.patients ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("AmbulancePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    confirmMock.mockReset();
    authMock.mockReturnValue(adminAuth());
  });

  it("redirects DOCTOR (non-allowed role) to /dashboard/not-authorized with toast.error", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", role: "DOCTOR", name: "Dr X", email: "d@h.com" },
      isLoading: false,
    });
    mockHappyFetches();

    render(<AmbulancePage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized?from="),
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      "Ambulance dispatch is restricted to Admin, Reception, and Nurse.",
    );
  });

  it("does NOT redirect while auth is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    mockHappyFetches();

    render(<AmbulancePage />);

    // Give effects a chance to fire.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("renders the skeleton loader while initial fetches are pending", () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<AmbulancePage />);

    expect(screen.getByTestId("ambulance-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders fleet cards + active-trip cards with stage tracker", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);

    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("KA-02-BB-2222")).toBeInTheDocument();
    expect(screen.getByText("KA-03-CC-3333")).toBeInTheDocument();
    // Status pill text (underscores replaced with spaces).
    expect(screen.getByText("ON TRIP")).toBeInTheDocument();
    expect(screen.getByText("MAINTENANCE")).toBeInTheDocument();
    // Driver row uses the formatted phone helper.
    expect(screen.getByText(/Driver: Driver D/)).toBeInTheDocument();
    expect(screen.getByText(/Paramedic: Para P/)).toBeInTheDocument();

    // Active trip card.
    expect(screen.getByText("T-001")).toBeInTheDocument();
    expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/12 MG Road, Bangalore/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Chest pain/).length).toBeGreaterThan(0);
    // Caller phone rendered via the data-testid surface.
    expect(
      screen.getAllByTestId("trip-callerPhone-display")[0],
    ).toBeInTheDocument();

    // Initial fetches hit the right endpoints.
    expect(apiMock.get).toHaveBeenCalledWith("/ambulance");
    expect(apiMock.get).toHaveBeenCalledWith("/ambulance/trips?limit=100");
  });

  it("renders 'No ambulances registered.' when fleet is empty", async () => {
    mockHappyFetches({ ambulances: [], trips: [] });
    render(<AmbulancePage />);

    expect(
      await screen.findByText(/no ambulances registered/i),
    ).toBeInTheDocument();
  });

  it("renders 'No active trips.' when there are no active trips", async () => {
    mockHappyFetches({ trips: [COMPLETED_TRIP] });
    render(<AmbulancePage />);

    expect(await screen.findByText(/no active trips/i)).toBeInTheDocument();
  });

  it("switches to All Trips tab and renders the table with completed + cancelled rows", async () => {
    mockHappyFetches();
    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /all trips/i }));

    // The completed trip now appears in the table.
    expect(await screen.findByText("T-005")).toBeInTheDocument();
    // Distance + cost projection lit up.
    expect(screen.getByText(/12.5 km/)).toBeInTheDocument();
    expect(screen.getByText(/₹1500/)).toBeInTheDocument();
    // Falls back to the patient name from the patient relation.
    expect(screen.getByText(/Patient Pat/)).toBeInTheDocument();
  });

  it("renders the 'No trips' empty row when the All Trips table is empty", async () => {
    mockHappyFetches({ trips: [] });
    render(<AmbulancePage />);

    await waitFor(() =>
      expect(screen.queryByTestId("ambulance-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /all trips/i }));
    expect(await screen.findByText(/^no trips$/i)).toBeInTheDocument();
  });

  it("Dispatch action — REQUESTED trip patches /dispatch and refetches", async () => {
    mockHappyFetches();
    apiMock.patch.mockResolvedValueOnce({ data: { ok: true } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    apiMock.get.mockClear();
    mockHappyFetches();

    fireEvent.click(screen.getByRole("button", { name: /^dispatch$/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ambulance/trips/trip-req/dispatch",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/ambulance"),
    );
  });

  it("Arrived action — DISPATCHED trip patches /arrived", async () => {
    mockHappyFetches();
    apiMock.patch.mockResolvedValueOnce({ data: { ok: true } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-002")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /arrived at scene/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ambulance/trips/trip-dis/arrived",
        undefined,
      ),
    );
  });

  it("Enroute action — ARRIVED_SCENE trip patches /enroute", async () => {
    mockHappyFetches();
    apiMock.patch.mockResolvedValueOnce({ data: { ok: true } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-003")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /en route to hospital/i }),
    );

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ambulance/trips/trip-arr/enroute",
        undefined,
      ),
    );
  });

  it("trip action API error surfaces the thrown message via toast", async () => {
    mockHappyFetches();
    apiMock.patch.mockRejectedValueOnce(new Error("State transition denied"));

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^dispatch$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("State transition denied"),
    );
  });

  it("trip action server field error projects field+message into toast", async () => {
    mockHappyFetches();
    apiMock.patch.mockRejectedValueOnce({
      payload: {
        details: [{ field: "status", message: "Already dispatched" }],
      },
    });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^dispatch$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "status: Already dispatched",
      ),
    );
  });

  it("Cancel — useConfirm returning false skips the PATCH", async () => {
    mockHappyFetches();
    confirmMock.mockResolvedValueOnce(false);

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    // First Cancel button (on the REQUESTED card).
    fireEvent.click(screen.getAllByRole("button", { name: /^cancel$/i })[0]);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Cancel — useConfirm true triggers PATCH /cancel and refetches", async () => {
    mockHappyFetches();
    confirmMock.mockResolvedValueOnce(true);
    apiMock.patch.mockResolvedValueOnce({ data: { ok: true } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /^cancel$/i })[0]);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ambulance/trips/trip-req/cancel",
        undefined,
      ),
    );
  });

  // ─── Add Ambulance modal ─────────────────────────────────

  it("Add Ambulance — opens with the vehicle number input and a disabled Add button", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    // Open the modal — the toolbar button is "Add Ambulance"; the modal title
    // is also "Add Ambulance". Use the first match (toolbar).
    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);

    const vehInput = screen.getByPlaceholderText(
      /vehicle number/i,
    ) as HTMLInputElement;
    expect(vehInput).toBeInTheDocument();
    const addButton = screen.getByRole("button", { name: /^add$/i });
    expect(addButton).toBeDisabled();
  });

  it("Add Ambulance — invalid driverPhone surfaces inline phone error and does NOT POST", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);

    fireEvent.change(screen.getByPlaceholderText(/vehicle number/i), {
      target: { value: "KA-09-ZZ-9999" },
    });
    fireEvent.change(screen.getByTestId("ambulance-driverPhone"), {
      target: { value: "abc" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(
      await screen.findByTestId("error-driverPhone"),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Add Ambulance — happy POST sends form, closes modal, refetches", async () => {
    mockHappyFetches();
    apiMock.post.mockResolvedValueOnce({ data: { id: "amb-new" } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);

    fireEvent.change(screen.getByPlaceholderText(/vehicle number/i), {
      target: { value: "KA-10-NEW-0001" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^make$/i), {
      target: { value: "Mahindra" },
    });
    fireEvent.change(screen.getByPlaceholderText(/^model$/i), {
      target: { value: "Bolero" },
    });
    fireEvent.change(screen.getByPlaceholderText(/driver name/i), {
      target: { value: "Driver Z" },
    });
    fireEvent.change(screen.getByTestId("ambulance-driverPhone"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByPlaceholderText(/paramedic name/i), {
      target: { value: "Para Z" },
    });

    apiMock.get.mockClear();
    mockHappyFetches();

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ambulance",
        expect.objectContaining({
          vehicleNumber: "KA-10-NEW-0001",
          make: "Mahindra",
          model: "Bolero",
          driverName: "Driver Z",
          driverPhone: "9876543210",
          paramedicName: "Para Z",
        }),
      ),
    );
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/ambulance"),
    );
  });

  it("Add Ambulance — server field errors project into the form", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce({
      payload: {
        details: [
          { field: "vehicleNumber", message: "Vehicle already exists" },
        ],
      },
    });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);

    fireEvent.change(screen.getByPlaceholderText(/vehicle number/i), {
      target: { value: "DUP-001" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(
      await screen.findByTestId("error-vehicleNumber"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Vehicle already exists/)).toBeInTheDocument();
  });

  it("Add Ambulance — generic (non-detailed) error falls back to toast", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce(new Error("Server boom"));

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);
    fireEvent.change(screen.getByPlaceholderText(/vehicle number/i), {
      target: { value: "KA-X-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Server boom"),
    );
  });

  it("Add Ambulance — closes via the ✕ and Cancel buttons", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    // ✕ button — only the modal has it.
    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);
    expect(screen.getByPlaceholderText(/vehicle number/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/vehicle number/i)).not.toBeInTheDocument(),
    );

    // Cancel button — the modal's Cancel comes last in the DOM.
    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);
    const cancelButtons = screen.getAllByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/vehicle number/i)).not.toBeInTheDocument(),
    );
  });

  it("Add Ambulance — type select changes value", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /add ambulance/i })[0]);

    const typeSelect = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "ICU" } });
    expect(typeSelect.value).toBe("ICU");
  });

  // ─── Dispatch modal ─────────────────────────────────────

  it("Dispatch — short pickup raises inline error and does NOT POST", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));

    const modal = await screen.findByTestId("dispatch-modal");
    fireEvent.change(within(modal).getByTestId("trip-pickupAddress"), {
      target: { value: "abc" }, // < 5 chars
    });

    // Button is enabled because the input has *some* value + an ambulance is
    // auto-selected from the first AVAILABLE row.
    fireEvent.click(within(modal).getByRole("button", { name: /create trip/i }));

    expect(
      await within(modal).findByTestId("error-pickupAddress"),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Dispatch — short drop address raises inline error", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));

    const modal = await screen.findByTestId("dispatch-modal");
    fireEvent.change(within(modal).getByTestId("trip-pickupAddress"), {
      target: { value: "Valid pickup address" },
    });
    fireEvent.change(within(modal).getByTestId("trip-dropAddress"), {
      target: { value: "no" },
    });

    fireEvent.click(within(modal).getByRole("button", { name: /create trip/i }));

    expect(
      await within(modal).findByTestId("error-dropAddress"),
    ).toBeInTheDocument();
  });

  it("Dispatch — invalid caller phone + short caller name raise inline errors", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));

    const modal = await screen.findByTestId("dispatch-modal");
    fireEvent.change(within(modal).getByTestId("trip-pickupAddress"), {
      target: { value: "12 Main Road" },
    });
    fireEvent.change(within(modal).getByTestId("trip-callerPhone"), {
      target: { value: "??" },
    });
    fireEvent.change(within(modal).getByPlaceholderText(/caller name/i), {
      target: { value: "A" },
    });

    fireEvent.click(within(modal).getByRole("button", { name: /create trip/i }));

    expect(
      await within(modal).findByTestId("error-callerPhone"),
    ).toBeInTheDocument();
    expect(within(modal).getByTestId("error-callerName")).toBeInTheDocument();
  });

  it("Dispatch — happy POST with patient search lookup", async () => {
    const patient = {
      id: "p-99",
      mrNumber: "MR-99",
      user: { name: "Patient Alpha", phone: "9876543210" },
    };
    apiMock.get.mockImplementation((endpoint: string) => {
      if (endpoint === "/ambulance") {
        return Promise.resolve({ data: AMBULANCES });
      }
      if (endpoint.startsWith("/ambulance/trips")) {
        return Promise.resolve({ data: [] });
      }
      if (endpoint.startsWith("/patients")) {
        return Promise.resolve({ data: [patient] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValueOnce({ data: { id: "new-trip" } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));

    const modal = await screen.findByTestId("dispatch-modal");

    // Search for the patient.
    fireEvent.change(
      within(modal).getByLabelText(/patient \(optional\)/i),
      { target: { value: "Alpha" } },
    );
    fireEvent.click(within(modal).getByRole("button", { name: /^search$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/patients?search=Alpha&limit=10",
      ),
    );

    // The patient picker select appears.
    await screen.findByText(/Patient Alpha \(MR-99\)/);

    // Fill remaining fields.
    fireEvent.change(within(modal).getByTestId("trip-pickupAddress"), {
      target: { value: "Roadside near 12 MG Road" },
    });
    fireEvent.change(within(modal).getByTestId("trip-dropAddress"), {
      target: { value: "City Hospital ER" },
    });
    fireEvent.change(within(modal).getByPlaceholderText(/caller name/i), {
      target: { value: "Caller Casey" },
    });
    fireEvent.change(within(modal).getByTestId("trip-callerPhone"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(within(modal).getByPlaceholderText(/chief complaint/i), {
      target: { value: "Severe headache" },
    });

    fireEvent.click(within(modal).getByRole("button", { name: /create trip/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ambulance/trips",
        expect.objectContaining({
          ambulanceId: "amb-1",
          pickupAddress: "Roadside near 12 MG Road",
          dropAddress: "City Hospital ER",
          callerName: "Caller Casey",
          callerPhone: "9876543210",
          chiefComplaint: "Severe headache",
        }),
      ),
    );
  });

  it("Dispatch — patient search API rejection is swallowed (no crash, no toast)", async () => {
    apiMock.get.mockImplementation((endpoint: string) => {
      if (endpoint === "/ambulance") {
        return Promise.resolve({ data: AMBULANCES });
      }
      if (endpoint.startsWith("/ambulance/trips")) {
        return Promise.resolve({ data: [] });
      }
      if (endpoint.startsWith("/patients")) {
        return Promise.reject(new Error("server boom"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    const modal = await screen.findByTestId("dispatch-modal");

    fireEvent.change(within(modal).getByLabelText(/patient \(optional\)/i), {
      target: { value: "noone" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: /^search$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/patients?search=noone&limit=10",
      ),
    );

    // Modal stays usable.
    expect(within(modal).getByTestId("trip-pickupAddress")).toBeInTheDocument();
  });

  it("Dispatch — Enter on patient search input triggers searchPatients", async () => {
    mockHappyFetches({ patients: [] });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    const modal = await screen.findByTestId("dispatch-modal");
    const search = within(modal).getByLabelText(/patient \(optional\)/i);

    fireEvent.change(search, { target: { value: "abc" } });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/patients?search=abc&limit=10",
      ),
    );
  });

  it("Dispatch — empty ambulance list renders the helper option text", async () => {
    mockHappyFetches({ ambulances: [], trips: [] });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.queryByTestId("ambulance-loading")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    const modal = await screen.findByTestId("dispatch-modal");

    expect(
      within(modal).getByText(
        /no ambulances available — all on trip \/ in maintenance/i,
      ),
    ).toBeInTheDocument();
  });

  it("Dispatch — server field errors project inline", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce({
      payload: {
        details: [{ field: "ambulanceId", message: "Vehicle unavailable" }],
      },
    });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    const modal = await screen.findByTestId("dispatch-modal");
    fireEvent.change(within(modal).getByTestId("trip-pickupAddress"), {
      target: { value: "Valid pickup address" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: /create trip/i }));

    expect(
      await within(modal).findByTestId("error-ambulanceId"),
    ).toBeInTheDocument();
    expect(within(modal).getByText(/Vehicle unavailable/)).toBeInTheDocument();
  });

  it("Dispatch — generic POST error falls back to toast", async () => {
    mockHappyFetches();
    apiMock.post.mockRejectedValueOnce(new Error("Boom"));

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    const modal = await screen.findByTestId("dispatch-modal");
    fireEvent.change(within(modal).getByTestId("trip-pickupAddress"), {
      target: { value: "Valid pickup address" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: /create trip/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Boom"),
    );
  });

  it("Dispatch — Cancel / ✕ buttons close the modal", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    let modal = await screen.findByTestId("dispatch-modal");
    fireEvent.click(within(modal).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("dispatch-modal")).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /dispatch trip/i }));
    modal = await screen.findByTestId("dispatch-modal");
    fireEvent.click(within(modal).getByRole("button", { name: "✕" }));
    await waitFor(() =>
      expect(screen.queryByTestId("dispatch-modal")).not.toBeInTheDocument(),
    );
  });

  // ─── Complete trip modal ────────────────────────────────

  it("Complete — opens from the EN_ROUTE_HOSPITAL card and validates required fields", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    // Distance is required → click submit with empty fields.
    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(
      await screen.findByTestId("error-finalDistance"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("error-finalCost")).toBeInTheDocument();
    expect(screen.getByTestId("error-notes")).toBeInTheDocument();
  });

  it("Complete — distance must be > 0 and cost must be >= 0", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    fireEvent.change(screen.getByTestId("complete-finalDistance"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("complete-finalCost"), {
      target: { value: "-1" },
    });
    fireEvent.change(screen.getByTestId("complete-notes"), {
      target: { value: "ok" },
    });

    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(
      await screen.findByText(/finalDistance must be greater than 0/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/finalCost cannot be negative/i),
    ).toBeInTheDocument();
  });

  it("Complete — happy submit PATCH /complete with normalized payload, closes modal", async () => {
    mockHappyFetches();
    apiMock.patch.mockResolvedValueOnce({ data: { ok: true } });

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    fireEvent.change(screen.getByTestId("complete-finalDistance"), {
      target: { value: "15.5" },
    });
    fireEvent.change(screen.getByTestId("complete-finalCost"), {
      target: { value: "2000" },
    });
    fireEvent.change(screen.getByTestId("complete-notes"), {
      target: { value: "Patient delivered safely" },
    });

    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/ambulance/trips/trip-enr/complete",
        expect.objectContaining({
          finalDistance: 15.5,
          finalCost: 2000,
          notes: "Patient delivered safely",
          actualEndTime: expect.any(String),
        }),
      ),
    );
    // Modal closes.
    await waitFor(() =>
      expect(
        screen.queryByTestId("complete-submit"),
      ).not.toBeInTheDocument(),
    );
  });

  it("Complete — parent rejection keeps the modal open and re-enables submit", async () => {
    mockHappyFetches();
    apiMock.patch.mockRejectedValueOnce(new Error("Server error"));

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    fireEvent.change(screen.getByTestId("complete-finalDistance"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("complete-finalCost"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByTestId("complete-notes"), {
      target: { value: "Delivered" },
    });

    fireEvent.click(screen.getByTestId("complete-submit"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Server error"),
    );
    // Modal remains.
    expect(screen.getByTestId("complete-submit")).toBeInTheDocument();
  });

  it("Complete — emptying actualEndTime surfaces the actualEndTime error", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    fireEvent.change(screen.getByTestId("complete-actualEndTime"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("complete-finalDistance"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("complete-finalCost"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByTestId("complete-notes"), {
      target: { value: "Delivered" },
    });

    fireEvent.click(screen.getByTestId("complete-submit"));

    expect(
      await screen.findByTestId("error-actualEndTime"),
    ).toBeInTheDocument();
  });

  it("Complete — non-numeric distance / cost surface 'must be a number' errors", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));

    // The number input rejects truly non-numeric strings, but we can use the
    // dispatcher trick: pass via DOM directly.
    const distInput = screen.getByTestId(
      "complete-finalDistance",
    ) as HTMLInputElement;
    // jsdom number inputs treat invalid input as empty; force via assigning to value.
    Object.defineProperty(distInput, "value", {
      writable: true,
      value: "abc",
    });
    fireEvent.change(distInput);

    const costInput = screen.getByTestId(
      "complete-finalCost",
    ) as HTMLInputElement;
    Object.defineProperty(costInput, "value", {
      writable: true,
      value: "xyz",
    });
    fireEvent.change(costInput);

    fireEvent.change(screen.getByTestId("complete-notes"), {
      target: { value: "Delivered" },
    });

    fireEvent.click(screen.getByTestId("complete-submit"));

    // Either branch ("must be a number" OR "is required") is acceptable —
    // both originate from the same NaN/empty fork. We just check an error
    // surfaces for each.
    await waitFor(() => {
      expect(
        screen.getByTestId("error-finalDistance"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("error-finalCost"),
      ).toBeInTheDocument();
    });
  });

  it("Complete — Cancel and ✕ close the modal without PATCH", async () => {
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-004")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    expect(screen.getByTestId("complete-submit")).toBeInTheDocument();

    // The Complete modal's Cancel is the last Cancel button in the DOM
    // (trip cards each have their own Cancel button).
    let cancels = screen.getAllByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancels[cancels.length - 1]);
    await waitFor(() =>
      expect(
        screen.queryByTestId("complete-submit"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    fireEvent.click(screen.getByRole("button", { name: "✕" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("complete-submit"),
      ).not.toBeInTheDocument(),
    );

    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  // ─── Role gating ────────────────────────────────────────

  it("RECEPTION sees Dispatch but NOT Add Ambulance", async () => {
    authMock.mockReturnValue({
      user: {
        id: "u-rec",
        role: "RECEPTION",
        name: "Reception",
        email: "r@h.com",
      },
      isLoading: false,
    });
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getAllByText("KA-01-AA-1111").length).toBeGreaterThan(0),
    );

    expect(
      screen.getByRole("button", { name: /dispatch trip/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add ambulance/i }),
    ).not.toBeInTheDocument();
  });

  it("NURSE sees Dispatch but NOT Add Ambulance and CAN trip-action", async () => {
    authMock.mockReturnValue({
      user: {
        id: "u-nrs",
        role: "NURSE",
        name: "Nurse",
        email: "n@h.com",
      },
      isLoading: false,
    });
    mockHappyFetches();

    render(<AmbulancePage />);
    await waitFor(() =>
      expect(screen.getByText("T-001")).toBeInTheDocument(),
    );

    expect(
      screen.getByRole("button", { name: /dispatch trip/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add ambulance/i }),
    ).not.toBeInTheDocument();
    // Trip actions still visible for NURSE.
    expect(
      screen.getByRole("button", { name: /^dispatch$/i }),
    ).toBeInTheDocument();
  });

  it("initial fetch failure logs but page chrome still renders", async () => {
    const consoleErr = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    apiMock.get.mockRejectedValue(new Error("network down"));

    render(<AmbulancePage />);

    await waitFor(() => expect(consoleErr).toHaveBeenCalled());
    // Heading still renders.
    expect(screen.getByRole("heading", { name: /ambulance/i })).toBeInTheDocument();
    consoleErr.mockRestore();
  });
});
