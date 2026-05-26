// Coverage tests for the AI Letters dashboard page (colocated).
// Modules under test: apps/web/src/app/dashboard/ai-letters/page.tsx —
//   two-tab page (Referral, Discharge) that posts to /ai/letters/referral
//   or /ai/letters/discharge with picker-supplied IDs + form values, then
//   renders a LetterPreview with copy + print actions.
// Why: existing non-colocated spec at dashboard/__tests__/ai-letters.page.test.tsx
//   covers smoke + happy-path referral. This colocated spec closes the
//   remaining gaps — the Discharge tab generate flow (handleGenerate +
//   render path), the LetterPreview copy/print branches (handleCopy
//   success + failure, handlePrint with + without win.open() returning
//   null), the referral envelope error branch, and the rejection
//   non-Error fallback — bringing the file to ≥97% line coverage so
//   future refactors can't silently regress the surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock } = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

// Stub EntityPicker so we control the picked id directly via a plain input.
// The real picker hits the network — undesirable in a unit test.
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ onChange, testIdPrefix, value }: any) => (
    <input
      data-testid={`${testIdPrefix ?? "picker"}-stub`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import AILettersPage from "../page";

describe("AILettersPage — colocated coverage for gap branches", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  // ── Form-input coverage on the referral tab ───────────────────────────────

  it("updates referral form inputs (specialty select, doctor name, urgency) and threads them into the POST body", async () => {
    apiMock.post.mockResolvedValue({
      success: true,
      data: { letter: "Letter body", generatedAt: new Date().toISOString() },
      error: null,
    });
    const user = userEvent.setup();
    render(<AILettersPage />);

    const stub = screen.getByTestId(
      "ai-letters-scribe-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "scribe-99");

    // Change specialty.
    const specialty = screen.getByTestId(
      "ai-letters-specialty",
    ) as HTMLSelectElement;
    fireEvent.change(specialty, { target: { value: "Neurologist" } });
    expect(specialty.value).toBe("Neurologist");

    // Fill optional doctor name.
    const docName = screen.getByLabelText(/to doctor name/i) as HTMLInputElement;
    await user.type(docName, "Dr. Priya Sharma");

    // Switch urgency.
    const urgency = screen.getByLabelText(/urgency/i) as HTMLSelectElement;
    fireEvent.change(urgency, { target: { value: "URGENT" } });
    expect(urgency.value).toBe("URGENT");

    await user.click(screen.getByTestId("ai-letters-generate-referral"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith("/ai/letters/referral", {
      scribeSessionId: "scribe-99",
      toSpecialty: "Neurologist",
      toDoctorName: "Dr. Priya Sharma",
      urgency: "URGENT",
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/referral letter generated/i),
    );
  });

  // ── Referral error envelope + non-Error rejection ─────────────────────────

  it("toasts the API envelope error when /ai/letters/referral returns success:false", async () => {
    apiMock.post.mockResolvedValue({
      success: false,
      data: null,
      error: "Scribe session not finalised",
    });
    const user = userEvent.setup();
    render(<AILettersPage />);

    const stub = screen.getByTestId(
      "ai-letters-scribe-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "scribe-bad");
    await user.click(screen.getByTestId("ai-letters-generate-referral"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Scribe session not finalised",
      ),
    );
  });

  it("falls back to the generic referral error copy when the envelope has neither data nor error", async () => {
    apiMock.post.mockResolvedValue({ success: false, data: null, error: null });
    const user = userEvent.setup();
    render(<AILettersPage />);

    const stub = screen.getByTestId(
      "ai-letters-scribe-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "scribe-x");
    await user.click(screen.getByTestId("ai-letters-generate-referral"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed to generate letter/i),
      ),
    );
  });

  it("falls back to the generic referral error copy when the rejection has no message", async () => {
    apiMock.post.mockRejectedValue({});
    const user = userEvent.setup();
    render(<AILettersPage />);

    const stub = screen.getByTestId(
      "ai-letters-scribe-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "scribe-x");
    await user.click(screen.getByTestId("ai-letters-generate-referral"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed to generate letter/i),
      ),
    );
  });

  // ── Discharge tab — the gap left by the non-colocated spec ─────────────────

  it("toasts a guard error when Generate Summary is clicked with no admission picked", async () => {
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    await user.click(screen.getByTestId("ai-letters-generate-discharge"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/pick an admission/i),
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("posts /ai/letters/discharge on a happy-path Generate Summary and renders the preview", async () => {
    apiMock.post.mockResolvedValue({
      success: true,
      data: {
        summary: "## Discharge Summary\n\nPatient discharged in stable condition.",
        generatedAt: "2026-05-26T10:00:00Z",
      },
      error: null,
    });
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));

    const stub = screen.getByTestId(
      "ai-letters-admission-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "adm-123");

    await user.click(screen.getByTestId("ai-letters-generate-discharge"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith("/ai/letters/discharge", {
      admissionId: "adm-123",
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/discharge summary generated/i),
    );
    // stripMarkdown removed the leading "## " surrounding markdown markers.
    expect(
      await screen.findByText(/Patient discharged in stable condition/i),
    ).toBeInTheDocument();
  });

  it("toasts the discharge envelope error when /ai/letters/discharge returns success:false", async () => {
    apiMock.post.mockResolvedValue({
      success: false,
      data: null,
      error: "Admission has no diagnosis",
    });
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    const stub = screen.getByTestId(
      "ai-letters-admission-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "adm-bad");
    await user.click(screen.getByTestId("ai-letters-generate-discharge"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Admission has no diagnosis"),
    );
  });

  it("falls back to the generic discharge error copy when the envelope has neither data nor error", async () => {
    apiMock.post.mockResolvedValue({ success: false, data: null, error: null });
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    const stub = screen.getByTestId(
      "ai-letters-admission-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "adm-y");
    await user.click(screen.getByTestId("ai-letters-generate-discharge"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed to generate summary/i),
      ),
    );
  });

  it("toasts the thrown Error message when /ai/letters/discharge rejects", async () => {
    apiMock.post.mockRejectedValue(new Error("AI service unavailable"));
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    const stub = screen.getByTestId(
      "ai-letters-admission-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "adm-fail");
    await user.click(screen.getByTestId("ai-letters-generate-discharge"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("AI service unavailable"),
    );
  });

  it("falls back to the generic discharge error copy when rejection has no message", async () => {
    apiMock.post.mockRejectedValue({});
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    const stub = screen.getByTestId(
      "ai-letters-admission-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "adm-z");
    await user.click(screen.getByTestId("ai-letters-generate-discharge"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/failed to generate summary/i),
      ),
    );
  });

  it("disables the discharge Generate button while POST is in flight", async () => {
    apiMock.post.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<AILettersPage />);

    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    const stub = screen.getByTestId(
      "ai-letters-admission-picker-stub",
    ) as HTMLInputElement;
    await user.type(stub, "adm-pending");
    const btn = screen.getByTestId("ai-letters-generate-discharge");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    // Loading copy surfaces.
    expect(screen.getByText(/generating\.\.\./i)).toBeInTheDocument();
  });

  // ── LetterPreview surface — copy + print branches ─────────────────────────

  describe("LetterPreview action buttons", () => {
    let originalClipboard: any;
    let originalOpen: any;

    beforeEach(() => {
      originalClipboard = (navigator as any).clipboard;
      originalOpen = window.open;
    });
    afterEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
      window.open = originalOpen;
    });

    async function renderWithReferralResult() {
      apiMock.post.mockResolvedValue({
        success: true,
        data: {
          letter: "**Dear Dr.**\n\n---\nReferral body.\n\n\n\nEnd.",
          generatedAt: "2026-05-26T12:00:00Z",
        },
        error: null,
      });
      // Use fireEvent throughout this block — userEvent.setup() installs its
      // own clipboard layer that hijacks navigator.clipboard.writeText, which
      // breaks the assertions on the spy we install on navigator.clipboard.
      render(<AILettersPage />);
      const stub = screen.getByTestId(
        "ai-letters-scribe-picker-stub",
      ) as HTMLInputElement;
      fireEvent.change(stub, { target: { value: "scribe-preview" } });
      fireEvent.click(screen.getByTestId("ai-letters-generate-referral"));
      await screen.findByTestId("ai-letters-copy");
    }

    it("Copy button writes the markdown-stripped letter to the clipboard and toasts success", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
        writable: true,
      });

      await renderWithReferralResult();
      // Use raw fireEvent.click so userEvent's own clipboard layer doesn't
      // intercept navigator.clipboard.writeText.
      fireEvent.click(screen.getByTestId("ai-letters-copy"));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const payload = writeText.mock.calls[0][0] as string;
      // stripMarkdown removed the ** markers and the --- separator.
      expect(payload).not.toContain("**");
      expect(payload).not.toContain("---");
      expect(payload).toContain("Dear Dr.");
      expect(payload).toContain("Referral body.");
      // Multi-blank-line collapse.
      expect(payload).not.toMatch(/\n{3,}/);
      await waitFor(() =>
        expect(toastMock.success).toHaveBeenCalledWith(
          expect.stringMatching(/copied to clipboard/i),
        ),
      );
    });

    it("Copy button toasts a failure message when clipboard.writeText rejects", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
        writable: true,
      });

      await renderWithReferralResult();
      fireEvent.click(screen.getByTestId("ai-letters-copy"));

      await waitFor(() =>
        expect(toastMock.error).toHaveBeenCalledWith(
          expect.stringMatching(/failed to copy/i),
        ),
      );
    });

    it("Print button opens a new window, writes the print HTML, and calls focus/print/close", async () => {
      const winMock = {
        document: { write: vi.fn(), close: vi.fn() },
        focus: vi.fn(),
        print: vi.fn(),
        close: vi.fn(),
      };
      window.open = vi.fn().mockReturnValue(winMock) as any;

      await renderWithReferralResult();
      fireEvent.click(screen.getByTestId("ai-letters-print"));

      expect(window.open).toHaveBeenCalledWith(
        "",
        "_blank",
        expect.stringContaining("width=800"),
      );
      expect(winMock.document.write).toHaveBeenCalledTimes(1);
      // HTML escaping in the print template.
      const html = winMock.document.write.mock.calls[0][0] as string;
      expect(html).toContain("<title>Letter</title>");
      expect(html).toContain("Dear Dr.");
      expect(winMock.document.close).toHaveBeenCalled();
      expect(winMock.focus).toHaveBeenCalled();
      expect(winMock.print).toHaveBeenCalled();
      expect(winMock.close).toHaveBeenCalled();
    });

    it("Print button no-ops when window.open returns null (popup blocked)", async () => {
      window.open = vi.fn().mockReturnValue(null) as any;

      await renderWithReferralResult();
      fireEvent.click(screen.getByTestId("ai-letters-print"));

      expect(window.open).toHaveBeenCalled();
      // No throw, no toast. The early-return branch is exercised.
      expect(toastMock.error).not.toHaveBeenCalled();
    });
  });
});
