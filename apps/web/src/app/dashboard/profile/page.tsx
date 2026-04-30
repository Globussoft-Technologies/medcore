"use client";

/**
 * Issue #303 — self-service profile page.
 *
 * `/dashboard/profile` (and its alias `/dashboard/account`) used to 404. The
 * existing `/dashboard/settings` page covers the same ground but is bloated
 * with admin-flavoured tabs (notifications, 2FA, sessions, failed logins,
 * theme, landing page). Non-admin roles (PATIENT, NURSE, RECEPTION, …) need
 * a focused view to update their own contact details and password — without
 * being walked through tabs they don't need.
 *
 * This page reuses the same patterns as ProfileTab in settings/page.tsx
 * (api, useAuthStore, sanitizeUserInput, extractFieldErrors, toast) so the
 * server contract — `GET /auth/me`, `PATCH /auth/me`, `POST /auth/change-password`
 * — and the inline per-field error UX stay consistent.
 *
 * No role gate: every authenticated role can view + edit their own record.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { extractFieldErrors } from "@/lib/field-errors";
import { useTranslation, type Lang } from "@/lib/i18n";
import { sanitizeUserInput } from "@medcore/shared";
import { PasswordInput } from "@/components/PasswordInput";
import { KeyRound, X } from "lucide-react";

interface MeResponse {
  data: {
    id: string;
    email: string;
    name: string;
    phone: string;
    role: string;
    photoUrl?: string | null;
    preferredLanguage?: string | null;
  };
}

interface InitialSnapshot {
  name: string;
  phone: string;
  preferredLanguage: Lang;
}

export default function ProfilePage() {
  const { user, refreshUser } = useAuthStore();
  const { setLang } = useTranslation();

  // Form fields
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<Lang>("en");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");

  // Track the loaded snapshot so we can compute "dirty" without firing on
  // every keystroke during typing — Save stays disabled until the user has
  // actually changed something AND the field-level validation passes.
  const initialRef = useRef<InitialSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MeResponse>("/auth/me");
      const lang: Lang =
        res.data.preferredLanguage === "hi" ? "hi" : "en";
      setName(res.data.name ?? "");
      setPhone(res.data.phone ?? "");
      setPreferredLanguage(lang);
      setEmail(res.data.email ?? "");
      setRole(res.data.role ?? "");
      initialRef.current = {
        name: res.data.name ?? "",
        phone: res.data.phone ?? "",
        preferredLanguage: lang,
      };
    } catch (err) {
      // Don't blank the page out on a transient /me failure — the layout is
      // still useful and the user can hit "Reload" by switching routes.
      toast.error(
        err instanceof Error ? err.message : "Could not load profile"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Per the brief: PHONE_REGEX is /^\+?\d{10,15}$/ — same one the API
  // enforces and the same one ProfileTab in settings/page.tsx mirrors
  // client-side (see issue #392).
  const phoneValid = useMemo(
    () => /^\+?\d{10,15}$/.test(phone.trim()),
    [phone]
  );
  // Name validity mirrors sanitizeUserInput's contract: non-empty after
  // trim. We re-run the full sanitizer at submit time.
  const nameValid = name.trim().length > 0;
  const formValid = nameValid && phoneValid;

  const dirty = useMemo(() => {
    const init = initialRef.current;
    if (!init) return false;
    return (
      init.name !== name ||
      init.phone !== phone ||
      init.preferredLanguage !== preferredLanguage
    );
  }, [name, phone, preferredLanguage]);

  async function save() {
    setFieldErrors({});
    const errs: Record<string, string> = {};

    // Mirror the API's `updateProfileSchema` so we don't round-trip a 400.
    const nameCheck = sanitizeUserInput(name, {
      field: "Name",
      maxLength: 100,
    });
    if (!nameCheck.ok) errs.name = nameCheck.error || "Name cannot be empty";
    const trimmedPhone = phone.trim();
    if (!/^\+?\d{10,15}$/.test(trimmedPhone)) {
      errs.phone = "Phone must be 10–15 digits, optional leading +";
    }

    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      toast.warning("Please fix the highlighted fields");
      return;
    }

    // After the `errs` short-circuit above we know nameCheck.ok === true,
    // but the `SanitizeResult` shape leaves `value` typed as optional.
    const cleanedName = nameCheck.value ?? name.trim();
    setSaving(true);
    try {
      await api.patch("/auth/me", {
        name: cleanedName,
        phone: trimmedPhone,
        preferredLanguage,
      });
      // Reflect language choice in the live i18n store so the dashboard
      // chrome immediately re-renders in the chosen language without a
      // full reload.
      setLang(preferredLanguage);
      toast.success("Profile updated");
      initialRef.current = {
        name: cleanedName,
        phone: trimmedPhone,
        preferredLanguage,
      };
      await refreshUser();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setFieldErrors(fields);
        toast.error(Object.values(fields)[0] || "Save failed");
      } else {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    } finally {
      setSaving(false);
    }
  }

  const initial = (name || email || "?").trim().charAt(0).toUpperCase();
  const saveDisabled = saving || !dirty || !formValid;

  return (
    <div data-testid="profile-page">
      <h1 className="mb-6 text-2xl font-bold">My Profile</h1>

      <div className="space-y-6">
        {/* Header card */}
        <div className="flex flex-col items-start gap-4 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800 sm:flex-row sm:items-center">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/10 text-2xl font-bold text-primary"
            aria-hidden="true"
          >
            {initial}
          </div>
          <div className="flex-1">
            <p className="text-lg font-semibold" data-testid="profile-header-name">
              {name || (loading ? "Loading…" : "—")}
            </p>
            <p className="text-sm text-gray-500" data-testid="profile-header-email">
              {email || "—"}
            </p>
            {role && (
              <span
                className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                data-testid="profile-header-role"
              >
                {role}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowPasswordModal(true)}
            data-testid="profile-change-password-btn"
            className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            <KeyRound size={14} /> Change Password
          </button>
        </div>

        {/* Editable fields */}
        <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
          <h2 className="mb-4 text-lg font-semibold">Personal Details</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Full Name" required>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (fieldErrors.name)
                    setFieldErrors((p) => ({ ...p, name: "" }));
                }}
                data-testid="profile-name-input"
                aria-invalid={fieldErrors.name ? "true" : undefined}
                disabled={loading}
                className={
                  "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                  (fieldErrors.name
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-600")
                }
              />
              {fieldErrors.name && (
                <p
                  data-testid="error-profile-name"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.name}
                </p>
              )}
            </Field>

            <Field label="Email (read-only)">
              <input
                type="email"
                value={email}
                readOnly
                data-testid="profile-email-input"
                className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50"
              />
              <p className="mt-1 text-xs text-gray-500">
                Email changes require a verification flow — contact an admin
                if your address has changed.
              </p>
            </Field>

            <Field label="Phone" required>
              <input
                type="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (fieldErrors.phone)
                    setFieldErrors((p) => ({ ...p, phone: "" }));
                }}
                data-testid="profile-phone-input"
                aria-invalid={fieldErrors.phone ? "true" : undefined}
                placeholder="+919876543210"
                disabled={loading}
                className={
                  "w-full rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                  (fieldErrors.phone
                    ? "border-red-500 bg-red-50"
                    : "border-gray-300 dark:border-gray-600")
                }
              />
              {fieldErrors.phone && (
                <p
                  data-testid="error-profile-phone"
                  className="mt-1 text-xs text-red-600"
                >
                  {fieldErrors.phone}
                </p>
              )}
            </Field>

            <Field label="Preferred Language">
              <select
                value={preferredLanguage}
                onChange={(e) =>
                  setPreferredLanguage(e.target.value as Lang)
                }
                data-testid="profile-language-input"
                disabled={loading}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
              >
                <option value="en">English</option>
                <option value="hi">हिन्दी (Hindi)</option>
              </select>
            </Field>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={saveDisabled}
              data-testid="profile-save-btn"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>

      {showPasswordModal && (
        <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />
      )}
    </div>
  );
}

// ─── Change Password modal ────────────────────────────────

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Issue #394 (Apr 2026): the change-password form used to swallow the
  // specific zod refine error ("Password must be at least 8 characters",
  // "Password is too common", etc) under a generic "Validation failed"
  // toast. Surface the field-level message inline next to the input so the
  // user knows exactly what to fix.
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    if (newPassword !== confirmPassword) {
      setErrors({ newPassword: "Passwords do not match" });
      toast.error("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword,
        newPassword,
      });
      toast.success("Password changed");
      onClose();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setErrors(fields);
        toast.error(
          fields.newPassword ||
            Object.values(fields)[0] ||
            "Failed to change password"
        );
      } else {
        toast.error(
          err instanceof Error ? err.message : "Failed to change password"
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-password-title"
      data-testid="change-password-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="change-password-title" className="text-lg font-semibold">
            Change Password
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="change-password-close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Current Password">
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              data-testid="change-password-current"
              className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>

          <Field label="New Password">
            <PasswordInput
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (errors.newPassword)
                  setErrors((p) => ({ ...p, newPassword: "" }));
              }}
              required
              minLength={6}
              autoComplete="new-password"
              data-testid="change-password-new"
              aria-invalid={errors.newPassword ? "true" : undefined}
              className={
                "rounded-lg border px-3 py-2 dark:bg-gray-900 " +
                (errors.newPassword
                  ? "border-red-500 bg-red-50"
                  : "border-gray-300 dark:border-gray-600")
              }
            />
            {errors.newPassword && (
              <p
                data-testid="error-change-password-newPassword"
                className="mt-1 text-xs text-red-600"
              >
                {errors.newPassword}
              </p>
            )}
          </Field>

          <Field label="Confirm New Password">
            <PasswordInput
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
              data-testid="change-password-confirm"
              className="rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              data-testid="change-password-submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {submitting ? "Updating…" : "Update Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}
