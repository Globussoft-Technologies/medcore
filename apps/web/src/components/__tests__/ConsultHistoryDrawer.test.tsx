/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ConsultHistoryDrawer component coverage.
 *
 * What / which modules / why:
 *   - Verifies the right-side Consult History drawer used by the doctor
 *     patient-detail page and the patient my-appointments past-tab "View
 *     Notes" action. Exercised surfaces:
 *       1. Closed / open lifecycle — `open=false` short-circuits to null,
 *          `open=true` mounts the backdrop + aside dialog.
 *       2. Mode switching — `mode.kind === "patient"` fetches
 *          `/consultations/by-patient/:id` (array body), while
 *          `mode.kind === "appointment"` fetches
 *          `/consultations/by-appointment/:id` (single object) and
 *          wraps it into a single-element array.
 *       3. Loading state shows "Loading…" while the api promise is
 *          unresolved.
 *       4. Empty state — array with zero rows shows the dashed empty
 *          panel + "No consultation notes yet." copy.
 *       5. 404-as-empty special-casing — errors whose message contains
 *          "no consultation notes" / "not yet finalized" surface as
 *          empty (NOT red error block), per source comment at line
 *          100-108. Other errors render the red error block.
 *       6. Close affordances — X button and backdrop click both call
 *          `onClose`. Custom `title` prop overrides the per-mode
 *          default (`Consult History` / `Consult Notes`).
 *       7. ConsultationCard rendering — date fallback to createdAt when
 *          appointment is absent, doctor name + specialization, slotStart
 *          suffix, SIGNED vs DRAFT status pill, and the "all-empty"
 *          fallback ("No notes recorded.").
 *       8. SoapBlock + parseSoapSubsections — both the markdown
 *          `## <label>\n<body>` parser branch AND the plain-text
 *          legacy-row fallback branch.
 *       9. CodeRow — ICD-10 chips (indigo) and SNOMED chips (teal),
 *          including the description tooltip via `title`.
 *
 *   - Source under test: apps/web/src/components/ConsultHistoryDrawer.tsx
 *   - Mocks @/lib/api — every test stubs `api.get` with the shape the
 *     drawer expects (`{ data: ... }`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

import {
  ConsultHistoryDrawer,
  type ConsultationRow,
} from "../ConsultHistoryDrawer";

const baseRow = (overrides: Partial<ConsultationRow> = {}): ConsultationRow => ({
  id: "c1",
  appointmentId: "a1",
  doctorId: "d1",
  subjective: null,
  objective: null,
  assessment: null,
  plan: null,
  notes: null,
  findings: null,
  icd10Codes: null,
  snomedCodes: null,
  status: "DRAFT",
  signedAt: null,
  createdAt: "2026-05-01T08:00:00.000Z",
  ...overrides,
});

describe("ConsultHistoryDrawer", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
  });

  it("renders nothing when open=false (early-return short-circuit)", () => {
    const { container } = render(
      <ConsultHistoryDrawer
        open={false}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the dialog chrome with the default 'Consult History' title in patient mode", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /Consult History/i });
    expect(dialog).toBeInTheDocument();
    // heading text inside the header
    expect(
      screen.getByRole("heading", { name: /Consult History/i }),
    ).toBeInTheDocument();
  });

  it("uses the per-mode default 'Consult Notes' title when mode is appointment", async () => {
    apiMock.get.mockResolvedValueOnce({ data: baseRow() });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "appointment", appointmentId: "a1" }}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: /Consult Notes/i }),
    ).toBeInTheDocument();
  });

  it("honors the explicit `title` prop override", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
        title="Past visits"
      />,
    );

    expect(
      screen.getByRole("dialog", { name: /Past visits/i }),
    ).toBeInTheDocument();
  });

  it("fetches /consultations/by-patient/:id when mode is patient", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "pat-42" }}
      />,
    );

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/consultations/by-patient/pat-42",
      ),
    );
  });

  it("fetches /consultations/by-appointment/:id when mode is appointment", async () => {
    apiMock.get.mockResolvedValueOnce({ data: baseRow() });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "appointment", appointmentId: "appt-99" }}
      />,
    );

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/consultations/by-appointment/appt-99",
      ),
    );
  });

  it("shows a Loading… indicator while the api call is in-flight", async () => {
    let resolve: ((v: { data: ConsultationRow[] }) => void) | null = null;
    apiMock.get.mockReturnValueOnce(
      new Promise<{ data: ConsultationRow[] }>((res) => {
        resolve = res;
      }),
    );
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(screen.getByText(/Loading…/i)).toBeInTheDocument();
    resolve!({ data: [] });
    await waitFor(() =>
      expect(screen.queryByText(/Loading…/i)).not.toBeInTheDocument(),
    );
  });

  it("renders the dashed empty-state panel when the patient has zero consultations", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(
      await screen.findByText(/No consultation notes yet/i),
    ).toBeInTheDocument();
  });

  it("treats the 404 'no consultation notes' error as an empty state (not a red error block)", async () => {
    apiMock.get.mockRejectedValueOnce(
      new Error("no consultation notes found for this patient"),
    );
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(
      await screen.findByText(/No consultation notes yet/i),
    ).toBeInTheDocument();
    // Definitely not the error variant.
    expect(
      screen.queryByText(/Could not load history/i),
    ).not.toBeInTheDocument();
  });

  it("treats the 404 'not yet finalized' error as an empty state too", async () => {
    apiMock.get.mockRejectedValueOnce(
      new Error("Consultation is not yet finalized for this appointment"),
    );
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "appointment", appointmentId: "a1" }}
      />,
    );

    expect(
      await screen.findByText(/No consultation notes yet/i),
    ).toBeInTheDocument();
  });

  it("renders the red error block for non-empty errors (auth / server / other)", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("Internal server error"));
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(
      await screen.findByText(/Internal server error/i),
    ).toBeInTheDocument();
  });

  it("falls back to the 'Could not load history' copy when the error has no message", async () => {
    // Throw a non-Error value so `err instanceof Error` is false → msg = "".
    apiMock.get.mockImplementationOnce(() => {
      throw "boom";
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(
      await screen.findByText(/Could not load history/i),
    ).toBeInTheDocument();
  });

  it("clicking the close (X) button invokes onClose", async () => {
    const onClose = vi.fn();
    apiMock.get.mockResolvedValueOnce({ data: [] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={onClose}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop invokes onClose", async () => {
    const onClose = vi.fn();
    apiMock.get.mockResolvedValueOnce({ data: [] });
    const { container } = render(
      <ConsultHistoryDrawer
        open={true}
        onClose={onClose}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    // The backdrop is the first child with aria-hidden="true".
    const backdrop = container.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the count badge when there is at least one row", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [baseRow(), baseRow({ id: "c2" })] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    // Wait for the count badge "2" to appear (rendered only when rows.length > 0).
    expect(await screen.findByText("2")).toBeInTheDocument();
    // Both rows render the empty-notes fallback — verify by length.
    expect(screen.getAllByText(/No notes recorded/i)).toHaveLength(2);
  });

  it("renders the SIGNED status pill text 'Signed' for signed consults", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [baseRow({ status: "SIGNED", signedAt: "2026-05-01T09:00:00.000Z" })],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(await screen.findByText("Signed")).toBeInTheDocument();
  });

  it("renders the DRAFT status pill text 'Draft' for unsigned consults", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [baseRow({ status: "DRAFT" })] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(await screen.findByText("Draft")).toBeInTheDocument();
  });

  it("renders the 'No notes recorded.' fallback when every SOAP + codes field is empty", async () => {
    apiMock.get.mockResolvedValueOnce({ data: [baseRow()] });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(await screen.findByText(/No notes recorded/i)).toBeInTheDocument();
  });

  it("renders the doctor name + specialization in the card header when present", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          doctor: {
            id: "d1",
            specialization: "Cardiology",
            user: { name: "Dr Aakash" },
          },
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(
      await screen.findByText(/Dr Aakash · Cardiology/),
    ).toBeInTheDocument();
  });

  it("falls back to em-dash for missing doctor and uses createdAt when appointment date is absent", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          createdAt: "2026-05-10T12:00:00.000Z",
          // No appointment, no doctor.
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    // Doctor name fallback "—".
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("appends the appointment slotStart suffix when present", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          appointment: {
            id: "a1",
            date: "2026-05-10T00:00:00.000Z",
            slotStart: "10:30",
            status: "COMPLETED",
            tokenNumber: 5,
          },
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    // The slot-start chunk renders as "<date> · 10:30".
    expect(await screen.findByText(/· 10:30/)).toBeInTheDocument();
  });

  it("renders the SoapBlock plain-text legacy fallback for a body with no `## ` headers", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          subjective: "Patient reports headache for 3 days",
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(
      await screen.findByText(/Patient reports headache for 3 days/),
    ).toBeInTheDocument();
    expect(screen.getByText("Subjective")).toBeInTheDocument();
  });

  it("renders the SoapBlock markdown-header parser branch with per-subsection labels + bodies", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          objective: "## Vitals\nBP 120/80, HR 72\n## Exam\nNo acute distress",
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    // Parent SOAP label
    expect(await screen.findByText("Objective")).toBeInTheDocument();
    // Sub-labels parsed out of the `## ` headers
    expect(screen.getByText("Vitals")).toBeInTheDocument();
    expect(screen.getByText("Exam")).toBeInTheDocument();
    // Bodies
    expect(screen.getByText(/BP 120\/80, HR 72/)).toBeInTheDocument();
    expect(screen.getByText(/No acute distress/)).toBeInTheDocument();
  });

  it("renders the Assessment and Plan SOAP blocks when present", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          assessment: "Tension headache",
          plan: "Paracetamol 500 mg BID for 3 days",
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(await screen.findByText("Assessment")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/Tension headache/)).toBeInTheDocument();
    expect(screen.getByText(/Paracetamol 500 mg BID/)).toBeInTheDocument();
  });

  it("renders the ICD-10 CodeRow chips with code + description", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          subjective: "x",
          icd10Codes: [
            { code: "G44.2", description: "Tension-type headache" },
            { code: "R51", description: "Headache" },
          ],
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(await screen.findByText("ICD-10:")).toBeInTheDocument();
    expect(screen.getByText("G44.2")).toBeInTheDocument();
    expect(screen.getByText("Tension-type headache")).toBeInTheDocument();
    expect(screen.getByText("R51")).toBeInTheDocument();
  });

  it("renders the SNOMED CodeRow chips alongside ICD-10 when both present", async () => {
    apiMock.get.mockResolvedValueOnce({
      data: [
        baseRow({
          subjective: "x",
          icd10Codes: [{ code: "R51", description: "Headache" }],
          snomedCodes: [
            { code: "25064002", description: "Headache (finding)" },
          ],
        }),
      ],
    });
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    expect(await screen.findByText("SNOMED:")).toBeInTheDocument();
    expect(screen.getByText("25064002")).toBeInTheDocument();
    expect(screen.getByText(/Headache \(finding\)/)).toBeInTheDocument();
  });

  it("re-fires the fetch when `mode` changes between renders (effect dep)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const { rerender } = render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/consultations/by-patient/p1",
      ),
    );

    rerender(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p2" }}
      />,
    );

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/consultations/by-patient/p2",
      ),
    );
  });

  it("normalizes a missing `data` field on the patient response to an empty array (?? [])", async () => {
    apiMock.get.mockResolvedValueOnce({});
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "patient", patientId: "p1" }}
      />,
    );

    // No throw — lands on the empty state.
    expect(
      await screen.findByText(/No consultation notes yet/i),
    ).toBeInTheDocument();
  });

  it("normalizes a missing `data` field on the appointment response to an empty array", async () => {
    apiMock.get.mockResolvedValueOnce({});
    render(
      <ConsultHistoryDrawer
        open={true}
        onClose={() => {}}
        mode={{ kind: "appointment", appointmentId: "a1" }}
      />,
    );

    expect(
      await screen.findByText(/No consultation notes yet/i),
    ).toBeInTheDocument();
  });
});
