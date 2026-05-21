// Smoke tests for the patient PWA "My Profile" page (Pearl §6.1 — gap
// #5 piece 3e of 4). Asserts:
//   • Renders the form populated from /auth/me + /notifications/preferences.
//   • Partial /auth/me (no patient row) still renders gracefully.
//   • Submit fans out to /auth/me PATCH + /patients/me PATCH +
//     /notifications/preferences PUT, only for dirty fields.
//   • Validation errors surface inline via the API's
//     `{details: [{field, message}]}` payload shape.
//   • Phone is presented read-only (no edit affordance) with the
//     reception-handoff hint.
//   • Cancel resets the form back to the initial GET payload.
//   • 44px touch-target invariant on Save / Cancel / ABHA-link CTAs.
//   • Unauth 401 surface renders the sign-in nudge.
//
// Uses vi.hoisted for the api mock per CLAUDE.md gotcha #2 (singleFork
// vitest pattern — same shape as pieces 3b / 3c / 3d).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPatchMock, apiPutMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
  apiPutMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: apiPatchMock,
    put: apiPutMock,
    delete: vi.fn(),
  },
}));

import PatientProfilePage from "../page";

interface MeFixture {
  name?: string;
  phone?: string | null;
  email?: string | null;
  preferredLanguage?: string | null;
  patient?: {
    id?: string;
    dateOfBirth?: string | null;
    address?: string | null;
    gender?: string | null;
    preferredLanguage?: string | null;
    abhaId?: string | null;
  } | null;
}

function meOk(opts: MeFixture = {}) {
  return {
    success: true,
    error: null,
    data: {
      id: "u1",
      role: "PATIENT",
      name: opts.name ?? "Anand Kumar",
      phone: opts.phone ?? "+919876543210",
      email: opts.email ?? null,
      preferredLanguage: opts.preferredLanguage ?? "en",
      photoUrl: null,
      patient: opts.patient === null
        ? null
        : {
            id: "p1",
            dateOfBirth: opts.patient?.dateOfBirth ?? "1990-05-15",
            address: opts.patient?.address ?? "Flat 4B, Andheri West, Mumbai 400053",
            gender: opts.patient?.gender ?? "MALE",
            preferredLanguage: opts.patient?.preferredLanguage ?? "en",
            abhaId: opts.patient?.abhaId ?? null,
          },
    },
  };
}

function prefsOk(rows?: Array<{ channel: string; enabled: boolean }>) {
  return {
    success: true,
    error: null,
    data: rows ?? [
      { channel: "WHATSAPP", enabled: true },
      { channel: "SMS", enabled: true },
      { channel: "EMAIL", enabled: false },
      { channel: "PUSH", enabled: true },
    ],
  };
}

function rejectedWithStatus(status: number) {
  return Promise.reject(Object.assign(new Error("nope"), { status }));
}

function mockGets(opts: {
  me?: unknown | Promise<unknown>;
  prefs?: unknown | Promise<unknown>;
}) {
  apiGetMock.mockImplementation((endpoint: string) => {
    if (endpoint.startsWith("/auth/me")) {
      const v = opts.me ?? meOk();
      return v instanceof Promise ? v : Promise.resolve(v);
    }
    if (endpoint.startsWith("/notifications/preferences")) {
      const v = opts.prefs ?? prefsOk();
      return v instanceof Promise ? v : Promise.resolve(v);
    }
    return Promise.resolve({ success: true, data: null, error: null });
  });
}

describe("Patient profile page — gap #5 piece 3e", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPutMock.mockReset();
    apiPatchMock.mockResolvedValue({ success: true, data: {}, error: null });
    apiPutMock.mockResolvedValue({ success: true, data: [], error: null });
  });

  it("renders the form populated from /auth/me + /notifications/preferences", async () => {
    mockGets({});

    render(<PatientProfilePage />);

    await waitFor(() => {
      expect(screen.getByTestId("patient-profile")).toBeInTheDocument();
    });

    expect(
      (screen.getByTestId("patient-profile-name-input") as HTMLInputElement).value,
    ).toBe("Anand Kumar");
    expect(
      (screen.getByTestId("patient-profile-dob-input") as HTMLInputElement).value,
    ).toBe("1990-05-15");
    expect(
      (screen.getByTestId("patient-profile-address-input") as HTMLTextAreaElement).value,
    ).toContain("Andheri");
    expect(
      (screen.getByTestId("patient-profile-language-select") as HTMLSelectElement)
        .value,
    ).toBe("en");
    // Gender renders read-only when present
    expect(screen.getByTestId("patient-profile-gender-input")).toBeInTheDocument();
  });

  it("renders gracefully when /auth/me returns a user with no patient row", async () => {
    mockGets({
      me: meOk({ patient: null }),
      prefs: prefsOk([]),
    });
    render(<PatientProfilePage />);
    await waitFor(() => {
      expect(screen.getByTestId("patient-profile")).toBeInTheDocument();
    });
    // DOB / address default to empty; no gender block rendered
    expect(
      (screen.getByTestId("patient-profile-dob-input") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByTestId("patient-profile-address-input") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(screen.queryByTestId("patient-profile-gender-input")).not.toBeInTheDocument();
  });

  it("phone field is read-only with a reception-handoff hint", async () => {
    mockGets({});
    render(<PatientProfilePage />);
    await waitFor(() => screen.getByTestId("patient-profile"));
    const phone = screen.getByTestId("patient-profile-phone-input") as HTMLInputElement;
    expect(phone.readOnly).toBe(true);
    expect(phone.value).toBe("+919876543210");
    expect(screen.getByTestId("patient-profile-phone-hint")).toBeInTheDocument();
  });

  it("Save fires PATCH/PUT only for dirty fields and shows the saved toast", async () => {
    mockGets({});
    render(<PatientProfilePage />);
    await waitFor(() => screen.getByTestId("patient-profile"));

    // Edit name only (user-level field) and toggle EMAIL (channels).
    fireEvent.change(screen.getByTestId("patient-profile-name-input"), {
      target: { value: "Anand K. Kumar" },
    });
    fireEvent.click(screen.getByTestId("patient-profile-channel-email"));

    fireEvent.click(screen.getByTestId("patient-profile-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("patient-profile-saved-toast")).toBeInTheDocument();
    });

    // /auth/me PATCH with name only (preferredLanguage untouched)
    expect(apiPatchMock).toHaveBeenCalledWith(
      "/auth/me",
      expect.objectContaining({ name: "Anand K. Kumar" }),
    );
    // /patients/me NOT called — no patient-row field dirty
    expect(
      apiPatchMock.mock.calls.some((c) => c[0] === "/patients/me"),
    ).toBe(false);
    // /notifications/preferences PUT with the full 4-channel array, EMAIL flipped on
    expect(apiPutMock).toHaveBeenCalledWith(
      "/notifications/preferences",
      expect.objectContaining({
        preferences: expect.arrayContaining([
          expect.objectContaining({ channel: "EMAIL", enabled: true }),
        ]),
      }),
    );
  });

  it("PATCH /patients/me fires when address or DOB or abhaId changes", async () => {
    mockGets({});
    render(<PatientProfilePage />);
    await waitFor(() => screen.getByTestId("patient-profile"));

    fireEvent.change(screen.getByTestId("patient-profile-address-input"), {
      target: { value: "New Address 123" },
    });
    fireEvent.change(screen.getByTestId("patient-profile-abha-input"), {
      target: { value: "14-1234-5678-9012" },
    });
    fireEvent.click(screen.getByTestId("patient-profile-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("patient-profile-saved-toast")).toBeInTheDocument();
    });

    const patientsMeCall = apiPatchMock.mock.calls.find((c) => c[0] === "/patients/me");
    expect(patientsMeCall).toBeDefined();
    expect(patientsMeCall![1]).toEqual(
      expect.objectContaining({
        address: "New Address 123",
        abhaId: "14-1234-5678-9012",
      }),
    );
  });

  it("surfaces server-side field errors inline via the details[] payload", async () => {
    mockGets({});
    apiPatchMock.mockImplementation((endpoint: string) => {
      if (endpoint === "/patients/me") {
        return Promise.reject(
          Object.assign(new Error("Invalid payload"), {
            status: 400,
            payload: {
              success: false,
              error: "Invalid payload",
              details: [{ field: "dateOfBirth", message: "Date of birth must be in the past" }],
            },
          }),
        );
      }
      return Promise.resolve({ success: true, data: {}, error: null });
    });

    render(<PatientProfilePage />);
    await waitFor(() => screen.getByTestId("patient-profile"));

    fireEvent.change(screen.getByTestId("patient-profile-dob-input"), {
      target: { value: "2099-01-01" },
    });
    fireEvent.click(screen.getByTestId("patient-profile-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("patient-profile-dob-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("patient-profile-submit-error")).toBeInTheDocument();
  });

  it("Cancel resets the form to the initial GET payload", async () => {
    mockGets({});
    render(<PatientProfilePage />);
    await waitFor(() => screen.getByTestId("patient-profile"));

    const nameInput = screen.getByTestId("patient-profile-name-input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Different Name" } });
    expect(nameInput.value).toBe("Different Name");

    fireEvent.click(screen.getByTestId("patient-profile-cancel-btn"));
    expect(nameInput.value).toBe("Anand Kumar");
  });

  it("Save / Cancel / ABHA-link CTAs carry the 44px touch-target invariant", async () => {
    mockGets({});
    render(<PatientProfilePage />);
    await waitFor(() => screen.getByTestId("patient-profile"));

    for (const id of [
      "patient-profile-save-btn",
      "patient-profile-cancel-btn",
      "patient-profile-abha-link-cta",
    ]) {
      const el = screen.getByTestId(id);
      expect(el.className).toMatch(/\bh-11\b/);
      expect(el.className).toMatch(/min-w-\[44px\]/);
    }
  });

  it("renders the unauth sign-in nudge when /auth/me 401s", async () => {
    mockGets({ me: rejectedWithStatus(401), prefs: rejectedWithStatus(401) });
    render(<PatientProfilePage />);
    await waitFor(() => {
      expect(screen.getByTestId("patient-profile-unauth")).toBeInTheDocument();
    });
    expect(screen.getByTestId("patient-profile-signin-cta")).toBeInTheDocument();
  });
});
