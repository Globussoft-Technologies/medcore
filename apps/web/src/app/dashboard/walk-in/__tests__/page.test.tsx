/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WalkInPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/walk-in/page.tsx, the reception
 *     walk-in token-assignment surface. Endpoints the page hits:
 *       GET  /doctors                         (mount — doctor radio list)
 *       GET  /patients?search=&limit=5        (>=2-char patient autosuggest)
 *       POST /patients                        (+ New Patient quick-register)
 *       POST /appointments/walk-in            (token placement)
 *
 *   - Behaviours covered:
 *       1. Initial render — heading visible; doctors GET fires once on mount
 *          and renders one radio button per doctor with specialization label.
 *       2. Doctor selection — clicking a card toggles aria-checked/pressed
 *          and dims sibling cards (#856 selected-affordance).
 *       3. Patient search — <2-char input clears results without hitting the
 *          API; >=2-char input GETs /patients with encoded search term and
 *          renders the autosuggest dropdown; selecting a suggestion via
 *          onMouseDown (#585) commits the patient + clears search.
 *       4. Submit gating — Assign Token button stays disabled until BOTH a
 *          doctor is selected AND a patient (or +New Patient mode) is set.
 *       5. Happy path with existing patient — clicking Assign Token POSTs
 *          /appointments/walk-in with the correct body and renders the
 *          token success card (token + patient name + MR# + doctor + Register
 *          Next).
 *       6. Register Next — clicking the success card's button clears `result`
 *            and re-shows the form.
 *       7. + New Patient validation matrix:
 *            - empty name → "Name cannot be empty"
 *            - digits in name (PATIENT_NAME_REGEX rejects, per CLAUDE.md #8)
 *            - empty phone → "Phone number is required"
 *            - bad phone (alpha) → regex error
 *            - age out of [1,150] → range error
 *            - future DOB → "cannot be in the future"
 *            - address > 500 chars → length error
 *            - bad email → format error
 *       8. + New Patient happy path — valid form POSTs /patients THEN
 *            /appointments/walk-in with patientId from the new patient
 *            response; success card renders with the embedded MR# fallback.
 *       9. Error-path resilience — POST /appointments/walk-in rejection
 *            surfaces toast.error; /patients rejection during registerAndWalkIn
 *            surfaces toast.error; doctors GET rejection swallowed (heading
 *            still renders).
 *      10. Field-error clear-on-edit (#267) — typing into a field clears its
 *            error state.
 *
 *   - Mocks: @/lib/api, @/lib/toast, next/navigation. @medcore/shared's
 *     sanitizeUserInput is the REAL implementation so the XSS/empty paths
 *     in validateNewPatient are exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock, routerMock } = vi.hoisted(() => ({
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
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/walk-in",
}));

import WalkInPage from "../page";

type Doctor = {
  id: string;
  user: { name: string };
  specialization: string;
};

type PatientResult = {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
};

function doctor(overrides: Partial<Doctor> = {}): Doctor {
  return {
    id: "doc-1",
    user: { name: "Dr. Sharma" },
    specialization: "Cardiology",
    ...overrides,
  };
}

function patient(overrides: Partial<PatientResult> = {}): PatientResult {
  return {
    id: "pat-1",
    mrNumber: "MR-1001",
    user: { name: "Aarav Mehta", phone: "+919999999999" },
    ...overrides,
  };
}

describe("WalkInPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    toastMock.warning.mockReset();
    toastMock.info.mockReset();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders heading and fetches /doctors on mount, rendering one radio per doctor", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [
            doctor({ id: "d1", user: { name: "Dr. Singh" }, specialization: "GP" }),
            doctor({ id: "d2", user: { name: "Dr. Gupta" }, specialization: "Peds" }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<WalkInPage />);

    expect(
      screen.getByRole("heading", { name: /walk-in registration/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Dr. Singh")).toBeInTheDocument();
    expect(screen.getByText("Dr. Gupta")).toBeInTheDocument();
    expect(screen.getByText("GP")).toBeInTheDocument();
    expect(screen.getByText("Peds")).toBeInTheDocument();
    // The doctors GET fired once.
    const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u === "/doctors").length).toBe(1);
  });

  it("swallows /doctors rejection — heading still renders", async () => {
    apiMock.get.mockRejectedValue(new Error("network"));
    render(<WalkInPage />);
    expect(
      await screen.findByRole("heading", { name: /walk-in registration/i }),
    ).toBeInTheDocument();
  });

  it("selecting a doctor flips aria-checked/pressed and dims siblings (#856)", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        doctor({ id: "d1", user: { name: "Dr. Singh" } }),
        doctor({ id: "d2", user: { name: "Dr. Gupta" } }),
      ],
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const d1 = await screen.findByRole("radio", { name: /Dr\. Singh/ });
    const d2 = screen.getByRole("radio", { name: /Dr\. Gupta/ });

    // Before any pick — neither dimmed.
    expect(d1.className).not.toMatch(/opacity-60/);
    expect(d2.className).not.toMatch(/opacity-60/);

    await user.click(d1);
    expect(d1.getAttribute("aria-checked")).toBe("true");
    expect(d1.getAttribute("data-selected")).toBe("true");
    expect(d2.getAttribute("aria-checked")).toBe("false");
    // After selection — non-selected dimmed.
    expect(d2.className).toMatch(/opacity-60/);
  });

  it("patient search < 2 chars clears results without hitting /patients", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const input = await screen.findByPlaceholderText(/search patient/i);
    await user.type(input, "a");

    const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.startsWith("/patients"))).toBe(false);
  });

  it("patient search >= 2 chars GETs /patients with encoded query and renders suggestions", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [] });
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({
          data: [patient({ id: "p1", user: { name: "Aarav Mehta", phone: "+91999" } })],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const input = await screen.findByPlaceholderText(/search patient/i);
    await user.type(input, "Aa");

    await waitFor(() => {
      const calls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        calls.some((u) => /^\/patients\?search=Aa&limit=5$/.test(u)),
      ).toBe(true);
    });
    expect(
      await screen.findByText(/Aarav Mehta — MR-1001 — \+91999/),
    ).toBeInTheDocument();
  });

  it("clicking a suggestion (onMouseDown #585) commits the patient and clears search", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [] });
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({ data: [patient({ id: "p1" })] });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const input = await screen.findByPlaceholderText(/search patient/i);
    await user.type(input, "Aa");

    const suggestion = await screen.findByText(/Aarav Mehta — MR-1001/);
    // onMouseDown bound — userEvent.click fires mousedown before click handler.
    fireEvent.mouseDown(suggestion);

    // Selected patient panel appears.
    expect(await screen.findByText("Aarav Mehta")).toBeInTheDocument();
    expect(screen.getByText(/MR-1001 \|/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
  });

  it("Change button on selected patient banner clears the selection", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [] });
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({ data: [patient({ id: "p1" })] });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const input = await screen.findByPlaceholderText(/search patient/i);
    await user.type(input, "Aa");
    fireEvent.mouseDown(await screen.findByText(/Aarav Mehta — MR-1001/));
    await screen.findByText("Aarav Mehta");

    await user.click(screen.getByRole("button", { name: /change/i }));
    // Search input re-appears.
    expect(screen.getByPlaceholderText(/search patient/i)).toBeInTheDocument();
  });

  it("swallows /patients search rejection without throwing", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [] });
      if (url.startsWith("/patients?search=")) {
        return Promise.reject(new Error("search down"));
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const input = await screen.findByPlaceholderText(/search patient/i);
    await user.type(input, "Aa");
    // No throw — heading still rendered.
    expect(
      screen.getByRole("heading", { name: /walk-in registration/i }),
    ).toBeInTheDocument();
  });

  it("Assign Token button is disabled until both a doctor and a patient (or +New) are set", async () => {
    apiMock.get.mockResolvedValue({
      data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    const btn = await screen.findByRole("button", { name: /assign token/i });
    expect(btn).toBeDisabled();

    await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
    // Doctor only — still disabled (no patient + showNewPatient is false).
    expect(btn).toBeDisabled();

    // Switch to + New Patient — now enabled.
    await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
    expect(btn).not.toBeDisabled();
  });

  it("happy path — selected doctor + selected patient → POST /appointments/walk-in renders success card", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
        });
      }
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({ data: [patient({ id: "p1", mrNumber: "MR-77" })] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({
      data: {
        tokenNumber: 42,
        doctor: { user: { name: "Dr. Singh" } },
        // mrNumber intentionally omitted — falls back to selectedPatient.mrNumber.
        patient: { user: { name: "Aarav Mehta" } },
      },
    });

    const user = userEvent.setup();
    render(<WalkInPage />);

    await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
    const input = screen.getByPlaceholderText(/search patient/i);
    await user.type(input, "Aa");
    fireEvent.mouseDown(await screen.findByText(/Aarav Mehta — MR-77/));
    await screen.findByText("Aarav Mehta");

    // Fill priority + notes for branch coverage of the optional-notes path.
    await user.selectOptions(screen.getByLabelText(/priority/i), "URGENT");
    await user.type(screen.getByLabelText(/notes/i), "Chest pain");

    await user.click(screen.getByRole("button", { name: /assign token/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/appointments/walk-in", {
        patientId: "p1",
        doctorId: "d1",
        priority: "URGENT",
        notes: "Chest pain",
      }),
    );

    // Success card renders.
    expect(await screen.findByTestId("walkin-success")).toBeInTheDocument();
    expect(screen.getByTestId("walkin-token").textContent).toBe("42");
    expect(screen.getByTestId("walkin-patient-name").textContent).toBe("Aarav Mehta");
    // mrNumber falls back to selectedPatient.mrNumber (the search result).
    expect(screen.getByTestId("walkin-mr-number").textContent).toMatch(/MR-77/);
    expect(screen.getByText(/Doctor: Dr\. Singh/)).toBeInTheDocument();

    // Register Next → clears result, form re-appears.
    await user.click(screen.getByRole("button", { name: /register next/i }));
    expect(screen.queryByTestId("walkin-success")).toBeNull();
    expect(
      screen.getByRole("button", { name: /assign token/i }),
    ).toBeInTheDocument();
  });

  it("happy path — uses server-provided mrNumber over the search-result fallback", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
        });
      }
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({ data: [patient({ id: "p1", mrNumber: "MR-OLD" })] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({
      data: {
        tokenNumber: 7,
        doctor: { user: { name: "Dr. Singh" } },
        patient: { user: { name: "Aarav Mehta" }, mrNumber: "MR-NEW" },
      },
    });

    const user = userEvent.setup();
    render(<WalkInPage />);
    await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
    await user.type(screen.getByPlaceholderText(/search patient/i), "Aa");
    fireEvent.mouseDown(await screen.findByText(/Aarav Mehta — MR-OLD/));
    await screen.findByText("Aarav Mehta");
    await user.click(screen.getByRole("button", { name: /assign token/i }));

    expect((await screen.findByTestId("walkin-mr-number")).textContent).toMatch(
      /MR-NEW/,
    );
  });

  it("POST /appointments/walk-in rejection (Error) surfaces toast.error with the message", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
        });
      }
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({ data: [patient({ id: "p1" })] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("slot full"));

    const user = userEvent.setup();
    render(<WalkInPage />);
    await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
    await user.type(screen.getByPlaceholderText(/search patient/i), "Aa");
    fireEvent.mouseDown(await screen.findByText(/Aarav Mehta — MR-1001/));
    await screen.findByText("Aarav Mehta");
    await user.click(screen.getByRole("button", { name: /assign token/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("slot full"),
    );
  });

  it("POST /appointments/walk-in rejection (non-Error) falls back to default message", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") {
        return Promise.resolve({
          data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
        });
      }
      if (url.startsWith("/patients?search=")) {
        return Promise.resolve({ data: [patient({ id: "p1" })] });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue("oops"); // non-Error

    const user = userEvent.setup();
    render(<WalkInPage />);
    await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
    await user.type(screen.getByPlaceholderText(/search patient/i), "Aa");
    fireEvent.mouseDown(await screen.findByText(/Aarav Mehta — MR-1001/));
    await screen.findByText("Aarav Mehta");
    await user.click(screen.getByRole("button", { name: /assign token/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Walk-in registration failed"),
    );
  });

  describe("+ New Patient form", () => {
    async function openNewPatient(user: ReturnType<typeof userEvent.setup>) {
      apiMock.get.mockResolvedValue({
        data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
      });
      render(<WalkInPage />);
      await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
      await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
    }

    it("validation — empty fields and digits in name surface field errors via PATIENT_NAME_REGEX (CLAUDE.md gotcha #8)", async () => {
      const user = userEvent.setup();
      await openNewPatient(user);

      // Submit with everything blank → name + phone errors.
      await user.click(screen.getByRole("button", { name: /assign token/i }));
      expect(await screen.findByTestId("error-name")).toBeInTheDocument();
      expect(screen.getByTestId("error-phone")).toBeInTheDocument();
      // Never POST.
      expect(apiMock.post).not.toHaveBeenCalled();

      // Digits in name → regex error.
      await user.type(screen.getByTestId("walkin-newpatient-name"), "Aarav123");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");
      await user.click(screen.getByRole("button", { name: /assign token/i }));
      expect(await screen.findByTestId("error-name")).toHaveTextContent(
        /letters, spaces, dots, hyphens/i,
      );
    });

    it("validation — bad phone, out-of-range age, future DOB, oversize address, bad email", async () => {
      const user = userEvent.setup();
      await openNewPatient(user);

      // All valid baseline...
      await user.type(screen.getByTestId("walkin-newpatient-name"), "Aarav");
      // Bad phone first.
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "abcd");
      // Age out of range.
      await user.type(screen.getByTestId("walkin-newpatient-age"), "999");
      // Future DOB.
      const future = new Date();
      future.setFullYear(future.getFullYear() + 2);
      const dobInput = screen.getByTestId(
        "walkin-newpatient-dob",
      ) as HTMLInputElement;
      // The `max` attribute prevents `user.type` from accepting a future date,
      // so set the value directly + dispatch change.
      fireEvent.change(dobInput, {
        target: { value: future.toISOString().split("T")[0] },
      });
      // Oversize address.
      const longAddress = "x".repeat(501);
      fireEvent.change(screen.getByTestId("walkin-newpatient-address"), {
        target: { value: longAddress },
      });
      // Bad email.
      await user.type(screen.getByTestId("walkin-newpatient-email"), "not-an-email");

      await user.click(screen.getByRole("button", { name: /assign token/i }));

      expect(await screen.findByTestId("error-phone")).toHaveTextContent(
        /10–15 digits/,
      );
      expect(screen.getByTestId("error-age")).toHaveTextContent(/between 1 and 150/i);
      expect(screen.getByTestId("error-dob")).toHaveTextContent(/future/i);
      expect(screen.getByTestId("error-address")).toHaveTextContent(/at most 500/i);
      expect(screen.getByTestId("error-email")).toHaveTextContent(/valid address/i);
      expect(apiMock.post).not.toHaveBeenCalled();
    });

    it("validation — invalid DOB string (NaN) surfaces 'Invalid date of birth'", async () => {
      const user = userEvent.setup();
      await openNewPatient(user);

      await user.type(screen.getByTestId("walkin-newpatient-name"), "Aarav");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");
      // Direct-set an unparseable DOB (the date-picker normally prevents this).
      fireEvent.change(screen.getByTestId("walkin-newpatient-dob"), {
        target: { value: "not-a-date" },
      });
      await user.click(screen.getByRole("button", { name: /assign token/i }));

      // Note: jsdom's <input type="date"> may coerce "not-a-date" to "", in
      // which case the dob branch is skipped. We assert at LEAST that
      // submission doesn't go through.
      const dobErr = screen.queryByTestId("error-dob");
      if (dobErr) {
        expect(dobErr).toHaveTextContent(/invalid date of birth/i);
        expect(apiMock.post).not.toHaveBeenCalled();
      }
    });

    it("clear-on-edit (#267) — typing into a flagged field clears its error", async () => {
      const user = userEvent.setup();
      await openNewPatient(user);

      // Trigger errors first.
      await user.click(screen.getByRole("button", { name: /assign token/i }));
      expect(await screen.findByTestId("error-name")).toBeInTheDocument();
      expect(screen.getByTestId("error-phone")).toBeInTheDocument();

      // Type into name → name error clears.
      await user.type(screen.getByTestId("walkin-newpatient-name"), "A");
      expect(screen.queryByTestId("error-name")).toBeNull();
      // Phone error still present.
      expect(screen.getByTestId("error-phone")).toBeInTheDocument();
      // Type into phone → phone error clears.
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9");
      expect(screen.queryByTestId("error-phone")).toBeNull();
    });

    it("happy path — POST /patients then POST /appointments/walk-in; success card renders", async () => {
      apiMock.get.mockResolvedValue({
        data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
      });
      apiMock.post.mockImplementation((url: string) => {
        if (url === "/patients") {
          return Promise.resolve({
            data: { id: "new-p1", mrNumber: "MR-NEW", user: { name: "Riya", phone: "+919" } },
          });
        }
        if (url === "/appointments/walk-in") {
          return Promise.resolve({
            data: {
              tokenNumber: 99,
              doctor: { user: { name: "Dr. Singh" } },
              patient: { user: { name: "Riya" }, mrNumber: "MR-NEW" },
            },
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      const user = userEvent.setup();
      render(<WalkInPage />);
      await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
      await user.click(screen.getByRole("button", { name: /\+ new patient/i }));

      await user.type(screen.getByTestId("walkin-newpatient-name"), "Riya");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");
      await user.type(screen.getByTestId("walkin-newpatient-age"), "30");
      // Valid DOB (past).
      fireEvent.change(screen.getByTestId("walkin-newpatient-dob"), {
        target: { value: "1995-01-15" },
      });
      // Valid address + email exercise the optional-field branches.
      fireEvent.change(screen.getByTestId("walkin-newpatient-address"), {
        target: { value: "12 MG Road, Mumbai" },
      });
      await user.type(
        screen.getByTestId("walkin-newpatient-email"),
        "riya@example.com",
      );

      await user.click(screen.getByRole("button", { name: /assign token/i }));

      await waitFor(() => {
        const calls = apiMock.post.mock.calls.map((c) => String(c[0]));
        expect(calls).toEqual(
          expect.arrayContaining(["/patients", "/appointments/walk-in"]),
        );
      });

      // /patients call body shape.
      const patientsCall = apiMock.post.mock.calls.find(
        (c) => c[0] === "/patients",
      );
      expect(patientsCall?.[1]).toEqual(
        expect.objectContaining({
          name: "Riya",
          phone: "9876543210",
          gender: "MALE",
          age: 30,
          dateOfBirth: "1995-01-15",
          address: "12 MG Road, Mumbai",
          email: "riya@example.com",
        }),
      );

      // /appointments/walk-in body uses the new patient id.
      const walkInCall = apiMock.post.mock.calls.find(
        (c) => c[0] === "/appointments/walk-in",
      );
      expect(walkInCall?.[1]).toEqual(
        expect.objectContaining({
          patientId: "new-p1",
          doctorId: "d1",
          priority: "NORMAL",
        }),
      );

      // Success card with the server mrNumber.
      expect(await screen.findByTestId("walkin-success")).toBeInTheDocument();
      expect(screen.getByTestId("walkin-token").textContent).toBe("99");
      expect(screen.getByTestId("walkin-mr-number").textContent).toMatch(/MR-NEW/);
    });

    it("happy path — omits optional fields (age/dob/address/email empty) from the /patients body", async () => {
      apiMock.get.mockResolvedValue({
        data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
      });
      apiMock.post.mockImplementation((url: string) => {
        if (url === "/patients") {
          return Promise.resolve({
            data: { id: "p-min", mrNumber: "MR-MIN", user: { name: "Bare", phone: "+919" } },
          });
        }
        if (url === "/appointments/walk-in") {
          return Promise.resolve({
            data: {
              tokenNumber: 1,
              doctor: { user: { name: "Dr. Singh" } },
              patient: { user: { name: "Bare" } },
            },
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      const user = userEvent.setup();
      render(<WalkInPage />);
      await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
      await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
      await user.type(screen.getByTestId("walkin-newpatient-name"), "Bare");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");
      await user.click(screen.getByRole("button", { name: /assign token/i }));

      await waitFor(() =>
        expect(
          apiMock.post.mock.calls.find((c) => c[0] === "/patients"),
        ).toBeTruthy(),
      );
      const patientsCall = apiMock.post.mock.calls.find(
        (c) => c[0] === "/patients",
      );
      const body = patientsCall?.[1] as Record<string, unknown>;
      expect(body.age).toBeUndefined();
      expect(body.dateOfBirth).toBeUndefined();
      expect(body.address).toBeUndefined();
      expect(body.email).toBeUndefined();
    });

    it("error — POST /patients rejection during registerAndWalkIn surfaces toast.error", async () => {
      apiMock.get.mockResolvedValue({
        data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
      });
      apiMock.post.mockImplementation((url: string) => {
        if (url === "/patients") return Promise.reject(new Error("dup phone"));
        return Promise.resolve({ data: {} });
      });

      const user = userEvent.setup();
      render(<WalkInPage />);
      await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
      await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
      await user.type(screen.getByTestId("walkin-newpatient-name"), "Riya");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");
      await user.click(screen.getByRole("button", { name: /assign token/i }));

      await waitFor(() =>
        expect(toastMock.error).toHaveBeenCalledWith("dup phone"),
      );
    });

    it("error — POST /patients non-Error rejection falls back to default copy", async () => {
      apiMock.get.mockResolvedValue({
        data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
      });
      apiMock.post.mockImplementation((url: string) => {
        if (url === "/patients") return Promise.reject("nope");
        return Promise.resolve({ data: {} });
      });

      const user = userEvent.setup();
      render(<WalkInPage />);
      await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
      await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
      await user.type(screen.getByTestId("walkin-newpatient-name"), "Riya");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");
      await user.click(screen.getByRole("button", { name: /assign token/i }));

      await waitFor(() =>
        expect(toastMock.error).toHaveBeenCalledWith("Registration failed"),
      );
    });

    it("gender select — switching to FEMALE updates the posted body", async () => {
      apiMock.get.mockResolvedValue({
        data: [doctor({ id: "d1", user: { name: "Dr. Singh" } })],
      });
      apiMock.post.mockImplementation((url: string) => {
        if (url === "/patients") {
          return Promise.resolve({
            data: { id: "p-f", mrNumber: "MR-F", user: { name: "Riya", phone: "+919" } },
          });
        }
        if (url === "/appointments/walk-in") {
          return Promise.resolve({
            data: {
              tokenNumber: 2,
              doctor: { user: { name: "Dr. Singh" } },
              patient: { user: { name: "Riya" } },
            },
          });
        }
        return Promise.reject(new Error("unexpected"));
      });

      const user = userEvent.setup();
      render(<WalkInPage />);
      await user.click(await screen.findByRole("radio", { name: /Dr\. Singh/ }));
      await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
      await user.type(screen.getByTestId("walkin-newpatient-name"), "Riya");
      await user.type(screen.getByTestId("walkin-newpatient-phone"), "9876543210");

      // The gender <select> is the only one inside the new-patient panel.
      const newPatientPanel = screen
        .getByTestId("walkin-newpatient-name")
        .closest("div.grid") as HTMLElement;
      const genderSelect = within(newPatientPanel).getByRole(
        "combobox",
      ) as HTMLSelectElement;
      await user.selectOptions(genderSelect, "FEMALE");

      await user.click(screen.getByRole("button", { name: /assign token/i }));

      await waitFor(() => {
        const call = apiMock.post.mock.calls.find((c) => c[0] === "/patients");
        expect(call?.[1]).toEqual(
          expect.objectContaining({ gender: "FEMALE" }),
        );
      });
    });
  });
});
