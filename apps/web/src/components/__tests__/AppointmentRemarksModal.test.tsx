/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pearl ERP Stage 1 §2.1.7 — AppointmentRemarksModal component coverage.
 *
 * What / which modules / why:
 *   - Verifies the threaded-remarks modal that overlays an appointment row.
 *       1. Renders modal chrome (dialog, header, close button) when mounted.
 *       2. Loads remarks via GET /appointments/:id/remarks on mount and lists them.
 *       3. Empty-state copy when the API returns []; loading copy while in-flight.
 *       4. Error toast when the GET rejects.
 *       5. Add a top-level remark — POSTs body+visibility+parentRemarkId=null
 *          and reloads the list.
 *       6. Submit a reply — POSTs with the parent's visibility inherited and a
 *          parentRemarkId pointing at the parent; reply renders indented under
 *          the parent in the threaded view.
 *       7. Pin/unpin toggle — only rendered for DOCTOR/ADMIN, fires PATCH
 *          /pin with the inverted isPinned flag; "pinned" chip appears for
 *          pinned remarks.
 *       8. Edit own remark — author sees the pencil action, body field
 *          pre-populates, save fires PATCH /remarks/:id with the new body.
 *       9. Delete own remark — author sees the trash action, delete confirms
 *          via window.confirm then fires DELETE; aborting the confirm skips
 *          the network call.
 *      10. Visibility chip renders for each remark with the right label
 *          (Globe2/All staff, Stethoscope/Doctors only, Lock/Only me).
 *      11. Role gating — PATIENT does NOT see the composer (read-only modal);
 *          non-author + non-admin does NOT see edit/delete actions on others'
 *          remarks; non-DOCTOR/non-ADMIN does NOT see the pin action.
 *
 *   - Source under test: apps/web/src/components/AppointmentRemarksModal.tsx
 *   - Mocks @/lib/api (network), @/lib/store (useAuthStore), and @/lib/toast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: {
    user: { id: "u-doc", role: "DOCTOR", name: "Dr Test" } as
      | { id: string; role: string; name: string }
      | null,
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({
  useAuthStore: () => ({ user: authMock.user }),
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

import { AppointmentRemarksModal } from "../AppointmentRemarksModal";

const PARENT_REMARK = {
  id: "r-1",
  appointmentId: "appt-1",
  authorUserId: "u-doc",
  parentRemarkId: null as string | null,
  body: "Patient reports mild chest pain after exertion.",
  visibility: "ALL_STAFF" as const,
  isPinned: false,
  createdAt: "2026-05-20T10:00:00.000Z",
  updatedAt: "2026-05-20T10:00:00.000Z",
  editedAt: null as string | null,
  author: { id: "u-doc", name: "Dr Test", role: "DOCTOR" },
};

const OTHER_REMARK = {
  id: "r-2",
  appointmentId: "appt-1",
  authorUserId: "u-nurse",
  parentRemarkId: null as string | null,
  body: "BP normal, vitals stable.",
  visibility: "DOCTOR_ONLY" as const,
  isPinned: true,
  createdAt: "2026-05-20T11:00:00.000Z",
  updatedAt: "2026-05-20T11:00:00.000Z",
  editedAt: null as string | null,
  author: { id: "u-nurse", name: "Nurse Joy", role: "NURSE" },
};

const REPLY_REMARK = {
  id: "r-3",
  appointmentId: "appt-1",
  authorUserId: "u-nurse",
  parentRemarkId: "r-1" as string | null,
  body: "Will schedule ECG.",
  visibility: "ALL_STAFF" as const,
  isPinned: false,
  createdAt: "2026-05-20T10:30:00.000Z",
  updatedAt: "2026-05-20T10:30:00.000Z",
  editedAt: null as string | null,
  author: { id: "u-nurse", name: "Nurse Joy", role: "NURSE" },
};

describe("AppointmentRemarksModal (Pearl §2.1.7)", () => {
  let onClose: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let confirmSpy: any;

  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.user = { id: "u-doc", role: "DOCTOR", name: "Dr Test" };
    onClose = vi.fn();
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it("renders the dialog with header, patient name, and close button when mounted", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(
      <AppointmentRemarksModal
        appointmentId="appt-1"
        patientName="Aarav Mehta"
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: /appointment remarks/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Remarks")).toBeInTheDocument();
    expect(screen.getByText("Aarav Mehta")).toBeInTheDocument();

    const closeBtn = screen.getByRole("button", { name: /close remarks/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the loading copy while the GET is in-flight", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
  });

  it("loads remarks via GET /appointments/:id/remarks and renders the list", async () => {
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK, OTHER_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith("/appointments/appt-1/remarks");
    });
    expect(await screen.findByText(PARENT_REMARK.body)).toBeInTheDocument();
    expect(screen.getByText(OTHER_REMARK.body)).toBeInTheDocument();
    // Pinned chip for the OTHER remark
    expect(screen.getByText(/pinned/i)).toBeInTheDocument();
  });

  it("renders the empty-state when the API returns an empty array", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    expect(await screen.findByText(/no remarks yet/i)).toBeInTheDocument();
  });

  it("surfaces a toast.error when the initial load fails", async () => {
    apiMock.get.mockRejectedValue(new Error("Network down"));
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Network down");
    });
  });

  it("adds a top-level remark via POST with body + chosen visibility + parentRemarkId=null", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({});
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(/no remarks yet/i);

    const textarea = screen.getByPlaceholderText(/add a remark/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Patient stable, recheck in 1 week." } });

    // Change visibility scope to DOCTOR_ONLY
    const visSelect = screen.getByLabelText(/visibility/i) as HTMLSelectElement;
    fireEvent.change(visSelect, { target: { value: "DOCTOR_ONLY" } });

    fireEvent.click(screen.getByRole("button", { name: /^post$/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/appt-1/remarks",
        {
          body: "Patient stable, recheck in 1 week.",
          visibility: "DOCTOR_ONLY",
          parentRemarkId: null,
        },
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Remark added");
    // List reloads.
    expect(apiMock.get).toHaveBeenCalledTimes(2);
  });

  it("does not POST when the body is whitespace-only (button disabled)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(/no remarks yet/i);
    const postBtn = screen.getByRole("button", { name: /^post$/i }) as HTMLButtonElement;
    expect(postBtn).toBeDisabled();

    fireEvent.click(postBtn);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("submits a reply with the parent's inherited visibility and parentRemarkId", async () => {
    apiMock.get.mockResolvedValue({ data: [OTHER_REMARK] }); // DOCTOR_ONLY parent
    apiMock.post.mockResolvedValue({});
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(OTHER_REMARK.body);

    fireEvent.click(screen.getByLabelText(/^reply$/i));

    // Composer should show the "Replying to" banner with inherited-visibility note.
    expect(await screen.findByText(/replying to nurse joy/i)).toBeInTheDocument();
    expect(screen.getByText(/visibility inherited/i)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/add a remark/i);
    fireEvent.change(textarea, { target: { value: "Acknowledged — will order labs." } });

    fireEvent.click(screen.getByRole("button", { name: /post reply/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/appt-1/remarks",
        {
          body: "Acknowledged — will order labs.",
          visibility: "DOCTOR_ONLY", // inherited from parent
          parentRemarkId: OTHER_REMARK.id,
        },
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Reply posted");
  });

  it("renders replies nested under their parent in the threaded view", async () => {
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK, REPLY_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    expect(screen.getByText(REPLY_REMARK.body)).toBeInTheDocument();
    // The parent gets a Reply button; the reply (rendered without showReply) does not.
    const replyButtons = screen.queryAllByLabelText(/^reply$/i);
    expect(replyButtons).toHaveLength(1);
  });

  it("PATCHes /pin with isPinned toggled when DOCTOR/ADMIN clicks the pin button", async () => {
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    apiMock.patch.mockResolvedValue({});
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);

    fireEvent.click(screen.getByLabelText(/pin remark/i));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        `/appointments/appt-1/remarks/${PARENT_REMARK.id}/pin`,
        { isPinned: true },
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Pinned");
  });

  it("does NOT render the pin button for non-DOCTOR/non-ADMIN roles (NURSE)", async () => {
    authMock.user = { id: "u-nurse", role: "NURSE", name: "Nurse" };
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    expect(screen.queryByLabelText(/pin remark/i)).not.toBeInTheDocument();
  });

  it("lets the author edit their own remark — pre-fills body, PATCHes new body, switches button label to Save", async () => {
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] }); // author is u-doc = caller
    apiMock.patch.mockResolvedValue({});
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    fireEvent.click(screen.getByLabelText(/edit remark/i));

    const textarea = screen.getByPlaceholderText(/add a remark/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe(PARENT_REMARK.body);
    expect(screen.getByText(/editing remark/i)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "Updated body text." } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        `/appointments/appt-1/remarks/${PARENT_REMARK.id}`,
        { body: "Updated body text." },
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Remark updated");
  });

  it("hides edit & delete actions on other authors' remarks for a non-admin caller (NURSE viewing DOCTOR's remark)", async () => {
    authMock.user = { id: "u-nurse", role: "NURSE", name: "Nurse" };
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    expect(screen.queryByLabelText(/edit remark/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/delete remark/i)).not.toBeInTheDocument();
  });

  it("ADMIN sees the delete action on any remark (admin-override delete)", async () => {
    authMock.user = { id: "u-admin", role: "ADMIN", name: "Admin" };
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] }); // authored by u-doc, not the admin
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    expect(screen.getByLabelText(/delete remark/i)).toBeInTheDocument();
    // ADMIN is not the author, so edit is hidden.
    expect(screen.queryByLabelText(/edit remark/i)).not.toBeInTheDocument();
  });

  it("DELETEs after window.confirm and surfaces success toast", async () => {
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    apiMock.delete.mockResolvedValue({});
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    fireEvent.click(screen.getByLabelText(/delete remark/i));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledWith(
        `/appointments/appt-1/remarks/${PARENT_REMARK.id}`,
      );
    });
    expect(toastMock.success).toHaveBeenCalledWith("Remark deleted");
  });

  it("aborts the DELETE when window.confirm returns false", async () => {
    confirmSpy.mockReturnValue(false);
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    fireEvent.click(screen.getByLabelText(/delete remark/i));

    expect(confirmSpy).toHaveBeenCalled();
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it("renders the visibility chip label for each visibility scope", async () => {
    const mixed = [
      { ...PARENT_REMARK, id: "v1", visibility: "ALL_STAFF" as const, body: "B1" },
      { ...PARENT_REMARK, id: "v2", visibility: "DOCTOR_ONLY" as const, body: "B2" },
      { ...PARENT_REMARK, id: "v3", visibility: "RECEPTION_ONLY" as const, body: "B3" },
      { ...PARENT_REMARK, id: "v4", visibility: "PRIVATE" as const, body: "B4" },
    ];
    apiMock.get.mockResolvedValue({ data: mixed });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText("B1");
    expect(screen.getAllByText(/all staff/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/doctors only/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reception only/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/only me/i).length).toBeGreaterThan(0);
  });

  it("hides the composer entirely for PATIENT users (read-only modal)", async () => {
    authMock.user = { id: "u-pat", role: "PATIENT", name: "Patient X" };
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    expect(screen.queryByPlaceholderText(/add a remark/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^post$/i })).not.toBeInTheDocument();
  });

  it("cancels an in-progress reply via the Cancel link in the banner", async () => {
    apiMock.get.mockResolvedValue({ data: [PARENT_REMARK] });
    render(<AppointmentRemarksModal appointmentId="appt-1" onClose={onClose} />);

    await screen.findByText(PARENT_REMARK.body);
    fireEvent.click(screen.getByLabelText(/^reply$/i));

    expect(await screen.findByText(/replying to/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    // Banner gone, top-level Post button (not "Post reply") back.
    expect(screen.queryByText(/replying to/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^post$/i })).toBeInTheDocument();
  });
});
