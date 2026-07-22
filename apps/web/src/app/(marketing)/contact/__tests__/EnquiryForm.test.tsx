/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Marketing "Request a Demo" EnquiryForm — component coverage.
 *
 * What / which modules / why:
 *   - Source under test: apps/web/src/app/(marketing)/contact/EnquiryForm.tsx
 *   - The form runs the shared marketingEnquirySchema (from @medcore/shared)
 *     on the client and posts to `${NEXT_PUBLIC_API_URL || '/api/v1'}/marketing/enquiry`.
 *   - The tests cover:
 *       1. Initial render — every required field + hidden honeypot are present.
 *       2. Client-side validation rejects empty / short submissions, surfaces a
 *          per-field <p role="alert">, and never fires fetch.
 *       3. Bad phone (non-Indian-mobile) surfaces a phone error; empty phone
 *          passes (optional field) when the rest of the form is valid.
 *       4. Bad email surfaces an inline email error.
 *       5. Happy path — valid payload POSTs to /api/v1/marketing/enquiry with
 *          the trimmed, parsed body and the success screen renders + can
 *          reset back to idle via "Submit another enquiry".
 *       6. NEXT_PUBLIC_API_URL override — when set, fetch hits the overridden
 *          host instead of the relative /api/v1.
 *       7. Server-returned 400 with structured `errors[]` maps back onto
 *          inline field errors (NOT a generic toast).
 *       8. Non-400 error response with a `data.error` string surfaces it as
 *          the general-error banner.
 *       9. Network failure (fetch reject) surfaces the network-error banner.
 *      10. Submitting state — button shows "Sending..." mid-flight and is
 *          disabled.
 *
 * Notes:
 *   - The shared schema lives in @medcore/shared and is mocked at the package
 *     boundary so the test doesn't need its compiled output to be present in
 *     node_modules at test time. The mock mirrors the real schema's validation
 *     surface closely enough to exercise the form's error-mapping branches.
 *   - The i18n `t()` returns `fallback ?? key`, so the English fallback strings
 *     in the source (e.g. "Full name", "Request a Demo") are what render.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

// --- Mock @medcore/shared so the schema runs in-process. We mirror the real
// schema's important branches: required strings, email format, enum scopes,
// Indian-mobile phone, and message min-length 10.
const { sharedMock } = vi.hoisted(() => {
  const INDIAN_MOBILE_RE = /^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/;
  return {
    sharedMock: {
      marketingEnquirySchema: {
        safeParse(input: any) {
          const issues: { path: string[]; message: string }[] = [];
          const push = (path: string, message: string) =>
            issues.push({ path: [path], message });

          if (!input.fullName || input.fullName.length < 2) {
            push("fullName", "Name must be at least 2 characters");
          }
          if (!input.email) {
            push("email", "Enter a valid email address");
          } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
            push("email", "Enter a valid email address");
          }
          if (input.phone && input.phone !== "") {
            const cleaned = String(input.phone).replace(/\s|-/g, "");
            if (!INDIAN_MOBILE_RE.test(cleaned)) {
              push("phone", "Enter a valid Indian mobile number");
            }
          }
          if (!input.hospitalName || input.hospitalName.length < 2) {
            push("hospitalName", "Hospital name must be at least 2 characters");
          }
          if (
            !["1-10", "10-50", "50-200", "200+"].includes(input.hospitalSize)
          ) {
            push("hospitalSize", "Select a hospital size");
          }
          if (
            !["Administrator", "Doctor", "IT", "Other"].includes(input.role)
          ) {
            push("role", "Select your role");
          }
          if (!input.message || input.message.length < 10) {
            push("message", "Message must be at least 10 characters");
          }
          if (issues.length > 0) {
            return { success: false, error: { issues } } as const;
          }
          // Strip honeypot + normalize empty phone to undefined.
          const data = {
            fullName: input.fullName,
            email: input.email,
            phone: input.phone === "" ? undefined : input.phone,
            hospitalName: input.hospitalName,
            hospitalSize: input.hospitalSize,
            role: input.role,
            message: input.message,
            preferredContactTime: input.preferredContactTime,
            website: input.website,
          };
          return { success: true, data } as const;
        },
      },
    },
  };
});

vi.mock("@medcore/shared", () => sharedMock);

// i18n — return the English fallback so the rendered copy matches the source.
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    lang: "en",
    setLang: vi.fn(),
  }),
}));

import { EnquiryForm } from "../EnquiryForm";

// Helper — fills every required field with valid values via fireEvent.input
// on the underlying named inputs (the form reads via FormData, so DOM `name`
// is what matters).
function fillValidForm() {
  fireEvent.input(document.getElementById("fullName") as HTMLInputElement, {
    target: { value: "Dr Meera Rao" },
  });
  fireEvent.input(document.getElementById("email") as HTMLInputElement, {
    target: { value: "meera@hospital.in" },
  });
  fireEvent.input(document.getElementById("hospitalName") as HTMLInputElement, {
    target: { value: "Asha Hospital" },
  });
  fireEvent.change(document.getElementById("hospitalSize") as HTMLSelectElement, {
    target: { value: "50-200" },
  });
  fireEvent.change(document.getElementById("role") as HTMLSelectElement, {
    target: { value: "Doctor" },
  });
  fireEvent.input(document.getElementById("message") as HTMLTextAreaElement, {
    target: {
      value: "We are exploring HMS solutions for our 120-bed multi-spec setup.",
    },
  });
}

describe("Marketing EnquiryForm", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const ORIGINAL_API_URL = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    cleanup();
    fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    (globalThis as any).__fetchMockLocked = true;
    // Default to relative /api/v1 unless a test overrides.
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    (globalThis as any).__fetchMockLocked = false;
    if (ORIGINAL_API_URL === undefined) {
      delete process.env.NEXT_PUBLIC_API_URL;
    } else {
      process.env.NEXT_PUBLIC_API_URL = ORIGINAL_API_URL;
    }
  });

  it("renders all visible fields, the submit button, the consent line, and the hidden honeypot", () => {
    render(<EnquiryForm />);

    // Scope to id since several labels have similar text (e.g. "Phone" vs
    // "Preferred contact time"). The form reads via FormData(name=*) so id is
    // load-bearing anyway.
    expect(document.getElementById("fullName")).toBeInTheDocument();
    expect(document.getElementById("email")).toBeInTheDocument();
    expect(document.getElementById("phone")).toBeInTheDocument();
    expect(document.getElementById("hospitalName")).toBeInTheDocument();
    expect(document.getElementById("hospitalSize")).toBeInTheDocument();
    expect(document.getElementById("role")).toBeInTheDocument();
    expect(document.getElementById("preferredContactTime")).toBeInTheDocument();
    expect(document.getElementById("message")).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: /request a demo/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/by submitting/i)).toBeInTheDocument();

    // Honeypot is rendered but visually hidden.
    const honeypot = document.querySelector(
      'input[name="website"]',
    ) as HTMLInputElement | null;
    expect(honeypot).not.toBeNull();
    expect(honeypot!.tabIndex).toBe(-1);
  });

  it("client-side validation rejects an empty submission, renders per-field role=alert errors, and never fires fetch", async () => {
    render(<EnquiryForm />);

    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    // Multiple inline field errors should render. We check a representative
    // sample of required-field messages (every error is a <p role="alert">).
    // "Name must..." matches both fullName + hospitalName, so address by id.
    await waitFor(() => {
      expect(document.getElementById("fullName-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("enquiry-field-summary-error")).toHaveTextContent(
      /name must be at least 2 characters/i,
    );
    expect(document.getElementById("email-error")?.textContent).toMatch(
      /enter a valid email address/i,
    );
    expect(
      document.getElementById("hospitalName-error")?.textContent,
    ).toMatch(/hospital name must be at least 2 characters/i);
    expect(document.getElementById("hospitalSize-error")?.textContent).toMatch(
      /select a hospital size/i,
    );
    expect(document.getElementById("role-error")?.textContent).toMatch(
      /select your role/i,
    );
    expect(document.getElementById("message-error")?.textContent).toMatch(
      /message must be at least 10 characters/i,
    );

    // The field's error class should swap to the red variant on at least one
    // input — verifies the errClass() helper hooks up.
    const nameInput = document.getElementById("fullName") as HTMLInputElement;
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-Indian-mobile phone with an inline error and skips fetch", async () => {
    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.input(document.getElementById("phone") as HTMLInputElement, {
      target: { value: "1234" }, // too short, wrong leading digit
    });

    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(document.getElementById("phone-error")?.textContent).toMatch(
        /enter a valid indian mobile number/i,
      );
    });
    expect(screen.getByTestId("enquiry-field-summary-error")).toHaveTextContent(
      /enter a valid indian mobile number/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears a field error as soon as the user edits that field", async () => {
    render(<EnquiryForm />);

    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));
    await waitFor(() => {
      expect(document.getElementById("fullName-error")).toBeInTheDocument();
    });

    fireEvent.input(document.getElementById("fullName") as HTMLInputElement, {
      target: { value: "Dr Meera Rao" },
    });

    expect(document.getElementById("fullName-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("enquiry-field-summary-error")).toHaveTextContent(
      /enter a valid email address/i,
    );
  });

  it("rejects a malformed email with an inline error and skips fetch", async () => {
    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.input(document.getElementById("email") as HTMLInputElement, {
      target: { value: "not-an-email" },
    });

    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(document.getElementById("email-error")?.textContent).toMatch(
        /enter a valid email address/i,
      );
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the valid payload to /api/v1/marketing/enquiry and renders the success screen", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: "enq-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/v1/marketing/enquiry");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    const body = JSON.parse(init.body);
    expect(body.fullName).toBe("Dr Meera Rao");
    expect(body.email).toBe("meera@hospital.in");
    expect(body.hospitalName).toBe("Asha Hospital");
    expect(body.hospitalSize).toBe("50-200");
    expect(body.role).toBe("Doctor");

    // Success screen.
    expect(
      await screen.findByText(/thanks — we'll be in touch/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/we've received your enquiry/i),
    ).toBeInTheDocument();

    // Resetting back to idle re-renders the form.
    fireEvent.click(
      screen.getByRole("button", { name: /submit another enquiry/i }),
    );
    expect(
      screen.getByRole("button", { name: /request a demo/i }),
    ).toBeInTheDocument();
  });

  it("honors NEXT_PUBLIC_API_URL when set, hitting the override host", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com/v2";
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://api.example.com/v2/marketing/enquiry",
    );
  });

  it("maps a server 400 with structured errors[] back onto inline field errors (no generic toast)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          errors: [
            { field: "email", message: "Email already on the waitlist" },
            { field: "fullName", message: "Server says name is taken" },
          ],
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(document.getElementById("email-error")?.textContent).toMatch(
        /email already on the waitlist/i,
      );
    });
    expect(document.getElementById("fullName-error")?.textContent).toMatch(
      /server says name is taken/i,
    );
    expect(screen.getByTestId("enquiry-field-summary-error")).toHaveTextContent(
      /server says name is taken/i,
    );
    // General-error banner should NOT render — server gave structured errors.
    expect(
      screen.queryByText(/something went wrong\. please try again/i),
    ).not.toBeInTheDocument();
  });

  it("surfaces a non-400 server error response with data.error as a general-error banner", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, error: "Internal hiccup" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(screen.getByText(/internal hiccup/i)).toBeInTheDocument();
    });
  });

  it("falls back to the generic copy when the server returns non-ok with no error field", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong\. please try again/i),
      ).toBeInTheDocument();
    });
  });

  it("surfaces the network-error banner when fetch rejects", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));

    render(<EnquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: /request a demo/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/network error\. please try again/i),
      ).toBeInTheDocument();
    });
  });

  it("disables the submit button and switches its label to Sending... while a request is in-flight", async () => {
    let resolveFetch: (resp: Response) => void = () => {};
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    fetchSpy.mockReturnValueOnce(pending);

    render(<EnquiryForm />);
    fillValidForm();
    const button = screen.getByRole("button", {
      name: /request a demo/i,
    }) as HTMLButtonElement;
    fireEvent.click(button);

    // Mid-flight: label switches and button is disabled.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /sending/i }),
      ).toBeDisabled();
    });

    // Resolve, then success screen takes over.
    resolveFetch(
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/thanks — we'll be in touch/i),
      ).toBeInTheDocument();
    });
  });
});
