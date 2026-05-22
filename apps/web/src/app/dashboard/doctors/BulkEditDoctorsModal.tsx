"use client";

// Pearl ERP Stage 1 §3.1 (gap row 74) — bulk-edit dialog for admins.
//
// What this component does:
//   - Renders a modal listing the 6 appointment-mode knobs from
//     AppointmentModeCard (`fd58688`) with a per-field "Apply" toggle.
//   - Submit POSTs ONLY the toggled-on fields to /doctors/bulk-update,
//     so untouched fields are never accidentally clobbered (the bulk API
//     is partial-update — omitted keys are left alone).
//   - On success, calls `onSuccess(updatedCount)` so the parent page can
//     show a toast, refresh, and clear the row selection.
//
// Why a per-field toggle:
//   The natural mistake here is "fill the form, hit save" and accidentally
//   blank out every doctor's lastHourPolicy because the dropdown was left
//   on "—". The toggle makes intent explicit: each field is opt-in, not
//   opt-out. Pairs well with the API allowlist (`.strict()`) — a field
//   that isn't in the submitted payload won't be touched server-side.
//
// Backend contract: POST /api/v1/doctors/bulk-update
//   body: { doctorIds: string[], updates: <subset of 6 mode knobs> }
//   response: { success, data: { updatedCount, updatedDoctorIds, updates } }

import { useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { extractFieldErrors } from "@/lib/field-errors";

type AppointmentMode = "CALLING" | "TOKEN" | "SLOT";
type LastHourPolicy = "ACCEPT_ALL" | "BLOCK_NEW" | "WALK_IN_ONLY";

export interface BulkEditDoctorsModalProps {
  doctorIds: string[];
  onClose: () => void;
  onSuccess: (updatedCount: number) => void;
}

interface FieldState<T> {
  enabled: boolean;
  value: T;
}

export function BulkEditDoctorsModal({
  doctorIds,
  onClose,
  onSuccess,
}: BulkEditDoctorsModalProps) {
  // Each field carries its own enabled flag — only enabled fields make it
  // into the submitted payload. Defaults match the per-row form defaults
  // in AppointmentModeCard so admins toggling on a field aren't surprised.
  const [mode, setMode] = useState<FieldState<AppointmentMode>>({
    enabled: false,
    value: "TOKEN",
  });
  const [tokenPrefix, setTokenPrefix] = useState<FieldState<string>>({
    enabled: false,
    value: "",
  });
  const [tokenStart, setTokenStart] = useState<FieldState<string>>({
    enabled: false,
    value: "",
  });
  const [dailyLimit, setDailyLimit] = useState<FieldState<string>>({
    enabled: false,
    value: "",
  });
  const [nearTurn, setNearTurn] = useState<FieldState<string>>({
    enabled: false,
    value: "",
  });
  const [policy, setPolicy] = useState<FieldState<LastHourPolicy>>({
    enabled: false,
    value: "ACCEPT_ALL",
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const anyEnabled =
    mode.enabled ||
    tokenPrefix.enabled ||
    tokenStart.enabled ||
    dailyLimit.enabled ||
    nearTurn.enabled ||
    policy.enabled;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!anyEnabled) {
      setSubmitError("Toggle at least one field to apply.");
      return;
    }
    const updates: Record<string, unknown> = {};
    if (mode.enabled) updates.appointmentMode = mode.value;
    // Token prefix: empty string => explicit null (clear). Allows admins
    // to bulk-CLEAR an existing prefix.
    if (tokenPrefix.enabled)
      updates.tokenPrefix =
        tokenPrefix.value.trim() === "" ? null : tokenPrefix.value.trim();
    if (tokenStart.enabled)
      updates.tokenStartNumber =
        tokenStart.value.trim() === "" ? null : Number(tokenStart.value);
    if (dailyLimit.enabled)
      updates.dailyAppointmentLimit =
        dailyLimit.value.trim() === "" ? null : Number(dailyLimit.value);
    if (nearTurn.enabled)
      updates.nearTurnAlertThreshold =
        nearTurn.value.trim() === "" ? null : Number(nearTurn.value);
    if (policy.enabled) updates.lastHourPolicy = policy.value;

    setSubmitting(true);
    try {
      const res = await api.post<{
        data: { updatedCount: number; updatedDoctorIds: string[] };
      }>(`/doctors/bulk-update`, { doctorIds, updates });
      onSuccess(res.data?.updatedCount ?? doctorIds.length);
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setSubmitError(Object.values(fields)[0] || "Bulk update failed");
      } else {
        setSubmitError(err instanceof Error ? err.message : "Bulk update failed");
      }
      toast.error("Bulk update failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="doctor-bulk-edit-title"
      data-testid="doctor-bulk-edit-modal"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2
              id="doctor-bulk-edit-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              Bulk edit appointment mode
            </h2>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
              Applying to{" "}
              <span
                className="font-medium text-gray-900 dark:text-gray-100"
                data-testid="doctor-bulk-edit-count"
              >
                {doctorIds.length}
              </span>{" "}
              doctor{doctorIds.length === 1 ? "" : "s"}. Toggle each field you
              want to apply — untoggled fields stay unchanged.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="doctor-bulk-edit-close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <FieldRow
            label="Appointment mode"
            testId="bulk-field-mode"
            enabled={mode.enabled}
            onToggle={(v) => setMode((s) => ({ ...s, enabled: v }))}
          >
            <select
              value={mode.value}
              onChange={(e) =>
                setMode((s) => ({ ...s, value: e.target.value as AppointmentMode }))
              }
              disabled={!mode.enabled}
              data-testid="bulk-field-mode-input"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="CALLING">Calling (arrival-order queue)</option>
              <option value="TOKEN">Token (sequential numbers)</option>
              <option value="SLOT">Slot (fixed appointment times)</option>
            </select>
          </FieldRow>

          <FieldRow
            label="Token prefix"
            testId="bulk-field-token-prefix"
            enabled={tokenPrefix.enabled}
            onToggle={(v) => setTokenPrefix((s) => ({ ...s, enabled: v }))}
          >
            <input
              type="text"
              maxLength={8}
              placeholder="(empty = clear)"
              value={tokenPrefix.value}
              onChange={(e) =>
                setTokenPrefix((s) => ({ ...s, value: e.target.value }))
              }
              disabled={!tokenPrefix.enabled}
              data-testid="bulk-field-token-prefix-input"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </FieldRow>

          <FieldRow
            label="Token start number"
            testId="bulk-field-token-start"
            enabled={tokenStart.enabled}
            onToggle={(v) => setTokenStart((s) => ({ ...s, enabled: v }))}
          >
            <input
              type="number"
              min={1}
              max={99999}
              placeholder="(empty = clear)"
              value={tokenStart.value}
              onChange={(e) =>
                setTokenStart((s) => ({ ...s, value: e.target.value }))
              }
              disabled={!tokenStart.enabled}
              data-testid="bulk-field-token-start-input"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </FieldRow>

          <FieldRow
            label="Daily appointment limit"
            testId="bulk-field-daily-limit"
            enabled={dailyLimit.enabled}
            onToggle={(v) => setDailyLimit((s) => ({ ...s, enabled: v }))}
          >
            <input
              type="number"
              min={1}
              max={500}
              placeholder="(empty = clear)"
              value={dailyLimit.value}
              onChange={(e) =>
                setDailyLimit((s) => ({ ...s, value: e.target.value }))
              }
              disabled={!dailyLimit.enabled}
              data-testid="bulk-field-daily-limit-input"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </FieldRow>

          <FieldRow
            label="Near-turn alert (patients away)"
            testId="bulk-field-near-turn"
            enabled={nearTurn.enabled}
            onToggle={(v) => setNearTurn((s) => ({ ...s, enabled: v }))}
          >
            <input
              type="number"
              min={1}
              max={50}
              placeholder="(empty = clear)"
              value={nearTurn.value}
              onChange={(e) =>
                setNearTurn((s) => ({ ...s, value: e.target.value }))
              }
              disabled={!nearTurn.enabled}
              data-testid="bulk-field-near-turn-input"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </FieldRow>

          <FieldRow
            label="Last-hour policy"
            testId="bulk-field-policy"
            enabled={policy.enabled}
            onToggle={(v) => setPolicy((s) => ({ ...s, enabled: v }))}
          >
            <select
              value={policy.value}
              onChange={(e) =>
                setPolicy((s) => ({ ...s, value: e.target.value as LastHourPolicy }))
              }
              disabled={!policy.enabled}
              data-testid="bulk-field-policy-input"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="ACCEPT_ALL">Accept all bookings</option>
              <option value="BLOCK_NEW">Block new bookings</option>
              <option value="WALK_IN_ONLY">Walk-ins only</option>
            </select>
          </FieldRow>

          {submitError && (
            <p
              role="alert"
              data-testid="doctor-bulk-edit-error"
              className="text-sm text-red-600"
            >
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !anyEnabled}
              data-testid="doctor-bulk-edit-submit"
              className="min-h-[44px] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {submitting ? "Applying..." : `Apply to ${doctorIds.length}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Internal helper — renders a label + per-field "Apply" toggle + the
// child input. 44px touch targets on the toggle so mobile users can hit
// the right checkbox. Exported only via the parent.
function FieldRow({
  label,
  testId,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  testId: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto,1fr] items-center gap-3">
      <label
        className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200"
        data-testid={`${testId}-label`}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          data-testid={`${testId}-toggle`}
          aria-label={`Apply ${label} to selected doctors`}
          className="h-5 w-5"
        />
        <span className="whitespace-nowrap">Apply</span>
      </label>
      <div>
        <div className="mb-1 text-xs font-medium uppercase text-gray-500">
          {label}
        </div>
        {children}
      </div>
    </div>
  );
}
