"use client";

// Patient PWA — My Profile (Pearl §6.1 — gap #5 piece 3e of 4).
//
// Single-form page that lets the authed PATIENT keep their record current
// so reminders + bills + cashless flows reach the right person. Pearl SOW
// §6.1 lists: name, DOB, phone, address, language preference, reminder
// opt-in, ABHA linking, photo upload.
//
// Field map → write surface:
//   • Personal
//       - name             → PATCH /api/v1/auth/me        (User.name)
//       - dateOfBirth      → PATCH /api/v1/patients/me    (Patient.dateOfBirth)
//       - phone            → READ-ONLY display (phone changes require OTP
//                            re-verify per the Pearl spec; route to
//                            reception). The web form makes this obvious
//                            with an inline hint, NOT a disabled-looking
//                            input that lets the user pretend to edit.
//       - gender           → READ-ONLY display when set. Clinical field
//                            adjusted by staff only.
//   • Address (single free-text line because Patient.address is one column)
//       - address          → PATCH /api/v1/patients/me    (Patient.address)
//   • Preferences
//       - preferredLanguage → PATCH /api/v1/auth/me       (User.preferredLanguage)
//                             AND PATCH /api/v1/patients/me (Patient.preferredLanguage)
//                             — both columns exist; the AI scribe /
//                             adherence scheduler read from Patient row,
//                             the LanguageDropdown reads from User row.
//                             We update both in one form gesture so the
//                             two stay in lockstep without forcing the
//                             user to navigate to two surfaces.
//       - notification channels (WHATSAPP / SMS / EMAIL / PUSH)
//                          → PUT /api/v1/notifications/preferences
//                             (replaces the multi-channel array; the
//                             server's existing handler upserts each row).
//   • Health ID
//       - abhaId           → PATCH /api/v1/patients/me    (Patient.abhaId)
//       - "Link ABHA" CTA  → placeholder link → /patient/profile/link-abha
//                             (full ABDM linking flow lives in a future
//                             piece; for today the patient can paste an
//                             existing id by hand)
//
// Scope-cut for this tick (documented in gap-row 6.1):
//   • Photo upload — needs the presigned-URL + S3-compat pipeline that
//     does NOT exist for the patient surface today. Deferred to piece 3e-ii.
//   • ABHA-link wire-up — the ABDM routes exist (`routes/abdm.ts`) but
//     the first-login auto-link hook is a separate piece. CTA is a
//     placeholder link.
//
// Page-shape conventions copied wholesale from piece 3d (bills):
//   • Loading / unauth / error / ready state machine
//   • Mobile-first, 44px touch targets on every CTA
//   • testids prefixed `patient-profile-*` so the smoke tests (and any
//     future Playwright spec) can lock on without name-collision risk

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

interface PatientInfo {
  id?: string;
  dateOfBirth?: string | null;
  address?: string | null;
  gender?: string | null;
  preferredLanguage?: string | null;
  abhaId?: string | null;
}

interface MeResponse {
  success: boolean;
  data: {
    id: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    role?: string | null;
    preferredLanguage?: string | null;
    photoUrl?: string | null;
    patient?: PatientInfo | null;
  } | null;
  error?: string | null;
}

type NotificationChannel = "WHATSAPP" | "SMS" | "EMAIL" | "PUSH";

interface NotificationPrefRow {
  channel: NotificationChannel;
  enabled: boolean;
}

interface NotificationPrefsResponse {
  success: boolean;
  data: NotificationPrefRow[] | null;
  error?: string | null;
}

type LoadState = "loading" | "ready" | "unauth" | "error";
type SubmitState = "idle" | "saving" | "saved" | "error";

const CHANNELS: NotificationChannel[] = ["WHATSAPP", "SMS", "EMAIL", "PUSH"];
const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
  PUSH: "Push notifications",
};

// Languages surfaced in the dropdown. Mirrors the AI scribe / adherence
// scheduler's "hi | en" detection at services/adherence-scheduler.ts:65
// plus the LanguageDropdown's locale set. Gujarati included because the
// patient seed in many tenants covers Gujarati-speaking belts; the
// schema's `preferredLanguage String?` is free-form so any 2-letter ISO
// code passes server validation.
const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  { value: "gu", label: "ગુજરાતી (Gujarati)" },
  { value: "ta", label: "தமிழ் (Tamil)" },
  { value: "te", label: "తెలుగు (Telugu)" },
  { value: "mr", label: "मराठी (Marathi)" },
];

interface FormState {
  name: string;
  dateOfBirth: string; // YYYY-MM-DD for <input type="date">
  address: string;
  preferredLanguage: string;
  abhaId: string;
  notifications: Record<NotificationChannel, boolean>;
}

function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  // The /auth/me response ships ISO strings for DOB; the date input
  // expects YYYY-MM-DD. Parse defensively — if the value is already in
  // the right shape we keep it, if it's a full ISO we strip the time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildInitialForm(
  me: MeResponse["data"],
  prefs: NotificationPrefRow[],
): FormState {
  const notifMap: Record<NotificationChannel, boolean> = {
    WHATSAPP: true,
    SMS: true,
    EMAIL: true,
    PUSH: true,
  };
  for (const row of prefs) {
    if (CHANNELS.includes(row.channel)) {
      notifMap[row.channel] = !!row.enabled;
    }
  }
  return {
    name: me?.name ?? "",
    dateOfBirth: toDateInput(me?.patient?.dateOfBirth),
    address: me?.patient?.address ?? "",
    // Prefer the User row's preferredLanguage — that's the column the
    // dashboard LanguageDropdown writes to. The Patient row mirrors it.
    preferredLanguage: me?.preferredLanguage ?? me?.patient?.preferredLanguage ?? "en",
    abhaId: me?.patient?.abhaId ?? "",
    notifications: notifMap,
  };
}

export default function PatientProfilePage() {
  const [state, setState] = useState<LoadState>("loading");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [me, setMe] = useState<MeResponse["data"] | null>(null);
  const [initialForm, setInitialForm] = useState<FormState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const fetchInitial = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const [meRes, prefsRes] = await Promise.allSettled([
        api.get<MeResponse>("/auth/me", { skip401Redirect: true }),
        api.get<NotificationPrefsResponse>("/notifications/preferences", {
          skip401Redirect: true,
        }),
      ]);

      const any401 = [meRes, prefsRes].some(
        (r) =>
          r.status === "rejected" &&
          (r.reason as { status?: number })?.status === 401,
      );
      if (any401) {
        setState("unauth");
        return;
      }

      const meData =
        meRes.status === "fulfilled" && meRes.value.success ? meRes.value.data : null;
      const prefs: NotificationPrefRow[] =
        prefsRes.status === "fulfilled" && prefsRes.value.success
          ? prefsRes.value.data ?? []
          : [];

      if (!meData) {
        setState("error");
        return;
      }

      const initial = buildInitialForm(meData, prefs);
      setMe(meData);
      setInitialForm(initial);
      setForm(initial);
      setState("ready");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        setState("unauth");
        return;
      }
      setState("error");
    }
  }, []);

  useEffect(() => {
    void fetchInitial();
  }, [fetchInitial]);

  const dirty = useMemo(() => {
    if (!form || !initialForm) return false;
    if (form.name !== initialForm.name) return true;
    if (form.dateOfBirth !== initialForm.dateOfBirth) return true;
    if (form.address !== initialForm.address) return true;
    if (form.preferredLanguage !== initialForm.preferredLanguage) return true;
    if (form.abhaId !== initialForm.abhaId) return true;
    for (const ch of CHANNELS) {
      if (form.notifications[ch] !== initialForm.notifications[ch]) return true;
    }
    return false;
  }, [form, initialForm]);

  function patchField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    // Clear field-level error when the user edits the field.
    setFieldErrors((prev) => {
      if (!prev[String(key)]) return prev;
      const { [String(key)]: _drop, ...rest } = prev;
      return rest;
    });
  }

  function toggleChannel(ch: NotificationChannel) {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            notifications: { ...prev.notifications, [ch]: !prev.notifications[ch] },
          }
        : prev,
    );
  }

  const handleCancel = useCallback(() => {
    if (initialForm) setForm(initialForm);
    setSubmitState("idle");
    setSubmitError(null);
    setFieldErrors({});
  }, [initialForm]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!form || !initialForm) return;
      setSubmitState("saving");
      setSubmitError(null);
      setFieldErrors({});

      // Build the two PATCH bodies, sending only fields that actually
      // changed. The notifications PUT always sends the full array because
      // the server endpoint is a "set the state, return the state" upsert.
      const userPatch: Record<string, unknown> = {};
      if (form.name !== initialForm.name) userPatch.name = form.name.trim();
      if (form.preferredLanguage !== initialForm.preferredLanguage) {
        userPatch.preferredLanguage = form.preferredLanguage;
      }

      const patientPatch: Record<string, unknown> = {};
      if (form.dateOfBirth !== initialForm.dateOfBirth) {
        patientPatch.dateOfBirth = form.dateOfBirth || null;
      }
      if (form.address !== initialForm.address) {
        patientPatch.address = form.address;
      }
      if (form.preferredLanguage !== initialForm.preferredLanguage) {
        patientPatch.preferredLanguage = form.preferredLanguage;
      }
      if (form.abhaId !== initialForm.abhaId) {
        patientPatch.abhaId = form.abhaId;
      }

      const channelsDirty = CHANNELS.some(
        (ch) => form.notifications[ch] !== initialForm.notifications[ch],
      );

      try {
        const tasks: Array<Promise<unknown>> = [];
        if (Object.keys(userPatch).length > 0) {
          tasks.push(api.patch("/auth/me", userPatch));
        }
        if (Object.keys(patientPatch).length > 0) {
          tasks.push(api.patch("/patients/me", patientPatch));
        }
        if (channelsDirty) {
          tasks.push(
            api.put("/notifications/preferences", {
              preferences: CHANNELS.map((channel) => ({
                channel,
                enabled: form.notifications[channel],
              })),
            }),
          );
        }

        await Promise.all(tasks);
        setSubmitState("saved");
        // Snap the new state in so dirty-tracking resets.
        setInitialForm(form);
      } catch (err) {
        const payload = (err as { payload?: { details?: Array<{ field: string; message: string }> } })
          .payload;
        const details = payload?.details ?? [];
        if (Array.isArray(details) && details.length > 0) {
          const fieldMap: Record<string, string> = {};
          for (const d of details) {
            if (d?.field) fieldMap[d.field] = d.message;
          }
          setFieldErrors(fieldMap);
        }
        setSubmitError(
          (err as Error)?.message ?? "Something went wrong saving your profile.",
        );
        setSubmitState("error");
      }
    },
    [form, initialForm],
  );

  // Field helper mirrors apps/web/src/app/dashboard/settings/page.tsx Field —
  // small label-stacked-above-input convention shared across the staff
  // settings UI. Keeping the patient form on the same primitive lets it
  // visually match the settings cards exactly.
  function Field({
    label,
    htmlFor,
    children,
  }: {
    label: string;
    htmlFor?: string;
    children: React.ReactNode;
  }) {
    return (
      <label htmlFor={htmlFor} className="block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
          {label}
        </span>
        {children}
      </label>
    );
  }
  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900";
  const inputErrorClass =
    "w-full rounded-lg border border-red-500 bg-red-50 px-3 py-2 dark:bg-red-900/20";
  const readOnlyInputClass =
    "w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/50";

  if (state === "loading") {
    return (
      <div data-testid="patient-profile-loading">
        <h1 className="mb-6 text-2xl font-bold">My Profile</h1>
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
            >
              <div className="mb-4 h-5 w-32 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
              <div className="grid gap-4 md:grid-cols-2">
                <div className="h-10 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                <div className="h-10 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (state === "unauth") {
    return (
      <div data-testid="patient-profile-unauth">
        <h1 className="mb-6 text-2xl font-bold">My Profile</h1>
        <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
          <h2 className="mb-2 text-lg font-semibold">Sign in required</h2>
          <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
            Please sign in to view and edit your profile.
          </p>
          <Link
            href="/patient/login"
            data-testid="patient-profile-signin-cta"
            className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (state === "error" || !form || !me) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold">My Profile</h1>
        <div
          data-testid="patient-profile-error"
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-6 text-sm text-red-800 shadow-sm dark:border-red-700 dark:bg-red-900/20 dark:text-red-200"
        >
          Something went wrong loading your profile. Please refresh.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold">My Profile</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Keep your details up to date so reminders and bills reach you.
      </p>

      <form
        data-testid="patient-profile"
        className="space-y-6"
        onSubmit={handleSubmit}
        noValidate
      >
        {/* ─── Personal ─────────────────────────────────────────────── */}
        <div
          data-testid="patient-profile-section-personal"
          className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
        >
          <h2 className="mb-4 text-lg font-semibold">Personal</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Full name">
              <input
                type="text"
                data-testid="patient-profile-name-input"
                value={form.name}
                onChange={(e) => patchField("name", e.target.value)}
                maxLength={100}
                aria-invalid={fieldErrors.name ? "true" : undefined}
                className={fieldErrors.name ? inputErrorClass : inputClass}
              />
              {fieldErrors.name ? (
                <span
                  data-testid="patient-profile-name-error"
                  className="mt-1 block text-xs text-red-600"
                >
                  {fieldErrors.name}
                </span>
              ) : null}
            </Field>

            <Field label="Date of birth">
              <input
                type="date"
                data-testid="patient-profile-dob-input"
                value={form.dateOfBirth}
                onChange={(e) => patchField("dateOfBirth", e.target.value)}
                aria-invalid={fieldErrors.dateOfBirth ? "true" : undefined}
                className={
                  fieldErrors.dateOfBirth ? inputErrorClass : inputClass
                }
              />
              {fieldErrors.dateOfBirth ? (
                <span
                  data-testid="patient-profile-dob-error"
                  className="mt-1 block text-xs text-red-600"
                >
                  {fieldErrors.dateOfBirth}
                </span>
              ) : null}
            </Field>

            <Field label="Phone (read-only)">
              <input
                type="tel"
                readOnly
                data-testid="patient-profile-phone-input"
                value={me.phone ?? ""}
                className={readOnlyInputClass}
              />
              <span
                data-testid="patient-profile-phone-hint"
                className="mt-1 block text-xs text-gray-500 dark:text-gray-400"
              >
                Contact reception to change your phone number — it secures your
                sign-in.
              </span>
            </Field>

            {me.patient?.gender ? (
              <Field label="Gender (read-only)">
                <input
                  type="text"
                  readOnly
                  data-testid="patient-profile-gender-input"
                  value={me.patient.gender}
                  className={readOnlyInputClass}
                />
              </Field>
            ) : null}
          </div>
        </div>

        {/* ─── Address ──────────────────────────────────────────────── */}
        <div
          data-testid="patient-profile-section-address"
          className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
        >
          <h2 className="mb-4 text-lg font-semibold">Address</h2>
          <Field label="Postal address">
            <textarea
              data-testid="patient-profile-address-input"
              value={form.address}
              onChange={(e) => patchField("address", e.target.value)}
              rows={3}
              aria-invalid={fieldErrors.address ? "true" : undefined}
              className={fieldErrors.address ? inputErrorClass : inputClass}
            />
            {fieldErrors.address ? (
              <span
                data-testid="patient-profile-address-error"
                className="mt-1 block text-xs text-red-600"
              >
                {fieldErrors.address}
              </span>
            ) : null}
          </Field>
        </div>

        {/* ─── Preferences ──────────────────────────────────────────── */}
        <div
          data-testid="patient-profile-section-preferences"
          className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
        >
          <h2 className="mb-4 text-lg font-semibold">Preferences</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Preferred language">
              <select
                data-testid="patient-profile-language-select"
                value={form.preferredLanguage}
                onChange={(e) =>
                  patchField("preferredLanguage", e.target.value)
                }
                className={inputClass}
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div
            data-testid="patient-profile-channels"
            className="mt-6 space-y-3"
          >
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Send reminders via
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Pick the channels we&apos;re allowed to use for appointment +
              medication reminders.
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {CHANNELS.map((channel) => {
                const enabled = form.notifications[channel];
                return (
                  <li
                    key={channel}
                    className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40"
                  >
                    <span className="text-sm text-gray-800 dark:text-gray-200">
                      {CHANNEL_LABELS[channel]}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleChannel(channel)}
                      aria-pressed={enabled}
                      data-testid={`patient-profile-channel-${channel.toLowerCase()}`}
                      className={
                        "inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium transition " +
                        (enabled
                          ? "bg-primary text-white hover:bg-primary-dark"
                          : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700")
                      }
                    >
                      {enabled ? "On" : "Off"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* ─── Health ID (ABHA) ─────────────────────────────────────── */}
        <div
          data-testid="patient-profile-section-healthid"
          className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
        >
          <h2 className="mb-4 text-lg font-semibold">Health ID</h2>
          <Field label="ABHA number">
            <input
              type="text"
              data-testid="patient-profile-abha-input"
              value={form.abhaId}
              onChange={(e) => patchField("abhaId", e.target.value)}
              placeholder="e.g. 14-1234-5678-9012"
              aria-invalid={fieldErrors.abhaId ? "true" : undefined}
              className={fieldErrors.abhaId ? inputErrorClass : inputClass}
            />
            {fieldErrors.abhaId ? (
              <span
                data-testid="patient-profile-abha-error"
                className="mt-1 block text-xs text-red-600"
              >
                {fieldErrors.abhaId}
              </span>
            ) : null}
          </Field>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href="/patient/profile/link-abha"
              data-testid="patient-profile-abha-link-cta"
              className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Link ABHA (Aadhaar OTP)
            </Link>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              ABHA linking via Aadhaar OTP is coming soon. For now you can paste
              an existing ABHA number to attach to your record.
            </p>
          </div>
        </div>

        {/* ─── Status banners ───────────────────────────────────────── */}
        {submitState === "saved" ? (
          <p
            data-testid="patient-profile-saved-toast"
            role="status"
            className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-medium text-emerald-900 shadow-sm dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-200"
          >
            Profile saved.
          </p>
        ) : null}
        {submitState === "error" && submitError ? (
          <p
            data-testid="patient-profile-submit-error"
            role="alert"
            className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm dark:border-red-700 dark:bg-red-900/20 dark:text-red-200"
          >
            {submitError}
          </p>
        ) : null}

        {/* ─── Submit row ───────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={handleCancel}
            data-testid="patient-profile-cancel-btn"
            disabled={!dirty || submitState === "saving"}
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="patient-profile-save-btn"
            disabled={!dirty || submitState === "saving"}
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {submitState === "saving" ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
