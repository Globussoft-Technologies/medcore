"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useTranslation } from "@/lib/i18n";

// Shape of the patient fields the modal reads/writes. Loose here because the
// detail page's PatientDetail interface varies slightly across tabs.
export interface EditablePatient {
  id: string;
  mrNumber: string;
  gender: string | null;
  // Accept Date too — the merged-after-save payload sometimes lands as a
  // Date instance, see isoDateInput() comment for the full story.
  dateOfBirth?: string | Date | null;
  bloodGroup: string | null;
  address: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  user: { name: string; email: string | null; phone: string | null };
}

export interface PatientEditModalProps {
  open: boolean;
  patient: EditablePatient;
  onClose: () => void;
  onSaved: (updated: unknown) => void;
}

const BLOOD_GROUPS = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
] as const;

/**
 * Coerce whatever `dateOfBirth` shape we got (string from JSON, Date object
 * from a stale cache, or null) into the `YYYY-MM-DD` string the
 * `<input type="date">` element requires.
 *
 * Issue #85: the original implementation only handled strings — when the
 * parent merged the patched record back into local state the field could
 * arrive as a Date instance (or a full ISO timestamp like
 * `2024-05-12T00:00:00.000Z` whose `.toISOString()` would then be passed
 * verbatim, and `<input type="date" value="2024-05-12T00:00:00.000Z">` is
 * silently rejected by the browser, blanking the field). We now normalise
 * via UTC date-parts to dodge IST-vs-UTC midnight slippage and accept
 * both shapes.
 */
function isoDateInput(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  // Accept either a full ISO timestamp or a YYYY-MM-DD string.
  const trimmed = s.length >= 10 ? s.slice(0, 10) : s;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

/**
 * PatientEditModal — role-gated demographics editor used from the patient
 * detail page (Issue #39). Exposes stable test hooks:
 *   data-testid="patient-edit-modal"
 *   data-testid="patient-edit-save"
 *   data-testid="patient-edit-cancel"
 *   data-testid="patient-edit-mrNumber" (read-only)
 *   data-testid="patient-edit-field-<name>" on each form input
 */
export function PatientEditModal({
  open,
  patient,
  onClose,
  onSaved,
}: PatientEditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(patient.user?.name ?? "");
  const [phone, setPhone] = useState(patient.user?.phone ?? "");
  // Issue #331 (Apr 2026): walk-in registration writes a synthetic
  // placeholder email (`noemail+<MR>@medcore.invalid`) when reception
  // doesn't capture one, because `User.email` is `@unique` + non-null in
  // the schema and we can't store NULL. Detect the placeholder pattern
  // here and present the field as empty so the receptionist isn't fooled
  // into thinking she previously typed an email — which was the
  // original symptom of the bug. Also legacy `patient_<n>@medcore.local`
  // rows seeded before this fix should be hidden the same way so old
  // records don't confuse anyone.
  const isPlaceholderEmail = (e: string | null | undefined): boolean => {
    if (!e) return false;
    return (
      /^noemail\+[^@]+@medcore\.invalid$/i.test(e) ||
      /^patient_\d+@medcore\.local$/i.test(e)
    );
  };
  const initialEmail = patient.user?.email ?? "";
  const [email, setEmail] = useState(
    isPlaceholderEmail(initialEmail) ? "" : initialEmail
  );
  const [dob, setDob] = useState(isoDateInput(patient.dateOfBirth));
  const [gender, setGender] = useState<string>(patient.gender ?? "MALE");
  const [bloodGroup, setBloodGroup] = useState<string>(patient.bloodGroup ?? "");
  const [address, setAddress] = useState(patient.address ?? "");
  const [emergencyContactName, setEmergencyName] = useState(
    patient.emergencyContactName ?? ""
  );
  const [emergencyContactPhone, setEmergencyPhone] = useState(
    patient.emergencyContactPhone ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Reset local state whenever the modal re-opens with a possibly different
  // patient (e.g. the user switched records without unmounting the modal).
  useEffect(() => {
    if (!open) return;
    setName(patient.user?.name ?? "");
    setPhone(patient.user?.phone ?? "");
    setEmail(patient.user?.email ?? "");
    setDob(isoDateInput(patient.dateOfBirth));
    setGender(patient.gender ?? "MALE");
    setBloodGroup(patient.bloodGroup ?? "");
    setAddress(patient.address ?? "");
    setEmergencyName(patient.emergencyContactName ?? "");
    setEmergencyPhone(patient.emergencyContactPhone ?? "");
    setErr(null);
    const id = requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, patient]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const valid = useMemo(() => {
    return name.trim().length >= 2 && phone.trim().length >= 10;
  }, [name, phone]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid) {
      if (name.trim().length < 2) {
        setErr(t("patient.edit.name.required"));
        return;
      }
      setErr(t("patient.edit.phone.required"));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        phone: phone.trim(),
        gender,
      };
      const trimmedEmail = email.trim();
      if (trimmedEmail) payload.email = trimmedEmail;
      if (dob) payload.dateOfBirth = dob;
      if (address.trim()) payload.address = address.trim();
      if (bloodGroup) payload.bloodGroup = bloodGroup;
      if (emergencyContactName.trim())
        payload.emergencyContactName = emergencyContactName.trim();
      if (emergencyContactPhone.trim())
        payload.emergencyContactPhone = emergencyContactPhone.trim();

      const res = await api.patch<{ data: unknown }>(
        `/patients/${patient.id}`,
        payload
      );
      toast.success(t("patient.edit.success"));
      onSaved(res.data);
      onClose();
    } catch (e) {
      const msg = (e as Error).message || t("patient.edit.error");
      setErr(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="patient-edit-title"
      data-testid="patient-edit-modal"
      onClick={onClose}
    >
      <form
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 id="patient-edit-title" className="font-semibold">
            {t("patient.edit.title")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("patient.edit.cancel")}
            className="text-gray-400 hover:text-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[75vh] space-y-3 overflow-y-auto p-5">
          {/* MR Number — read only */}
          <div>
            <label htmlFor="patient-edit-mr-number" className="text-xs text-gray-600">
              {t("patient.edit.mrNumber")}
            </label>
            <input
              id="patient-edit-mr-number"
              type="text"
              readOnly
              value={patient.mrNumber}
              aria-readonly="true"
              data-testid="patient-edit-mrNumber"
              className="w-full cursor-not-allowed rounded-md border bg-gray-50 px-3 py-2 font-mono text-sm text-gray-600"
            />
            <p className="mt-1 text-xs text-gray-400">
              {t("patient.edit.mrNumber.hint")}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="patient-edit-name" className="text-xs text-gray-600">
                {t("patient.edit.name")} *
              </label>
              <input
                id="patient-edit-name"
                ref={firstFieldRef}
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="patient-edit-field-name"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="patient-edit-dob" className="text-xs text-gray-600">
                {t("patient.edit.dateOfBirth")}
              </label>
              <input
                id="patient-edit-dob"
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                data-testid="patient-edit-field-dateOfBirth"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="patient-edit-gender" className="text-xs text-gray-600">
                {t("patient.edit.gender")}
              </label>
              <select
                id="patient-edit-gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                data-testid="patient-edit-field-gender"
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="MALE">{t("patient.edit.gender.male")}</option>
                <option value="FEMALE">
                  {t("patient.edit.gender.female")}
                </option>
                <option value="OTHER">{t("patient.edit.gender.other")}</option>
              </select>
            </div>
            <div>
              <label htmlFor="patient-edit-blood-group" className="text-xs text-gray-600">
                {t("patient.edit.bloodGroup")}
              </label>
              <select
                id="patient-edit-blood-group"
                value={bloodGroup}
                onChange={(e) => setBloodGroup(e.target.value)}
                data-testid="patient-edit-field-bloodGroup"
                className="w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">{t("patient.edit.bloodGroup.none")}</option>
                {BLOOD_GROUPS.map((bg) => (
                  <option key={bg} value={bg}>
                    {bg}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="patient-edit-phone" className="text-xs text-gray-600">
                {t("patient.edit.phone")} *
              </label>
              <input
                id="patient-edit-phone"
                type="tel"
                required
                minLength={10}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                data-testid="patient-edit-field-phone"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="patient-edit-email" className="text-xs text-gray-600">
                {t("patient.edit.email")}
              </label>
              <input
                id="patient-edit-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="patient-edit-field-email"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="patient-edit-address" className="text-xs text-gray-600">
              {t("patient.edit.address")}
            </label>
            <textarea
              id="patient-edit-address"
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="patient-edit-field-address"
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="patient-edit-emergency-contact-name" className="text-xs text-gray-600">
                {t("patient.edit.emergencyContact")}
              </label>
              <input
                id="patient-edit-emergency-contact-name"
                type="text"
                value={emergencyContactName}
                onChange={(e) => setEmergencyName(e.target.value)}
                data-testid="patient-edit-field-emergencyContactName"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="patient-edit-emergency-contact-phone" className="text-xs text-gray-600">
                {t("patient.edit.emergencyPhone")}
              </label>
              <input
                id="patient-edit-emergency-contact-phone"
                type="tel"
                value={emergencyContactPhone}
                onChange={(e) => setEmergencyPhone(e.target.value)}
                data-testid="patient-edit-field-emergencyContactPhone"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
          </div>

          {err && (
            <p
              className="text-sm text-red-600"
              role="alert"
              data-testid="patient-edit-error"
            >
              {err}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            data-testid="patient-edit-cancel"
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            {t("patient.edit.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving || !valid}
            data-testid="patient-edit-save"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? t("patient.edit.saving") : t("patient.edit.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
