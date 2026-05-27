// Smoke tests for the patient PWA "My Prescriptions" page (Pearl §6.1 —
// gap #5 piece 3c of 4). Asserts:
//   • Renders the list with mocked data (3 rows with mixed item counts).
//   • Empty state renders correctly when the array is empty.
//   • Every row exposes Download / Share / Verify CTAs.
//   • 44px touch-target invariant on every CTA (h-11 + min-w-[44px]).
//   • Share-WhatsApp link uses the `https://wa.me/?text=...` shape with
//     the verify URL encoded inside the message body.
//   • Unauth 401 surface renders the sign-in nudge.
//   • Share CTA is hidden for non-shareable rows (no signatureUrl).
//
// Uses vi.hoisted for the api mock per CLAUDE.md gotcha #2 (singleFork
// vitest pattern — same shape as the appointments page test in piece 3b).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPostMock, toastSuccessMock, toastErrorMock } = vi.hoisted(
  () => ({
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

// 2026-05-27: the Share CTA now posts to /prescriptions/:id/share and
// toasts the result (mirroring the doctor flow). Stub the toast helpers
// so the assertions can verify both happy + 409 paths.
vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import PatientPrescriptionsPage from "../page";

// Three rows: a signed Rx with a single item, a signed Rx with three items
// (forces the "+N more" branch), and a DRAFT Rx (hides the Share CTA).
function makeRow(opts: {
  id: string;
  createdAt: string;
  items: string[];
  doctorName?: string;
  specialty?: string;
  status?: string;
  signatureUrl?: string | null;
  diagnosis?: string;
}) {
  return {
    id: opts.id,
    createdAt: opts.createdAt,
    diagnosis: opts.diagnosis ?? null,
    status: opts.status ?? "ISSUED",
    signatureUrl: opts.signatureUrl ?? "https://example.com/sig.png",
    doctor: {
      user: { name: opts.doctorName ?? "Sharma" },
      specialty: opts.specialty ?? "General",
    },
    items: opts.items.map((name, i) => ({
      id: `${opts.id}-item-${i}`,
      medicineName: name,
      dosage: "500mg",
      frequency: "BD",
    })),
  };
}

function listOk<T>(data: T[], total?: number) {
  return {
    success: true,
    data,
    error: null,
    meta: { page: 1, limit: 20, total: total ?? data.length },
  };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

describe("Patient prescriptions page — gap #5 piece 3c", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
  });

  it("renders the list with 3 mocked rows (mixed item counts)", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-1",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
        }),
        makeRow({
          id: "rx-2",
          createdAt: "2026-05-10T10:00:00Z",
          items: ["Amoxicillin", "Ibuprofen", "Cetirizine"],
          doctorName: "Mehta",
          specialty: "Obstetrics",
        }),
        makeRow({
          id: "rx-3",
          createdAt: "2026-05-01T10:00:00Z",
          items: ["Metformin", "Glimepiride"],
          doctorName: "Reddy",
        }),
      ]),
    );

    render(<PatientPrescriptionsPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("patient-prescriptions"),
      ).toBeInTheDocument();
    });

    const rows = screen.getAllByTestId("patient-prescriptions-row");
    expect(rows).toHaveLength(3);

    // Row 1 — single item, no "+N more"
    expect(within(rows[0]).getByText(/Paracetamol/)).toBeInTheDocument();
    expect(
      within(rows[0]).queryByText(/\+.* more/),
    ).not.toBeInTheDocument();

    // Row 2 — three items: shows first + "+2 more"
    expect(within(rows[1]).getByText(/Amoxicillin/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/\+2 more/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Dr\. Mehta/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Obstetrics/)).toBeInTheDocument();

    // Row 3 — two items: shows first + "+1 more"
    expect(within(rows[2]).getByText(/Metformin/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/\+1 more/)).toBeInTheDocument();

    // Header count badge matches the mocked total.
    expect(screen.getByTestId("patient-prescriptions-count")).toHaveTextContent(
      "3",
    );
  });

  it("renders the empty state when the list is empty", async () => {
    apiGetMock.mockResolvedValue(listOk([], 0));
    render(<PatientPrescriptionsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("patient-prescriptions-empty"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("patient-prescriptions-empty"),
    ).toHaveTextContent(/No prescriptions yet/);
    expect(
      screen.queryByTestId("patient-prescriptions-row"),
    ).not.toBeInTheDocument();
  });

  it("exposes Download / Share / Verify CTAs on every row", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-1",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
        }),
      ]),
    );
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );

    const row = screen.getByTestId("patient-prescriptions-row");
    expect(
      within(row).getByTestId("patient-prescriptions-download-btn"),
    ).toBeInTheDocument();
    expect(
      within(row).getByTestId("patient-prescriptions-share-btn"),
    ).toBeInTheDocument();
    expect(
      within(row).getByTestId("patient-prescriptions-verify-btn"),
    ).toBeInTheDocument();
  });

  it("every interactive CTA carries h-11 + min-w-[44px] (Pearl §6.2 touch-target floor)", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-1",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
        }),
      ]),
    );
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );

    const ctaTestIds = [
      "patient-prescriptions-download-btn",
      "patient-prescriptions-share-btn",
      "patient-prescriptions-verify-btn",
    ];
    for (const testId of ctaTestIds) {
      const el = screen.getByTestId(testId);
      expect(el.className, `${testId} must include h-11`).toMatch(/\bh-11\b/);
      expect(el.className, `${testId} must include min-w-[44px]`).toMatch(
        /min-w-\[44px\]/,
      );
    }
  });

  it("Share button posts to /prescriptions/:id/share with channel=WHATSAPP and toasts on success", async () => {
    // 2026-05-27: replaces the old wa.me-link test. The Share CTA is now
    // a <button> that calls the server-side share endpoint (mirrors the
    // doctor flow at apps/web/src/app/dashboard/prescriptions/page.tsx
    // `shareVia` at L494). Server delivers the verify link via Meta
    // Cloud API to the patient's registered phone and logs the share;
    // the client just toasts.
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-abc-123",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
          doctorName: "Sharma",
        }),
      ]),
    );
    apiPostMock.mockResolvedValue({ success: true, data: null, error: null });
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );

    const btn = screen.getByTestId("patient-prescriptions-share-btn");
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        "/prescriptions/rx-abc-123/share",
        { channel: "WHATSAPP" },
      ),
    );
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Prescription shared via WhatsApp",
      ),
    );
  });

  it("Share button toasts the API's 409 error verbatim (unsigned/cancelled/no-phone)", async () => {
    // Patient-side has no SignaturePad branch (a patient can't sign for
    // their doctor) — on a 409 we surface the API's friendly message
    // unchanged so the patient knows what to do next.
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-unsigned",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
          signatureUrl: null,
        }),
      ]),
    );
    const apiErr = Object.assign(new Error("nope"), {
      status: 409,
      payload: {
        error:
          "Cannot share an unsigned prescription — the prescribing doctor must sign it first.",
      },
    });
    apiPostMock.mockRejectedValue(apiErr);

    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("patient-prescriptions-share-btn"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Cannot share an unsigned prescription — the prescribing doctor must sign it first.",
      ),
    );
  });

  it("Download PDF link points at the API PDF endpoint with format=pdf", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-pdf-1",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
        }),
      ]),
    );
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );
    const link = screen.getByTestId("patient-prescriptions-download-btn");
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/prescriptions/rx-pdf-1/pdf");
    expect(href).toContain("format=pdf");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("Verify QR link points at /verify/rx/<id>", async () => {
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-verify-1",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
        }),
      ]),
    );
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );
    const link = screen.getByTestId("patient-prescriptions-verify-btn");
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/verify/rx/rx-verify-1");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders the Share CTA on unsigned/draft rows so the patient can see the gate explanation", async () => {
    // 2026-05-27: previously this test asserted the Share CTA was HIDDEN
    // on rows without a signature. We flipped that: the API's POST
    // /:id/share returns a friendly 409 explaining why share is
    // unavailable ("Cannot share an unsigned prescription — the
    // prescribing doctor must sign it first."), and the client toasts
    // that message verbatim. Hiding the button left the patient with no
    // explanation; rendering it lets the gate-explanation toast fire on
    // click. Download + Verify still visible regardless.
    apiGetMock.mockResolvedValue(
      listOk([
        makeRow({
          id: "rx-draft",
          createdAt: "2026-05-15T10:00:00Z",
          items: ["Paracetamol"],
          status: "DRAFT",
          signatureUrl: null,
        }),
      ]),
    );
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-prescriptions-share-btn"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-prescriptions-download-btn"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("patient-prescriptions-verify-btn"),
    ).toBeInTheDocument();
  });

  it("renders the unauthed sign-in surface when /prescriptions returns 401", async () => {
    apiGetMock.mockImplementation(() => rejectedWithStatus(401));
    render(<PatientPrescriptionsPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("patient-prescriptions-unauth"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("patient-prescriptions-signin-cta"),
    ).toHaveAttribute("href", "/patient/login");
  });

  it("shows the Load more button when meta.total exceeds the loaded rows", async () => {
    apiGetMock.mockResolvedValue(
      listOk(
        [
          makeRow({
            id: "rx-1",
            createdAt: "2026-05-15T10:00:00Z",
            items: ["Paracetamol"],
          }),
        ],
        25, // total > rows
      ),
    );
    render(<PatientPrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("patient-prescriptions")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("patient-prescriptions-load-more"),
    ).toBeInTheDocument();

    // Second page request triggered by the load-more click.
    apiGetMock.mockResolvedValueOnce(
      listOk(
        [
          makeRow({
            id: "rx-2",
            createdAt: "2026-05-10T10:00:00Z",
            items: ["Amoxicillin"],
          }),
        ],
        25,
      ),
    );
    fireEvent.click(screen.getByTestId("patient-prescriptions-load-more"));
    await waitFor(() => {
      expect(screen.getAllByTestId("patient-prescriptions-row")).toHaveLength(
        2,
      );
    });
    expect(apiGetMock).toHaveBeenLastCalledWith(
      "/prescriptions?page=2&limit=20",
      expect.objectContaining({ skip401Redirect: true }),
    );
  });
});
