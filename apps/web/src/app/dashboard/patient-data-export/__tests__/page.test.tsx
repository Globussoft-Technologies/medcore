// Coverage tests for the Patient Data Export dashboard page
// (apps/web/src/app/dashboard/patient-data-export/page.tsx). The page is
// the PATIENT-only DPDP-Act-2023 right-to-portability workbench: lets a
// caller pick a format (JSON / FHIR / PDF), POSTs /patient-data-export to
// queue a request, polls each known row's status every 5s while it is
// QUEUED/PROCESSING, and surfaces a signed download link once READY.
// Staff roles are bounced to /dashboard with a toast — the API also
// refuses them but the client gate saves a roundtrip.
// Why: the page was at 0% coverage. These assertions lock in the auth
// gate (PATIENT-only bounce + null render for non-PATIENT), the format
// picker default + change, the queue-request happy path (POST shape +
// row insertion + success toast), the 429 rate-limit branch, the generic
// error branch, the polling contract (interval registered while
// QUEUED/PROCESSING, cleared when no row is active, refresh GETs each
// row), and the absolute-URL download link for READY rows. The page has
// no client-side VIEW_ALLOWED gate beyond the role check (CLAUDE.md
// gotcha #7) — server-side authorize(PATIENT) is asserted at the API
// layer and not exercised here.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPostMock, authMock, toastSuccessMock, toastErrorMock, routerPushMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    authMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
    routerPushMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
    setLang: vi.fn(),
    lang: "en",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patient-data-export",
}));

import PatientDataExportPage from "../page";

// Auth helpers — the page calls `useAuthStore()` (no selector), so the
// mock must return the full state object when invoked.
function asPatient() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "p-1", name: "Asha", email: "asha@x.com", role: "PATIENT" },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asDoctor() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "d-1", name: "Doc", email: "doc@x.com", role: "DOCTOR" },
      isLoading: false,
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asLoading() {
  authMock.mockImplementation((selector?: any) => {
    const state = { user: null, isLoading: true };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("Patient Data Export dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    authMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    routerPushMock.mockReset();
  });

  it("renders nothing while the auth store is hydrating", () => {
    asLoading();
    const { container } = render(<PatientDataExportPage />);
    expect(container.firstChild).toBeNull();
    // No router push for a still-loading state.
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("redirects non-PATIENT roles to /dashboard with a forbidden toast and renders nothing", async () => {
    asDoctor();
    const { container } = render(<PatientDataExportPage />);

    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/dashboard"));
    expect(toastErrorMock).toHaveBeenCalledWith(
      "This page is only available to patients.",
    );
    // Page returns null for the staff branch — no chrome rendered.
    expect(container.firstChild).toBeNull();
  });

  it("renders the header, disclaimer, format picker (default=json), and empty past-exports list for a PATIENT", async () => {
    asPatient();
    render(<PatientDataExportPage />);

    expect(
      await screen.findByRole("heading", { name: /Download My Data/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Right to Data Portability/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/We will package everything this hospital holds about you/i),
    ).toBeInTheDocument();

    // Three radio options.
    const jsonRadio = screen.getByRole("radio", { name: /JSON — full record/i }) as HTMLInputElement;
    const fhirRadio = screen.getByRole("radio", { name: /FHIR R4 bundle/i }) as HTMLInputElement;
    const pdfRadio = screen.getByRole("radio", { name: /PDF summary/i }) as HTMLInputElement;
    expect(jsonRadio.checked).toBe(true);
    expect(fhirRadio.checked).toBe(false);
    expect(pdfRadio.checked).toBe(false);

    // Empty past-exports list.
    expect(screen.getByText(/No exports yet\./i)).toBeInTheDocument();

    // Initial mount fires NO GET — the page has no list endpoint.
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("switches the selected format when a different radio is clicked", async () => {
    asPatient();
    render(<PatientDataExportPage />);

    const fhirRadio = await screen.findByRole("radio", { name: /FHIR R4 bundle/i }) as HTMLInputElement;
    fireEvent.click(fhirRadio);
    expect(fhirRadio.checked).toBe(true);

    const pdfRadio = screen.getByRole("radio", { name: /PDF summary/i }) as HTMLInputElement;
    fireEvent.click(pdfRadio);
    expect(pdfRadio.checked).toBe(true);
    expect(fhirRadio.checked).toBe(false);
  });

  it("POSTs the request-export payload with the selected format and prepends the queued row + success toast", async () => {
    asPatient();
    apiPostMock.mockResolvedValue({
      data: { requestId: "req-1", format: "fhir", status: "QUEUED" },
    });
    render(<PatientDataExportPage />);

    // Switch to FHIR before submitting.
    const fhirRadio = await screen.findByRole("radio", { name: /FHIR R4 bundle/i });
    fireEvent.click(fhirRadio);

    fireEvent.click(screen.getByRole("button", { name: /Request export/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    expect(apiPostMock).toHaveBeenCalledWith("/patient-data-export", {
      format: "fhir",
    });

    // Success toast + queued row appears with the FHIR label and a Queued chip.
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Export queued. We'll email you when it's ready.",
      ),
    );
    expect(screen.getByText("fhir")).toBeInTheDocument();
    expect(screen.getByText(/^Queued$/i)).toBeInTheDocument();
    // Empty placeholder gone.
    expect(screen.queryByText(/No exports yet\./i)).not.toBeInTheDocument();
  });

  it("surfaces the 429 rate-limit branch with the specific copy and toasts the same message", async () => {
    asPatient();
    apiPostMock.mockRejectedValue({ status: 429, message: "Too many" });
    render(<PatientDataExportPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Request export/i }));

    const expected =
      "You have reached the daily limit of 3 exports. Try again in 24 hours.";
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(expected),
    );
    // Inline error <p> renders below the button.
    expect(screen.getByText(expected)).toBeInTheDocument();
    // No row inserted on failure.
    expect(screen.getByText(/No exports yet\./i)).toBeInTheDocument();
  });

  it("uses the rejected error's .message for generic failures (non-429)", async () => {
    asPatient();
    apiPostMock.mockRejectedValue({ status: 500, message: "boom" });
    render(<PatientDataExportPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Request export/i }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("boom"),
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("falls back to the generic copy when the rejected error has no message and no status", async () => {
    asPatient();
    apiPostMock.mockRejectedValue({});
    render(<PatientDataExportPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Request export/i }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Export request failed."),
    );
  });

  it("disables the submit button while the POST is in flight and re-enables on settle", async () => {
    asPatient();
    let resolvePost: (v: any) => void = () => {};
    apiPostMock.mockImplementation(
      () => new Promise((res) => { resolvePost = res; }),
    );
    render(<PatientDataExportPage />);

    const btn = await screen.findByRole("button", { name: /Request export/i });
    fireEvent.click(btn);

    // While pending: the label flips to "Requesting..." and the button is disabled.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Requesting\.\.\./i }),
      ).toBeDisabled();
    });

    // Settle the post — button comes back.
    await act(async () => {
      resolvePost({
        data: { requestId: "req-x", format: "json", status: "QUEUED" },
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Request export/i }),
      ).not.toBeDisabled();
    });
  });

  it("registers a 5s poll while a row is QUEUED/PROCESSING and refreshes each row via GET /patient-data-export/:id", async () => {
    asPatient();
    // First the POST creates the queued row…
    apiPostMock.mockResolvedValue({
      data: { requestId: "req-1", format: "json", status: "QUEUED" },
    });
    // …then the refresh poll GETs the row and finds it READY with a download URL.
    apiGetMock.mockResolvedValue({
      data: {
        requestId: "req-1",
        format: "json",
        status: "READY",
        requestedAt: new Date().toISOString(),
        readyAt: new Date().toISOString(),
        errorMessage: null,
        fileSize: 1024,
        downloadUrl: "/downloads/req-1.zip",
        downloadTtlSeconds: 3600,
      },
    });

    // Intercept setInterval at the page seam so we can drive the poll
    // manually (same pattern as live-queue/__tests__/page.test.tsx).
    let capturedTick: (() => void) | null = null;
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(((fn: any, delay: any, ...rest: any[]) => {
        if (delay === 5000) {
          capturedTick = fn;
          return 31337 as any;
        }
        return realSetInterval(fn, delay, ...rest);
      }) as any);

    try {
      render(<PatientDataExportPage />);

      // Queue the request — the row goes into state as QUEUED, which
      // triggers the poll-registration effect.
      fireEvent.click(
        await screen.findByRole("button", { name: /Request export/i }),
      );
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));

      // Interval must have been registered for the 5s cadence.
      await waitFor(() => expect(capturedTick).toBeTypeOf("function"));

      // Fire the tick manually — the refresh callback GETs the row by id.
      await act(async () => {
        await capturedTick!();
      });

      await waitFor(() => {
        expect(apiGetMock).toHaveBeenCalledWith("/patient-data-export/req-1");
      });

      // After the refresh, the row's status flips to READY and the
      // Download link renders.
      await waitFor(() => {
        const link = screen.getByRole("link", { name: /Download/i });
        expect(link).toBeInTheDocument();
        // The page calls absoluteDownloadUrl() — relative paths get
        // joined to the ORIGIN derived from NEXT_PUBLIC_API_URL (or the
        // localhost:4000 default).
        const href = link.getAttribute("href") || "";
        expect(href).toMatch(/\/downloads\/req-1\.zip$/);
        expect(href.startsWith("http")).toBe(true);
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("swallows a refresh GET rejection and keeps the prior row in place", async () => {
    asPatient();
    apiPostMock.mockResolvedValue({
      data: { requestId: "req-err", format: "json", status: "PROCESSING" },
    });
    apiGetMock.mockRejectedValue(new Error("network blip"));

    let capturedTick: (() => void) | null = null;
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(((fn: any, delay: any, ...rest: any[]) => {
        if (delay === 5000) {
          capturedTick = fn;
          return 42 as any;
        }
        return realSetInterval(fn, delay, ...rest);
      }) as any);

    try {
      render(<PatientDataExportPage />);
      fireEvent.click(
        await screen.findByRole("button", { name: /Request export/i }),
      );
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(capturedTick).toBeTypeOf("function"));

      // Drive the tick — the GET rejects, the catch returns the prior row
      // unchanged, and the Processing chip remains.
      await act(async () => {
        await capturedTick!();
      });

      await waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
      // Processing chip is still rendered (row preserved on error).
      expect(screen.getByText(/^Processing$/i)).toBeInTheDocument();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does NOT register a poll when no row is active (e.g. only READY/FAILED rows present)", async () => {
    asPatient();
    // POST returns a terminal status — no QUEUED/PROCESSING row, no poll.
    apiPostMock.mockResolvedValue({
      data: { requestId: "req-done", format: "pdf", status: "READY" },
    });

    let intervalRegistered = false;
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(((fn: any, delay: any, ...rest: any[]) => {
        if (delay === 5000) intervalRegistered = true;
        return realSetInterval(fn, delay, ...rest);
      }) as any);

    try {
      render(<PatientDataExportPage />);
      fireEvent.click(
        await screen.findByRole("button", { name: /Request export/i }),
      );
      await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));

      // Give the polling-effect a chance to run; it should choose not to
      // register an interval because no row is QUEUED/PROCESSING.
      await waitFor(() => expect(screen.getByText("pdf")).toBeInTheDocument());
      expect(intervalRegistered).toBe(false);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("renders an absolute download URL verbatim when the server returns an http(s) link", async () => {
    asPatient();
    apiPostMock.mockResolvedValue({
      data: { requestId: "req-abs", format: "json", status: "QUEUED" },
    });
    apiGetMock.mockResolvedValue({
      data: {
        requestId: "req-abs",
        format: "json",
        status: "READY",
        requestedAt: new Date().toISOString(),
        readyAt: new Date().toISOString(),
        errorMessage: null,
        fileSize: 99,
        downloadUrl: "https://signed.example.com/req-abs.zip",
        downloadTtlSeconds: 3600,
      },
    });

    let capturedTick: (() => void) | null = null;
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(((fn: any, delay: any, ...rest: any[]) => {
        if (delay === 5000) {
          capturedTick = fn;
          return 7 as any;
        }
        return realSetInterval(fn, delay, ...rest);
      }) as any);

    try {
      render(<PatientDataExportPage />);
      fireEvent.click(
        await screen.findByRole("button", { name: /Request export/i }),
      );
      await waitFor(() => expect(capturedTick).toBeTypeOf("function"));
      await act(async () => {
        await capturedTick!();
      });

      await waitFor(() => {
        const link = screen.getByRole("link", { name: /Download/i });
        // Absolute URL is preserved verbatim (no ORIGIN prefix).
        expect(link).toHaveAttribute(
          "href",
          "https://signed.example.com/req-abs.zip",
        );
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("renders the inline error message text alongside a FAILED row", async () => {
    asPatient();
    // Seed via POST returning a row, then refresh-GET returns FAILED + msg.
    apiPostMock.mockResolvedValue({
      data: { requestId: "req-bad", format: "json", status: "QUEUED" },
    });
    apiGetMock.mockResolvedValue({
      data: {
        requestId: "req-bad",
        format: "json",
        status: "FAILED",
        requestedAt: new Date().toISOString(),
        readyAt: null,
        errorMessage: "Renderer crashed mid-export",
        fileSize: null,
        downloadUrl: null,
        downloadTtlSeconds: null,
      },
    });

    let capturedTick: (() => void) | null = null;
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(((fn: any, delay: any, ...rest: any[]) => {
        if (delay === 5000) {
          capturedTick = fn;
          return 8 as any;
        }
        return realSetInterval(fn, delay, ...rest);
      }) as any);

    try {
      render(<PatientDataExportPage />);
      fireEvent.click(
        await screen.findByRole("button", { name: /Request export/i }),
      );
      await waitFor(() => expect(capturedTick).toBeTypeOf("function"));
      await act(async () => {
        await capturedTick!();
      });

      await waitFor(() => {
        expect(screen.getByText(/^Failed$/i)).toBeInTheDocument();
        expect(
          screen.getByText("Renderer crashed mid-export"),
        ).toBeInTheDocument();
      });
      // No Download link for FAILED rows.
      expect(
        screen.queryByRole("link", { name: /Download/i }),
      ).not.toBeInTheDocument();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
