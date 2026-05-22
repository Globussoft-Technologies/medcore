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

  if (state === "loading") {
    return (
      <section
        data-testid="patient-profile-loading"
        className="space-y-4 py-6"
      >
        <div className="h-8 w-40 animate-pulse rounded bg-slate-100" />
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-11 w-full animate-pulse rounded bg-slate-100"
            />
          ))}
        </div>
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section data-testid="patient-profile-unauth" className="space-y-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600">
          Please sign in to view and edit your profile.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-profile-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error" || !form || !me) {
    return (
      <section
        data-testid="patient-profile-error"
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        Something went wrong loading your profile. Please refresh.
      </section>
    );
  }

  return (
    <section data-testid="patient-profile" className="space-y-6 py-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My profile</h1>
        <p className="text-sm text-slate-600">
          Keep your details up to date so reminders and bills reach you.
        </p>
      </header>

      <form className="space-y-8" onSubmit={handleSubmit} noValidate>
        {/* ─── Personal ─────────────────────────────────────────────── */}
        <fieldset
          data-testid="patient-profile-section-personal"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <legend className="px-1 text-sm font-medium uppercase tracking-wide text-slate-500">
            Personal
          </legend>

          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">Full name</span>
            <input
              type="text"
              data-testid="patient-profile-name-input"
              value={form.name}
              onChange={(e) => patchField("name", e.target.value)}
              maxLength={100}
              className="block h-11 w-full rounded-md border border-slate-300 px-3 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
            />
            {fieldErrors.name ? (
              <span
                data-testid="patient-profile-name-error"
                className="text-xs font-medium text-red-700"
              >
                {fieldErrors.name}
              </span>
            ) : null}
          </label>

          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">Date of birth</span>
            <input
              type="date"
              data-testid="patient-profile-dob-input"
              value={form.dateOfBirth}
              onChange={(e) => patchField("dateOfBirth", e.target.value)}
              className="block h-11 w-full rounded-md border border-slate-300 px-3 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
            />
            {fieldErrors.dateOfBirth ? (
              <span
                data-testid="patient-profile-dob-error"
                className="text-xs font-medium text-red-700"
              >
                {fieldErrors.dateOfBirth}
              </span>
            ) : null}
          </label>

          <div className="space-y-1">
            <span className="text-sm font-medium text-slate-800">Phone</span>
            <input
              type="tel"
              readOnly
              data-testid="patient-profile-phone-input"
              value={me.phone ?? ""}
              className="block h-11 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-base text-slate-700"
            />
            <p
              data-testid="patient-profile-phone-hint"
              className="text-xs text-slate-500"
            >
              Contact reception to change your phone number — it secures your sign-in.
            </p>
          </div>

          {me.patient?.gender ? (
            <div className="space-y-1">
              <span className="text-sm font-medium text-slate-800">Gender</span>
              <input
                type="text"
                readOnly
                data-testid="patient-profile-gender-input"
                value={me.patient.gender}
                className="block h-11 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-base text-slate-700"
              />
            </div>
          ) : null}
        </fieldset>

        {/* ─── Address ──────────────────────────────────────────────── */}
        <fieldset
          data-testid="patient-profile-section-address"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <legend className="px-1 text-sm font-medium uppercase tracking-wide text-slate-500">
            Address
          </legend>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">Postal address</span>
            <textarea
              data-testid="patient-profile-address-input"
              value={form.address}
              onChange={(e) => patchField("address", e.target.value)}
              rows={3}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
            />
            {fieldErrors.address ? (
              <span
                data-testid="patient-profile-address-error"
                className="text-xs font-medium text-red-700"
              >
                {fieldErrors.address}
              </span>
            ) : null}
          </label>
        </fieldset>

        {/* ─── Preferences ──────────────────────────────────────────── */}
        <fieldset
          data-testid="patient-profile-section-preferences"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <legend className="px-1 text-sm font-medium uppercase tracking-wide text-slate-500">
            Preferences
          </legend>

          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">Preferred language</span>
            <select
              data-testid="patient-profile-language-select"
              value={form.preferredLanguage}
              onChange={(e) => patchField("preferredLanguage", e.target.value)}
              className="block h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <div
            data-testid="patient-profile-channels"
            className="space-y-2 pt-2"
          >
            <p className="text-sm font-medium text-slate-800">Send reminders via</p>
            <p className="text-xs text-slate-500">
              Pick the channels we&apos;re allowed to use for appointment + medication
              reminders.
            </p>
            <ul className="space-y-2 pt-1">
              {CHANNELS.map((channel) => {
                const enabled = form.notifications[channel];
                return (
                  <li
                    key={channel}
                    className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <span className="text-sm text-slate-800">
                      {CHANNEL_LABELS[channel]}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleChannel(channel)}
                      aria-pressed={enabled}
                      data-testid={`patient-profile-channel-${channel.toLowerCase()}`}
                      className={`inline-flex h-11 min-w-[44px] items-center justify-center rounded-md px-4 text-xs font-medium ${
                        enabled
                          ? "bg-emerald-600 text-white"
                          : "border border-slate-300 bg-white text-slate-700"
                      }`}
                    >
                      {enabled ? "On" : "Off"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </fieldset>

        {/* ─── Health ID (ABHA) ─────────────────────────────────────── */}
        <fieldset
          data-testid="patient-profile-section-healthid"
          className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <legend className="px-1 text-sm font-medium uppercase tracking-wide text-slate-500">
            Health ID
          </legend>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-800">ABHA number</span>
            <input
              type="text"
              data-testid="patient-profile-abha-input"
              value={form.abhaId}
              onChange={(e) => patchField("abhaId", e.target.value)}
              placeholder="e.g. 14-1234-5678-9012"
              className="block h-11 w-full rounded-md border border-slate-300 px-3 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
            />
            {fieldErrors.abhaId ? (
              <span
                data-testid="patient-profile-abha-error"
                className="text-xs font-medium text-red-700"
              >
                {fieldErrors.abhaId}
              </span>
            ) : null}
          </label>
          <Link
            href="/patient/profile/link-abha"
            data-testid="patient-profile-abha-link-cta"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
          >
            Link ABHA (Aadhaar OTP)
          </Link>
          <p className="text-xs text-slate-500">
            ABHA linking via Aadhaar OTP is coming soon. For now you can paste an
            existing ABHA number to attach to your record.
          </p>
        </fieldset>

        {/* ─── Submit row + status ──────────────────────────────────── */}
        {submitState === "saved" ? (
          <p
            data-testid="patient-profile-saved-toast"
            role="status"
            className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-900"
          >
            Profile saved.
          </p>
        ) : null}
        {submitState === "error" && submitError ? (
          <p
            data-testid="patient-profile-submit-error"
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800"
          >
            {submitError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button
            type="submit"
            data-testid="patient-profile-save-btn"
            disabled={!dirty || submitState === "saving"}
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white disabled:opacity-60"
          >
            {submitState === "saving" ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            data-testid="patient-profile-cancel-btn"
            disabled={!dirty || submitState === "saving"}
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-6 text-sm font-medium text-slate-800 disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
