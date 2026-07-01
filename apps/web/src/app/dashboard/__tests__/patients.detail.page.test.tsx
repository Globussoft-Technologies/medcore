/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiMock, authMock, toastMock, confirmMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  // Booking now runs through the in-app confirm dialog (useConfirm) before it
  // fires the POST; default the mock to "confirmed".
  confirmMock: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patients/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import PatientDetailPage from "../patients/[id]/page";

const samplePatient = {
  id: "p1",
  mrNumber: "MR-1",
  gender: "MALE",
  age: 35,
  bloodGroup: "O+",
  dateOfBirth: "1990-01-01",
  user: { id: "u1", name: "Aarav Mehta", email: "a@x.com", phone: "9000000001" },
};

describe("PatientDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.delete.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<PatientDetailPage />);
    await waitFor(() => {
      const loader = screen.getByTestId("patients-detail-loading");
      expect(loader).toBeInTheDocument();
      expect(loader).toHaveAttribute("aria-busy", "true");
    });
  });

  it("shows patient-not-found on failure", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    render(<PatientDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/patient not found/i)).toBeInTheDocument()
    );
  });

  it("renders populated patient details", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id") return Promise.resolve({ data: samplePatient });
      if (url.endsWith("/stats")) return Promise.reject(new Error("no stats"));
      // PatientCRMActivity (Pearl §7.1, commit 2ec88c3) fires
      // GET /leads/by-patient/:id on mount — render the empty-state
      // path rather than feeding it an array and tripping
      // `lead.source.replace`.
      if (url.startsWith("/leads/by-patient/"))
        return Promise.reject(new Error("404 not found"));
      return Promise.resolve({ data: [] });
    });
    render(<PatientDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0)
    );
  });

  it("renders back link to Patients", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id") return Promise.resolve({ data: samplePatient });
      if (url.endsWith("/stats")) return Promise.reject(new Error("no stats"));
      // PatientCRMActivity (Pearl §7.1, commit 2ec88c3) fires
      // GET /leads/by-patient/:id on mount — render the empty-state
      // path rather than feeding it an array and tripping
      // `lead.source.replace`.
      if (url.startsWith("/leads/by-patient/"))
        return Promise.reject(new Error("404 not found"));
      return Promise.resolve({ data: [] });
    });
    render(<PatientDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/back to patients/i)).toBeInTheDocument()
    );
  });

  it("renders MR number", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/patients/test-id") return Promise.resolve({ data: samplePatient });
      if (url.endsWith("/stats")) return Promise.reject(new Error("no stats"));
      // PatientCRMActivity (Pearl §7.1, commit 2ec88c3) fires
      // GET /leads/by-patient/:id on mount — render the empty-state
      // path rather than feeding it an array and tripping
      // `lead.source.replace`.
      if (url.startsWith("/leads/by-patient/"))
        return Promise.reject(new Error("404 not found"));
      return Promise.resolve({ data: [] });
    });
    render(<PatientDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/MR-1/).length).toBeGreaterThan(0)
    );
  });

  describe("Edit button (Issue #39)", () => {
    function mockPatientLoad() {
      apiMock.get.mockImplementation((url: string) => {
        if (url === "/patients/test-id")
          return Promise.resolve({ data: samplePatient });
        if (url.endsWith("/stats")) return Promise.reject(new Error("no stats"));
        // PatientCRMActivity (Pearl §7.1, commit 2ec88c3) fires
        // GET /leads/by-patient/:id on mount. The empty-state path is
        // a 404 — which the component matches via /404|not found|No lead/
        // and renders the "no CRM history" pill rather than throwing on
        // an unexpected response shape.
        if (url.startsWith("/leads/by-patient/"))
          return Promise.reject(new Error("404 not found"));
        return Promise.resolve({ data: [] });
      });
    }

    // Issue #185 (2026-04-29): Edit-Patient is now RECEPTION + ADMIN only.
    // DOCTOR / NURSE roles intentionally do NOT see the Edit button —
    // they record clinical data (notes, prescriptions, vitals), not patient
    // demographic data. The two assertions below are inversions of the
    // earlier behaviour.
    it("hides Edit button for DOCTOR (#185)", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();
      render(<PatientDetailPage />);
      await waitFor(() =>
        expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0),
      );
      expect(screen.queryByTestId("patient-edit-button")).toBeNull();
    });

    it("shows Edit button for ADMIN", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();
      render(<PatientDetailPage />);
      await waitFor(() =>
        expect(screen.getByTestId("patient-edit-button")).toBeInTheDocument()
      );
    });

    it("hides Edit button for NURSE (#185)", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          user: { id: "u1", name: "Nurse", email: "n@x.com", role: "NURSE" },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();
      render(<PatientDetailPage />);
      await waitFor(() =>
        expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0),
      );
      expect(screen.queryByTestId("patient-edit-button")).toBeNull();
    });

    it("shows Edit button for RECEPTION", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          user: {
            id: "u1",
            name: "Reception",
            email: "r@x.com",
            role: "RECEPTION",
          },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();
      render(<PatientDetailPage />);
      await waitFor(() =>
        expect(screen.getByTestId("patient-edit-button")).toBeInTheDocument()
      );
    });

    it("hides Edit button for PATIENT role", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          user: {
            id: "u1",
            name: "Bob",
            email: "b@x.com",
            role: "PATIENT",
          },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();
      render(<PatientDetailPage />);
      await waitFor(() =>
        expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0)
      );
      expect(screen.queryByTestId("patient-edit-button")).toBeNull();
    });

    it("opens modal with read-only MR and submits PATCH preserving MR", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          // Issue #185: Edit is now RECEPTION/ADMIN only — was DOCTOR before
          user: { id: "u1", name: "Reception", email: "r@x.com", role: "RECEPTION" },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();
      apiMock.patch.mockResolvedValue({
        data: { ...samplePatient, user: { ...samplePatient.user, name: "Aarav M" } },
      });

      render(<PatientDetailPage />);
      const btn = await screen.findByTestId("patient-edit-button");
      fireEvent.click(btn);

      const modal = await screen.findByTestId("patient-edit-modal");
      expect(modal).toBeInTheDocument();

      // MR field is read-only and has the existing value.
      const mr = screen.getByTestId("patient-edit-mrNumber") as HTMLInputElement;
      expect(mr.value).toBe("MR-1");
      expect(mr.readOnly).toBe(true);

      // Change name, then submit.
      const nameInput = screen.getByTestId(
        "patient-edit-field-name"
      ) as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Aarav M" } });

      const saveBtn = screen.getByTestId("patient-edit-save");
      fireEvent.click(saveBtn);

      await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
      const [url, payload] = apiMock.patch.mock.calls[0] as [string, any];
      expect(url).toBe("/patients/p1");
      // MR must not be included in payload
      expect(payload).not.toHaveProperty("mrNumber");
      expect(payload.name).toBe("Aarav M");
      expect(payload.phone).toBe("9000000001");
    });

    it("modal cancel button closes without firing PATCH", async () => {
      authMock.mockImplementation((selector: any) => {
        const state = {
          // Issue #185: Edit is now RECEPTION/ADMIN only — was DOCTOR before
          user: { id: "u1", name: "Reception", email: "r@x.com", role: "RECEPTION" },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      mockPatientLoad();

      render(<PatientDetailPage />);
      const btn = await screen.findByTestId("patient-edit-button");
      fireEvent.click(btn);
      await screen.findByTestId("patient-edit-modal");
      fireEvent.click(screen.getByTestId("patient-edit-cancel"));
      await waitFor(() =>
        expect(screen.queryByTestId("patient-edit-modal")).toBeNull()
      );
      expect(apiMock.patch).not.toHaveBeenCalled();
    });
  });

  // Issue #566: Reception clicking an available time-slot in the patient
  // profile's Book Appointment modal was redirecting to /login with a
  // "Your session has expired" toast. Cause: lib/api.ts's global 401
  // handler treated any 401 from /appointments/book — including
  // transients during cookie rotation — as a real session expiry. The
  // fix passes skip401Redirect on the slot-click POST and surfaces the
  // server's error message inline so the user can retry without losing
  // the session.
  describe("Book Appointment slot-click (Issue #566)", () => {
    function mockReceptionPatientLoad() {
      authMock.mockImplementation((selector: any) => {
        const state = {
          user: {
            id: "u1",
            name: "Reception",
            email: "r@x.com",
            role: "RECEPTION",
          },
        };
        return typeof selector === "function" ? selector(state) : state;
      });
      apiMock.get.mockImplementation((url: string) => {
        if (url === "/patients/test-id")
          return Promise.resolve({ data: samplePatient });
        // Reject stats so the optional <Stats Strip> with toFixed() never
        // renders — keeps the test focused on the slot-click path.
        if (url.endsWith("/stats"))
          return Promise.reject(new Error("no stats"));
        if (url === "/doctors")
          return Promise.resolve({
            data: [
              {
                id: "doc1",
                user: { name: "Dr Suresh" },
                specialization: "GP",
                appointmentMode: "SLOT",
              },
            ],
          });
        if (url.startsWith("/doctors/doc1/slots"))
          return Promise.resolve({
            data: {
              slots: [
                { startTime: "17:00", endTime: "17:15", isAvailable: true },
              ],
            },
          });
        // PatientCRMActivity (Pearl §7.1, commit 2ec88c3) fires
        // GET /leads/by-patient/:id on mount. The empty-state path is
        // a 404 — which the component matches via /404|not found|No lead/
        // and renders the "no CRM history" pill rather than throwing on
        // an unexpected response shape.
        if (url.startsWith("/leads/by-patient/"))
          return Promise.reject(new Error("404 not found"));
        return Promise.resolve({ data: [] });
      });
    }

    it("posts to /appointments/book WITH skip401Redirect so a transient 401 cannot trigger the global session-expired redirect", async () => {
      mockReceptionPatientLoad();
      apiMock.post.mockResolvedValue({ data: { id: "appt-1" } });

      render(<PatientDetailPage />);
      // The detail page renders two "Book Appointment" buttons (the
      // header chrome's quick-action and the in-tab Patient360Tab quick
      // strip). Either opens the QuickBookModal — pick the first.
      const bookBtns = await screen.findAllByRole("button", {
        name: /book appointment/i,
      });
      fireEvent.click(bookBtns[0]);

      // The modal starts on "Select Doctor" — pick doc1 to reveal booking
      // options (SLOT mode → slot grid).
      fireEvent.change(await screen.findByLabelText("Doctor"), {
        target: { value: "doc1" },
      });

      // Wait for the slot tile to render in the modal.
      const slotBtn = await screen.findByRole("button", { name: "17:00" });
      fireEvent.click(slotBtn);

      await waitFor(() =>
        expect(apiMock.post).toHaveBeenCalledWith(
          "/appointments/book",
          expect.objectContaining({
            patientId: "test-id",
            doctorId: "doc1",
            slotId: "17:00",
          }),
          expect.objectContaining({ skip401Redirect: true }),
        ),
      );
    });

    it("on a 401 from /appointments/book surfaces an inline session-out-of-sync message instead of bouncing the user", async () => {
      mockReceptionPatientLoad();
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      apiMock.post.mockRejectedValue(err);

      render(<PatientDetailPage />);
      // The detail page renders two "Book Appointment" buttons (the
      // header chrome's quick-action and the in-tab Patient360Tab quick
      // strip). Either opens the QuickBookModal — pick the first.
      const bookBtns = await screen.findAllByRole("button", {
        name: /book appointment/i,
      });
      fireEvent.click(bookBtns[0]);
      fireEvent.change(await screen.findByLabelText("Doctor"), {
        target: { value: "doc1" },
      });
      const slotBtn = await screen.findByRole("button", { name: "17:00" });
      fireEvent.click(slotBtn);

      await waitFor(() =>
        expect(
          screen.getByText(/session is out of sync/i),
        ).toBeInTheDocument(),
      );
    });
  });
});
