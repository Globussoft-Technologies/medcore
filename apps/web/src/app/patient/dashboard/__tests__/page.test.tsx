// Smoke tests for the patient PWA dashboard (Pearl §6.1 — gap #5 piece 3a of 4
// + Pearl §5.3 row 147 — optional ABHA-link CTA on first login).
// Asserts: 3 tiles render with mocked data, empty states render when payloads
// are empty, every clickable element meets the 44px touch-target floor, the
// unauthed shape renders + offers a sign-in CTA when the API returns 401s,
// AND the dismissible first-login ABHA prompt obeys its visibility matrix
// (no abhaId + not-dismissed → render; abhaId set OR dismissed → hide).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: apiPatchMock,
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import PatientDashboardPage from "../page";

const HOUR = 60 * 60 * 1000;

// Pinned wall clock for the whole file. The dashboard's nextAppointment
// filter does IST-tz math (page splits `slotStart` as Asia/Kolkata
// wallclock, then re-composes a UTC timestamp). Without a fixed clock
// the helpers below were time-of-day-dependent: CI runs between
// roughly 14:30 UTC and 18:30 UTC (the window where "now_IST + 4h"
// rolls past midnight IST while "now_IST itself" is still today)
// silently flipped the row out of the 1h grace window, leaving the
// page in its empty state and failing every "I've arrived" assertion.
// 2026-05-27T06:00:00Z = 2026-05-27 11:30 IST — well clear of both
// midnight boundaries.
const PINNED_NOW = new Date("2026-05-27T06:00:00.000Z");

// 48h ahead is comfortably out of today's IST calendar day regardless
// of host tz, so the disabled-fallback button (status=BOOKED but NOT
// today) still renders for the touch-target invariant test.
const FUTURE = new Date(PINNED_NOW.getTime() + 48 * HOUR).toISOString();

// Build a today-row whose composeWhen lands 4h in the future relative
// to the pinned clock, so the `nextAppointment` filter (1h grace) always
// picks it up AND `isTodayInIST` still returns true (slot stays within
// today's IST calendar day).
function todayBookedRow(id: string) {
  const todayIstYmd = PINNED_NOW.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
  const todayMidnightUtc = `${todayIstYmd}T00:00:00.000Z`;
  const istHHMM = new Date(PINNED_NOW.getTime() + 4 * HOUR).toLocaleTimeString(
    "en-GB",
    { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" },
  );
  return {
    id,
    date: todayMidnightUtc,
    slotStart: `${istHHMM}:00`,
    tokenNumber: 7,
    status: "BOOKED",
    doctor: { user: { name: "Sharma" }, specialty: "Obstetrics" },
  };
}

function listOk<T>(data: T[]) {
  return { success: true, data, error: null, meta: { total: data.length } };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

describe("Patient dashboard — gap #5 piece 3a", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    // Pin Date.now() so the IST tz math in `todayBookedRow` and the
    // page's `ymdInIST(new Date())` agree, regardless of when CI runs.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(PINNED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all 3 tiles with mocked appointment / Rx / invoice data", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/appointments")) {
        return Promise.resolve(
          listOk([
            {
              id: "appt-1",
              date: FUTURE,
              slotStart: "10:30:00",
              tokenNumber: 7,
              status: "BOOKED",
              doctor: {
                user: { name: "Sharma" },
                specialty: "Obstetrics",
              },
            },
          ]),
        );
      }
      if (endpoint.startsWith("/prescriptions")) {
        return Promise.resolve(
          listOk([
            {
              id: "rx-1",
              createdAt: FUTURE,
              diagnosis: "URI",
              doctor: { user: { name: "Sharma" } },
              items: [{ medicineName: "Amoxicillin 500mg" }, { medicineName: "Paracetamol" }],
            },
          ]),
        );
      }
      if (endpoint.startsWith("/billing/invoices")) {
        return Promise.resolve(
          listOk([
            {
              id: "inv-1",
              invoiceNumber: "INV-001",
              createdAt: FUTURE,
              totalAmount: "1500",
              paidAmount: "500",
              paymentStatus: "PARTIAL",
            },
          ]),
        );
      }
      return Promise.resolve(listOk([]));
    });

    render(<PatientDashboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument();
    });

    // Next appointment tile
    const apptTile = screen.getByTestId("patient-dashboard-next-appointment");
    expect(within(apptTile).getByText(/Dr\. Sharma/)).toBeInTheDocument();
    expect(within(apptTile).getByText(/Obstetrics/)).toBeInTheDocument();
    expect(
      within(apptTile).getByTestId("patient-dashboard-next-appointment-view"),
    ).toHaveAttribute("href", "/patient/appointments/appt-1");
    expect(
      within(apptTile).getByTestId("patient-dashboard-next-appointment-arrived"),
    ).toBeInTheDocument();

    // Prescriptions tile
    const rxTile = screen.getByTestId("patient-dashboard-prescriptions");
    expect(within(rxTile).getByText(/Amoxicillin 500mg/)).toBeInTheDocument();
    expect(within(rxTile).getByText(/\+ 1 more/)).toBeInTheDocument();
    // 2026-05-27: download URL changed to the absolute API path (`${API_BASE}/
    // prescriptions/:id/pdf?format=pdf`) — the old `/api/v1/...` was a
    // web-relative path that 404'd on Next's dev server. Test uses
    // `stringContaining` so the assertion stays stable across env-var
    // changes to NEXT_PUBLIC_API_URL.
    expect(
      within(rxTile).getByTestId("patient-dashboard-prescription-download"),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/prescriptions/rx-1/pdf?format=pdf"),
    );
    // 2026-05-27: Share is now a <button> that calls
    // POST /prescriptions/:id/share { channel: "WHATSAPP" } server-side
    // (mirrors the doctor flow at apps/web/src/app/dashboard/prescriptions/
    // page.tsx `shareVia`). No more wa.me anchor. Just assert the button
    // is in the DOM and clickable (the share-success path is covered by a
    // separate test below).
    const shareBtn = within(rxTile).getByTestId(
      "patient-dashboard-prescription-share",
    );
    expect(shareBtn.tagName).toBe("BUTTON");
    expect(shareBtn).toHaveTextContent(/Share on WhatsApp/);

    // Bills tile — INR 1500 - 500 = 1000 due
    const billsTile = screen.getByTestId("patient-dashboard-bills");
    expect(within(billsTile).getByTestId("patient-dashboard-bills-total")).toHaveTextContent(
      /1,000/,
    );
    expect(within(billsTile).getByText(/INV-001/)).toBeInTheDocument();
    expect(
      within(billsTile).getByTestId("patient-dashboard-bill-pay"),
    ).toHaveAttribute("href", "/patient/bills/inv-1/pay");
  });

  it("renders empty states for each tile when the API returns empty arrays", async () => {
    apiGetMock.mockResolvedValue(listOk([]));
    render(<PatientDashboardPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("patient-dashboard-next-appointment-empty"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("patient-dashboard-book-cta"),
    ).toHaveAttribute("href", "/patient/book");
    expect(
      screen.getByTestId("patient-dashboard-prescriptions-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-dashboard-bills-empty"),
    ).toBeInTheDocument();
  });

  it("every interactive element on a populated dashboard satisfies the 44px touch-target floor", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/appointments")) {
        return Promise.resolve(
          listOk([
            {
              id: "appt-1",
              date: FUTURE,
              slotStart: "10:30:00",
              status: "BOOKED",
              doctor: { user: { name: "Sharma" } },
            },
          ]),
        );
      }
      if (endpoint.startsWith("/prescriptions")) {
        return Promise.resolve(
          listOk([
            {
              id: "rx-1",
              createdAt: FUTURE,
              items: [{ medicineName: "Amoxicillin" }],
            },
          ]),
        );
      }
      if (endpoint.startsWith("/billing/invoices")) {
        return Promise.resolve(
          listOk([
            {
              id: "inv-1",
              invoiceNumber: "INV-001",
              createdAt: FUTURE,
              totalAmount: "1500",
              paidAmount: "0",
              paymentStatus: "PENDING",
            },
          ]),
        );
      }
      return Promise.resolve(listOk([]));
    });
    render(<PatientDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument(),
    );

    // We assert the class-level invariant rather than computed pixel height
    // because jsdom doesn't lay out and getBoundingClientRect returns 0.
    // All CTAs in this surface MUST carry `h-11` (Tailwind = 44px) to honour
    // Pearl §6.2 touch-target rule. This catches any future regression where
    // an h-9/h-10 class slips in.
    const ctaTestIds = [
      "patient-dashboard-next-appointment-view",
      "patient-dashboard-next-appointment-arrived",
      "patient-dashboard-prescription-download",
      "patient-dashboard-prescription-share",
      "patient-dashboard-bill-pay",
    ];
    for (const testId of ctaTestIds) {
      const el = screen.getByTestId(testId);
      expect(
        el.className,
        `${testId} must include h-11 (44px touch target)`,
      ).toMatch(/\bh-11\b/);
      expect(
        el.className,
        `${testId} must include min-w-[44px]`,
      ).toMatch(/min-w-\[44px\]/);
    }
  });

  it("renders the unauthed sign-in surface when /appointments returns 401", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/appointments")) return rejectedWithStatus(401);
      return Promise.resolve(listOk([]));
    });
    render(<PatientDashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId("patient-dashboard-unauth")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("patient-dashboard-signin-cta"),
    ).toHaveAttribute("href", "/patient/login");
  });

  // ─── Pearl §5.3 row 147 — ABHA-link first-login prompt ─────────────
  // Visibility matrix:
  //   abhaId   localStorage flag   →   banner visible?
  //   null     absent              →   YES
  //   set      absent              →   no  (already linked)
  //   null     "1"                 →   no  (user dismissed earlier)
  //   null     absent (then click) →   hides after Skip + flag persists

  function meWith(opts: {
    role?: string;
    abhaId?: string | null;
  }): Promise<{ success: true; data: unknown; error: null }> {
    return Promise.resolve({
      success: true,
      data: {
        id: "user-1",
        role: opts.role ?? "PATIENT",
        patient: { abhaId: opts.abhaId ?? null },
      },
      error: null,
    });
  }

  function emptyListMocks(meResolver: () => Promise<unknown>) {
    return (endpoint: string) => {
      if (endpoint.startsWith("/auth/me")) return meResolver();
      return Promise.resolve(listOk([]));
    };
  }

  it("renders the ABHA-link banner when the patient has no abhaId and no prior dismissal", async () => {
    window.localStorage.removeItem("medcore_abha_prompt_dismissed");
    apiGetMock.mockImplementation(
      emptyListMocks(() => meWith({ role: "PATIENT", abhaId: null })),
    );
    render(<PatientDashboardPage />);
    const banner = await screen.findByTestId("patient-abha-prompt-banner");
    expect(banner).toBeInTheDocument();
    expect(screen.getByTestId("patient-abha-prompt-link")).toHaveAttribute(
      "href",
      "/patient/profile?section=abha",
    );
    expect(screen.getByTestId("patient-abha-prompt-skip")).toBeInTheDocument();
    // Touch targets — every CTA on this banner honours the 44px floor.
    for (const id of ["patient-abha-prompt-link", "patient-abha-prompt-skip"]) {
      const el = screen.getByTestId(id);
      expect(el.className, `${id} must include h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `${id} must include min-w-[44px]`).toMatch(
        /min-w-\[44px\]/,
      );
    }
  });

  it("does NOT render the ABHA-link banner when the patient already has an abhaId", async () => {
    window.localStorage.removeItem("medcore_abha_prompt_dismissed");
    apiGetMock.mockImplementation(
      emptyListMocks(() =>
        meWith({ role: "PATIENT", abhaId: "12-3456-7890-1234" }),
      ),
    );
    render(<PatientDashboardPage />);
    // Wait for the dashboard to settle then assert absence.
    await waitFor(() =>
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("patient-abha-prompt-banner"),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the ABHA-link banner when the user dismissed it previously", async () => {
    window.localStorage.setItem("medcore_abha_prompt_dismissed", "1");
    apiGetMock.mockImplementation(
      emptyListMocks(() => meWith({ role: "PATIENT", abhaId: null })),
    );
    render(<PatientDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("patient-abha-prompt-banner"),
    ).not.toBeInTheDocument();
    window.localStorage.removeItem("medcore_abha_prompt_dismissed");
  });

  it("hides the banner and persists the dismissal flag when Skip is clicked", async () => {
    window.localStorage.removeItem("medcore_abha_prompt_dismissed");
    apiGetMock.mockImplementation(
      emptyListMocks(() => meWith({ role: "PATIENT", abhaId: null })),
    );
    render(<PatientDashboardPage />);
    const skip = await screen.findByTestId("patient-abha-prompt-skip");
    fireEvent.click(skip);
    await waitFor(() =>
      expect(
        screen.queryByTestId("patient-abha-prompt-banner"),
      ).not.toBeInTheDocument(),
    );
    expect(
      window.localStorage.getItem("medcore_abha_prompt_dismissed"),
    ).toBe("1");
    window.localStorage.removeItem("medcore_abha_prompt_dismissed");
  });

  // ─── Pearl §6.3 row 340 — "I've arrived" placeholder wire ─────────────
  // The dashboard's next-appointment tile already had a placeholder button
  // (testid `patient-dashboard-next-appointment-arrived`). This block
  // verifies the live wire: today-BOOKED → enabled + PATCH + green pill;
  // future/non-BOOKED → disabled-fallback (button still rendered for the
  // touch-target invariant test but `disabled` set + no PATCH on click).

  it("enables 'I've arrived' on TODAY's next BOOKED appointment and PATCHes /:id/status with { CHECKED_IN }", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/appointments")) {
        return Promise.resolve(listOk([todayBookedRow("appt-today")]));
      }
      return Promise.resolve(listOk([]));
    });
    apiPatchMock.mockResolvedValue({ success: true, data: {}, error: null });

    render(<PatientDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument(),
    );

    const btn = screen.getByTestId(
      "patient-dashboard-next-appointment-arrived",
    );
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute(
      "title",
      "Notify reception (coming soon)",
    );
    fireEvent.click(btn);

    await waitFor(() => {
      expect(apiPatchMock).toHaveBeenCalledWith(
        "/appointments/appt-today/status",
        { status: "CHECKED_IN" },
      );
    });

    // Optimistic flip — green pill in place of the button.
    await waitFor(() => {
      expect(
        screen.getByTestId(
          "patient-dashboard-next-appointment-arrived-pill",
        ),
      ).toBeInTheDocument();
    });
  });

  it("renders the disabled-fallback variant when the next appointment is NOT today's BOOKED row", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/appointments")) {
        return Promise.resolve(
          listOk([
            {
              id: "appt-future",
              date: FUTURE,
              slotStart: "10:30:00",
              status: "BOOKED",
              doctor: { user: { name: "Sharma" } },
            },
          ]),
        );
      }
      return Promise.resolve(listOk([]));
    });
    render(<PatientDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument(),
    );
    const btn = screen.getByTestId(
      "patient-dashboard-next-appointment-arrived",
    );
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  it("surfaces an inline error and stays on the button when the arrive PATCH 4xxs", async () => {
    apiGetMock.mockImplementation((endpoint: string) => {
      if (endpoint.startsWith("/appointments")) {
        return Promise.resolve(listOk([todayBookedRow("appt-today")]));
      }
      return Promise.resolve(listOk([]));
    });
    apiPatchMock.mockRejectedValue(
      Object.assign(new Error("Server says no"), { status: 403 }),
    );

    render(<PatientDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-dashboard")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId("patient-dashboard-next-appointment-arrived"),
    );

    const err = await screen.findByTestId("patient-dashboard-arrive-error");
    expect(err).toHaveTextContent(/Server says no/);
    // Button still present and re-enabled after the error.
    const btn = screen.getByTestId(
      "patient-dashboard-next-appointment-arrived",
    );
    expect(btn).not.toBeDisabled();
    // No optimistic pill since the PATCH failed.
    expect(
      screen.queryByTestId(
        "patient-dashboard-next-appointment-arrived-pill",
      ),
    ).not.toBeInTheDocument();
  });
});
