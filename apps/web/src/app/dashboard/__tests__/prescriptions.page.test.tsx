/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock, openPrintEndpoint: vi.fn() }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/prescriptions",
}));

import PrescriptionsPage from "../prescriptions/page";

const sampleRx = [
  {
    id: "rx1",
    createdAt: new Date().toISOString(),
    printed: false,
    patient: { id: "p1", mrNumber: "MR-1", user: { name: "Asha Roy" } },
    doctor: { id: "d1", user: { name: "Dr. Singh" } },
    medicines: [{ medicineName: "Paracetamol", dosage: "500mg", frequency: "BID", duration: "5d" }],
    diagnosis: "Fever",
    advice: "Rest",
  },
  {
    id: "rx2",
    createdAt: new Date().toISOString(),
    printed: true,
    patient: { id: "p2", mrNumber: "MR-2", user: { name: "Bhuvan Das" } },
    doctor: { id: "d1", user: { name: "Dr. Singh" } },
    medicines: [{ medicineName: "Ibuprofen", dosage: "400mg", frequency: "TID", duration: "3d" }],
    diagnosis: "Pain",
    advice: "",
  },
];

describe("PrescriptionsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Dr", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders Prescriptions heading with empty data", async () => {
    render(<PrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /prescriptions/i })).toBeInTheDocument()
    );
  });

  it("renders populated prescription rows", async () => {
    apiMock.get.mockResolvedValue({ data: sampleRx });
    render(<PrescriptionsPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/Asha Roy/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Bhuvan Das/).length).toBeGreaterThan(0);
    });
  });

  it("shows Write prescription button for DOCTOR", async () => {
    render(<PrescriptionsPage />);
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /write prescription|new prescription/i }).length
      ).toBeGreaterThan(0);
    });
  });

  it("opens prescription form when Write prescription is clicked", async () => {
    const user = userEvent.setup();
    render(<PrescriptionsPage />);
    await waitFor(() =>
      screen.getAllByRole("button", { name: /write prescription|new prescription/i })[0]
    );
    const btns = screen.getAllByRole("button", { name: /write prescription|new prescription/i });
    await user.click(btns[0]);
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText(/medicine name|patient id|appointment id/i).length).toBeGreaterThan(0);
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<PrescriptionsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /prescriptions/i })).toBeInTheDocument()
    );
  });

  // ─── Validation (Issues #9, #17) ─────────────────────────────────
  it("rejects malformed Appointment ID (non-UUID) with inline error", async () => {
    const user = userEvent.setup();
    render(<PrescriptionsPage />);
    await waitFor(() =>
      screen.getAllByRole("button", { name: /write prescription|new prescription/i })[0]
    );
    const writeBtns = screen.getAllByRole("button", {
      name: /write prescription|new prescription/i,
    });
    await user.click(writeBtns[0]);

    const apptInput = await screen.findByPlaceholderText(/appointment id/i);
    const patientInput = screen.getByPlaceholderText(/patient id/i);
    await user.type(apptInput, "abc");
    await user.type(patientInput, "xyz");

    const saveBtns = screen.getAllByRole("button", { name: /save prescription/i });
    await user.click(saveBtns[0]);

    // Generic warning and inline UUID errors appear; the API is NOT called.
    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalled();
      expect(apiMock.post).not.toHaveBeenCalledWith(
        "/prescriptions",
        expect.anything()
      );
    });
    expect(screen.getByText(/appointment id.*uuid/i)).toBeInTheDocument();
    expect(screen.getByText(/patient id.*uuid/i)).toBeInTheDocument();
  });

  it("rejects negative dosage -100mg with inline medicine error", async () => {
    const user = userEvent.setup();
    render(<PrescriptionsPage />);
    await waitFor(() =>
      screen.getAllByRole("button", { name: /write prescription|new prescription/i })[0]
    );
    await user.click(
      screen.getAllByRole("button", {
        name: /write prescription|new prescription/i,
      })[0]
    );

    // Real UUIDs so UUID check passes; dosage alone should fail.
    const UUID = "11111111-1111-1111-1111-111111111111";
    await user.type(await screen.findByPlaceholderText(/appointment id/i), UUID);
    await user.type(screen.getByPlaceholderText(/patient id/i), UUID);
    // Diagnosis via Autocomplete — the component uses a regular input, so set
    // it directly through the closest input element with "Search ICD-10"
    // placeholder.
    const dx = screen.getByPlaceholderText(/icd-10/i);
    await user.type(dx, "Fever");

    // Medicine row 0: type name + negative dosage.
    const medInputs = screen.getAllByPlaceholderText(/medicine name/i);
    await user.type(medInputs[0], "Paracetamol");
    const dosageInputs = screen.getAllByPlaceholderText(/^dosage$/i);
    await user.type(dosageInputs[0], "-100mg");
    // Frequency is a <select> — pick the first real option.
    const freqSelects = screen
      .getAllByRole("combobox")
      .filter((el) => (el as HTMLSelectElement).options?.length > 1);
    // The first combobox is the template select; the next is frequency.
    // Fall back to the last combobox if the order differs.
    const freqSelect =
      freqSelects.find((el) =>
        Array.from((el as HTMLSelectElement).options).some(
          (o) => o.value === "TID" || o.value === "BID" || o.value === "OD"
        )
      ) || freqSelects[freqSelects.length - 1];
    await user.selectOptions(freqSelect, (freqSelect as HTMLSelectElement).options[1].value);
    const durationInputs = screen.getAllByPlaceholderText(/duration/i);
    await user.type(durationInputs[0], "5d");

    const saveBtns = screen.getAllByRole("button", { name: /save prescription/i });
    await user.click(saveBtns[0]);

    await waitFor(() => {
      expect(toastMock.warning).toHaveBeenCalled();
      expect(apiMock.post).not.toHaveBeenCalledWith(
        "/prescriptions",
        expect.anything()
      );
    });
    // An inline medicines error should appear referencing the bad dosage.
    expect(
      screen.getByText(/dosage|medicine 1/i, { selector: "p" })
    ).toBeInTheDocument();
  });
});
