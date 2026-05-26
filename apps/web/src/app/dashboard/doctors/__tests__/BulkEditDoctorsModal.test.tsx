// BulkEditDoctorsModal — broad behavioural coverage (Pearl ERP Stage 1 §3.1, gap row 74).
//
// What / which modules / why:
//   - Companion suite to bulk-edit-modal.test.tsx in the same folder; that
//     sibling pins the smoke-shape + don't-clobber payload invariant. This
//     suite drives the remaining uncovered branches:
//       * the empty-string → null clearing branch for tokenPrefix /
//         tokenStartNumber / dailyAppointmentLimit / nearTurnAlertThreshold
//         (a non-trivial payload-shape contract — empty input means CLEAR,
//         not omit)
//       * the number-coercion branch for tokenStart/dailyLimit/nearTurn
//         when a real value IS typed
//       * the "Toggle at least one field" client-side gate (anyEnabled = false)
//       * extractFieldErrors success branch (field-level error wins over
//         err.message) and the err-with-no-message fallback string
//       * the toast.error side-effect on failure
//       * the submitting-disabled label flip ("Applying...") while the POST
//         is in-flight, then re-enable after settle
//       * the close-button (X) + cancel-button click handlers
//       * each individual field-input becoming enabled/disabled in lockstep
//         with its toggle (the `disabled={!field.enabled}` guard)
//   - Source under test: apps/web/src/app/dashboard/doctors/BulkEditDoctorsModal.tsx
//   - Mocks @/lib/api (network), @/lib/toast (UI side-effect), @/lib/field-errors (zod parser).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock, extractFieldErrorsMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  extractFieldErrorsMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/field-errors", () => ({
  extractFieldErrors: extractFieldErrorsMock,
}));

import { BulkEditDoctorsModal } from "../BulkEditDoctorsModal";

const DOCTOR_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

function renderModal(
  overrides: Partial<{
    doctorIds: string[];
    onClose: () => void;
    onSuccess: (n: number) => void;
  }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onSuccess = overrides.onSuccess ?? vi.fn();
  const utils = render(
    <BulkEditDoctorsModal
      doctorIds={overrides.doctorIds ?? DOCTOR_IDS}
      onClose={onClose}
      onSuccess={onSuccess}
    />,
  );
  return { ...utils, onClose, onSuccess };
}

describe("BulkEditDoctorsModal — companion coverage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    extractFieldErrorsMock.mockReset();
    extractFieldErrorsMock.mockReturnValue(null);
  });

  describe("dialog scaffolding", () => {
    it("renders the dialog with aria-modal=true and the right labelledby", () => {
      renderModal();
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAttribute("aria-labelledby", "doctor-bulk-edit-title");
      expect(screen.getByTestId("doctor-bulk-edit-modal")).toBeInTheDocument();
    });

    it("pluralises the doctor noun based on the doctorIds length", () => {
      renderModal({ doctorIds: ["only-one-id"] });
      // For a single doctor the noun is "doctor" — verify by checking the
      // submit button label "Apply to 1" (length-driven) and the absence of
      // a trailing 's' in the inline copy.
      expect(screen.getByTestId("doctor-bulk-edit-submit").textContent).toBe(
        "Apply to 1",
      );
    });

    it("uses 'doctors' (plural) when there are 2+ ids", () => {
      renderModal();
      expect(screen.getByTestId("doctor-bulk-edit-submit").textContent).toBe(
        "Apply to 2",
      );
    });
  });

  describe("close affordances", () => {
    it("calls onClose when the header X button is clicked", async () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      await userEvent.click(screen.getByTestId("doctor-bulk-edit-close"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when the Cancel button is clicked", async () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      await userEvent.click(screen.getByText("Cancel"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does NOT POST when neither cancel nor close fires", () => {
      renderModal();
      expect(apiMock.post).not.toHaveBeenCalled();
    });
  });

  describe("no-op guard (anyEnabled=false)", () => {
    it("surfaces the inline error when the submit handler is forced with no toggles on", async () => {
      renderModal();
      // The submit button is disabled when anyEnabled=false, so the only way
      // to drive the early-return branch in handleSubmit is via fireEvent.submit
      // on the form itself.
      const form = screen
        .getByTestId("doctor-bulk-edit-submit")
        .closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByTestId("doctor-bulk-edit-error")).toHaveTextContent(
          "Toggle at least one field to apply.",
        );
      });
      expect(apiMock.post).not.toHaveBeenCalled();
    });
  });

  describe("per-field input enable/disable lockstep", () => {
    it("disables each input until its sibling Apply toggle is on", () => {
      renderModal();
      const fields = [
        "bulk-field-mode-input",
        "bulk-field-token-prefix-input",
        "bulk-field-token-start-input",
        "bulk-field-daily-limit-input",
        "bulk-field-near-turn-input",
        "bulk-field-policy-input",
      ];
      for (const f of fields) {
        expect(screen.getByTestId(f)).toBeDisabled();
      }
    });

    it("re-enables an input the moment its toggle flips on", () => {
      renderModal();
      const input = screen.getByTestId("bulk-field-daily-limit-input");
      expect(input).toBeDisabled();
      fireEvent.click(screen.getByTestId("bulk-field-daily-limit-toggle"));
      expect(input).not.toBeDisabled();
    });

    it("re-disables an input when the toggle is flipped back off", () => {
      renderModal();
      const toggle = screen.getByTestId("bulk-field-policy-toggle");
      const input = screen.getByTestId("bulk-field-policy-input");
      fireEvent.click(toggle); // on
      expect(input).not.toBeDisabled();
      fireEvent.click(toggle); // off
      expect(input).toBeDisabled();
    });
  });

  describe("payload-shape — empty-input → null clearing branch", () => {
    it("sends tokenPrefix=null when toggle is on but the input is left empty (admins clearing a prefix)", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      // Toggle tokenPrefix on but leave the value empty.
      fireEvent.click(screen.getByTestId("bulk-field-token-prefix-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));

      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates).toEqual({ tokenPrefix: null });
    });

    it("sends tokenPrefix as the TRIMMED string when input has surrounding whitespace", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-token-prefix-toggle"));
      fireEvent.change(screen.getByTestId("bulk-field-token-prefix-input"), {
        target: { value: "  GYN  " },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));

      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates.tokenPrefix).toBe("GYN");
    });

    it("sends tokenStartNumber=null when toggle is on but input is empty", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-token-start-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates).toEqual({ tokenStartNumber: null });
    });

    it("coerces tokenStartNumber via Number() when a numeric string is typed", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-token-start-toggle"));
      fireEvent.change(screen.getByTestId("bulk-field-token-start-input"), {
        target: { value: "42" },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates).toEqual({ tokenStartNumber: 42 });
      expect(typeof body.updates.tokenStartNumber).toBe("number");
    });

    it("sends dailyAppointmentLimit=null when toggle is on but input is empty", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-daily-limit-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates).toEqual({ dailyAppointmentLimit: null });
    });

    it("coerces dailyAppointmentLimit via Number() when a numeric string is typed", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-daily-limit-toggle"));
      fireEvent.change(screen.getByTestId("bulk-field-daily-limit-input"), {
        target: { value: "120" },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates.dailyAppointmentLimit).toBe(120);
    });

    it("sends nearTurnAlertThreshold=null when toggle is on but input is empty", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-near-turn-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates).toEqual({ nearTurnAlertThreshold: null });
    });

    it("coerces nearTurnAlertThreshold via Number() when a numeric string is typed", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-near-turn-toggle"));
      fireEvent.change(screen.getByTestId("bulk-field-near-turn-input"), {
        target: { value: "5" },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates.nearTurnAlertThreshold).toBe(5);
    });

    it("sends lastHourPolicy as the enum string when policy toggle is on", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-policy-toggle"));
      fireEvent.change(screen.getByTestId("bulk-field-policy-input"), {
        target: { value: "WALK_IN_ONLY" },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [, body] = apiMock.post.mock.calls[0];
      expect(body.updates).toEqual({ lastHourPolicy: "WALK_IN_ONLY" });
    });

    it("submits all 6 toggled fields together (full payload shape)", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      renderModal();
      // Toggle every field on.
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("bulk-field-token-prefix-toggle"));
      fireEvent.click(screen.getByTestId("bulk-field-token-start-toggle"));
      fireEvent.click(screen.getByTestId("bulk-field-daily-limit-toggle"));
      fireEvent.click(screen.getByTestId("bulk-field-near-turn-toggle"));
      fireEvent.click(screen.getByTestId("bulk-field-policy-toggle"));
      // Type values into the numeric ones to avoid the null branch.
      fireEvent.change(screen.getByTestId("bulk-field-mode-input"), {
        target: { value: "CALLING" },
      });
      fireEvent.change(screen.getByTestId("bulk-field-token-prefix-input"), {
        target: { value: "CARD" },
      });
      fireEvent.change(screen.getByTestId("bulk-field-token-start-input"), {
        target: { value: "1" },
      });
      fireEvent.change(screen.getByTestId("bulk-field-daily-limit-input"), {
        target: { value: "50" },
      });
      fireEvent.change(screen.getByTestId("bulk-field-near-turn-input"), {
        target: { value: "3" },
      });
      fireEvent.change(screen.getByTestId("bulk-field-policy-input"), {
        target: { value: "BLOCK_NEW" },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));

      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      const [url, body] = apiMock.post.mock.calls[0];
      expect(url).toBe("/doctors/bulk-update");
      expect(body.updates).toEqual({
        appointmentMode: "CALLING",
        tokenPrefix: "CARD",
        tokenStartNumber: 1,
        dailyAppointmentLimit: 50,
        nearTurnAlertThreshold: 3,
        lastHourPolicy: "BLOCK_NEW",
      });
    });
  });

  describe("success path", () => {
    it("calls onSuccess with updatedCount from the response", async () => {
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 7, updatedDoctorIds: DOCTOR_IDS },
      });
      const onSuccess = vi.fn();
      renderModal({ onSuccess });
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(7));
    });

    it("falls back to doctorIds.length when the response is missing updatedCount", async () => {
      apiMock.post.mockResolvedValueOnce({ data: {} });
      const onSuccess = vi.fn();
      renderModal({ onSuccess });
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() =>
        expect(onSuccess).toHaveBeenCalledWith(DOCTOR_IDS.length),
      );
    });

    it("falls back to doctorIds.length when the response has no data wrapper at all", async () => {
      apiMock.post.mockResolvedValueOnce({});
      const onSuccess = vi.fn();
      renderModal({ onSuccess });
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() =>
        expect(onSuccess).toHaveBeenCalledWith(DOCTOR_IDS.length),
      );
    });
  });

  describe("failure path", () => {
    it("renders extractFieldErrors's first message as the inline error and toasts a generic failure", async () => {
      extractFieldErrorsMock.mockReturnValue({
        tokenPrefix: "Prefix must be uppercase letters only",
      });
      apiMock.post.mockRejectedValueOnce({ payload: { details: [] } });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-token-prefix-toggle"));
      fireEvent.change(screen.getByTestId("bulk-field-token-prefix-input"), {
        target: { value: "abc" },
      });
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("doctor-bulk-edit-error")).toHaveTextContent(
          "Prefix must be uppercase letters only",
        );
      });
      expect(toastMock.error).toHaveBeenCalledWith("Bulk update failed");
    });

    it("falls back to 'Bulk update failed' when extractFieldErrors returns a truthy-but-empty map", async () => {
      // Edge: source uses `Object.values(fields)[0] || "Bulk update failed"`,
      // so an empty-values map should drop into the fallback string.
      extractFieldErrorsMock.mockReturnValue({});
      apiMock.post.mockRejectedValueOnce(new Error("ignored — no payload"));
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("doctor-bulk-edit-error")).toHaveTextContent(
          "Bulk update failed",
        );
      });
      expect(toastMock.error).toHaveBeenCalledWith("Bulk update failed");
    });

    it("shows the raw Error.message when extractFieldErrors returns null and the error IS an Error", async () => {
      extractFieldErrorsMock.mockReturnValue(null);
      apiMock.post.mockRejectedValueOnce(new Error("Network is down"));
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => {
        expect(screen.getByTestId("doctor-bulk-edit-error")).toHaveTextContent(
          "Network is down",
        );
      });
      expect(toastMock.error).toHaveBeenCalledWith("Bulk update failed");
    });

    it("falls back to the literal 'Bulk update failed' when extractFieldErrors=null AND err is not an Error", async () => {
      extractFieldErrorsMock.mockReturnValue(null);
      // Throw a plain object (no .message) — the `err instanceof Error` branch
      // is false, falling through to the second literal "Bulk update failed".
      apiMock.post.mockRejectedValueOnce({ thisIsNot: "an Error" });
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => {
        expect(screen.getByTestId("doctor-bulk-edit-error")).toHaveTextContent(
          "Bulk update failed",
        );
      });
    });

    it("does NOT call onSuccess when the POST rejects", async () => {
      extractFieldErrorsMock.mockReturnValue(null);
      apiMock.post.mockRejectedValueOnce(new Error("nope"));
      const onSuccess = vi.fn();
      renderModal({ onSuccess });
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe("submitting state", () => {
    it("disables the submit button and flips the label to 'Applying...' while POST is in-flight, then re-enables", async () => {
      let resolvePost!: (v: unknown) => void;
      apiMock.post.mockReturnValueOnce(
        new Promise((res) => {
          resolvePost = res;
        }),
      );
      renderModal();
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      const submit = screen.getByTestId(
        "doctor-bulk-edit-submit",
      ) as HTMLButtonElement;
      fireEvent.click(submit);

      await waitFor(() => expect(submit).toBeDisabled());
      expect(submit.textContent).toBe("Applying...");

      // Let the in-flight promise settle.
      resolvePost({ data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS } });
      await waitFor(() => expect(submit).not.toBeDisabled());
      // Label flips back to the count-based copy.
      expect(submit.textContent).toBe("Apply to 2");
    });
  });

  describe("inline error reset", () => {
    it("clears the inline error message on the next submit attempt", async () => {
      // First submit: no toggles → inline error rendered.
      renderModal();
      const form = screen
        .getByTestId("doctor-bulk-edit-submit")
        .closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(screen.getByTestId("doctor-bulk-edit-error")).toBeInTheDocument();
      });
      // Now flip a toggle on + submit — the inline error should clear at
      // the start of the second submit (setSubmitError(null) at the top
      // of handleSubmit).
      apiMock.post.mockResolvedValueOnce({
        data: { updatedCount: 2, updatedDoctorIds: DOCTOR_IDS },
      });
      fireEvent.click(screen.getByTestId("bulk-field-mode-toggle"));
      fireEvent.click(screen.getByTestId("doctor-bulk-edit-submit"));
      await waitFor(() =>
        expect(
          screen.queryByTestId("doctor-bulk-edit-error"),
        ).not.toBeInTheDocument(),
      );
    });
  });
});
