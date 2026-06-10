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

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ChevronDown, Check } from "lucide-react";
import { api } from "@/lib/api";
import { PatientAvatar } from "@/components/PatientAvatar";

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
  dateOfBirth: string; // YYYY-MM-DD, composed from the day/month/year pickers
  gender: string; // "" | MALE | FEMALE | OTHER
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

// ── DOB dropdown options (mirrors the public booking page) ────────────────
const DOB_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOB_THIS_YEAR = new Date().getFullYear();
const DOB_YEARS = Array.from({ length: 120 }, (_, i) => DOB_THIS_YEAR - i);

const GENDER_OPTIONS = [
  { value: "MALE", label: "Male" },
  { value: "FEMALE", label: "Female" },
  { value: "OTHER", label: "Other" },
];

// ── FancySelect ──────────────────────────────────────────────────────────
// Styled, animated dropdown (a native <select> can't be skinned internally).
// The popover is PORTALED to <body> so it escapes any blur/stacking context.
// Lifted verbatim from apps/web/src/app/(marketing)/book/page.tsx.
interface FancyOption {
  value: string;
  label: string;
}
function FancySelect({
  value,
  onChange,
  options,
  placeholder,
  testId,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FancyOption[];
  placeholder: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => setMounted(true), []);

  function openMenu() {
    setIsDark(document.documentElement.classList.contains("dark"));
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.bottom + 6, width: r.width });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function reposition() {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left, top: r.bottom + 6, width: r.width });
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`flex w-full items-center justify-between gap-1 rounded-xl border bg-white px-3 py-3 text-sm shadow-sm transition-all duration-200 hover:border-gray-400 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:bg-gray-900 ${
          open
            ? "border-blue-500 ring-4 ring-blue-500/15"
            : "border-gray-300 dark:border-gray-700"
        }`}
      >
        <span
          className={
            selected
              ? "text-gray-900 dark:text-gray-100"
              : "text-gray-400 dark:text-gray-500"
          }
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${
            open ? "rotate-180 text-blue-500" : ""
          }`}
        />
      </button>
      {mounted &&
        open &&
        rect &&
        createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            className="fixed z-[1000] max-h-56 origin-top overflow-y-auto rounded-xl border border-gray-200 p-1 shadow-2xl ring-1 ring-black/10 dark:border-gray-600 dark:ring-white/10"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              backgroundColor: isDark ? "#0f172a" : "#ffffff",
            }}
          >
            {options.map((o) => {
              const isSel = o.value === value;
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      isSel
                        ? "bg-gradient-to-r from-blue-600 to-indigo-600 font-medium text-white shadow-sm"
                        : "text-gray-700 hover:bg-blue-50 hover:text-blue-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:hover:text-white"
                    }`}
                  >
                    {o.label}
                    {isSel && <Check className="h-4 w-4" />}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}

// Labelled field wrapper. MUST be module-scope (not nested in the page
// component) — a component defined inside the render function is a NEW
// function reference every render, so React remounts it and its inputs each
// keystroke, stealing focus after one character.
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
    gender: me?.patient?.gender ?? "",
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

  // Phone is read-only (sign-in handle — changes routed through reception).
  const [displayPhone, setDisplayPhone] = useState<string>("");

  // DOB dropdown parts (day "1-31", month "1-12", year "YYYY" as strings).
  const [dobDay, setDobDay] = useState("");
  const [dobMonth, setDobMonth] = useState("");
  const [dobYear, setDobYear] = useState("");

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
      setDisplayPhone(meData?.phone ?? "");
      // Seed the DOB dropdowns from the loaded YYYY-MM-DD.
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(initial.dateOfBirth);
      if (dm) {
        setDobYear(dm[1]);
        setDobMonth(String(Number(dm[2])));
        setDobDay(String(Number(dm[3])));
      } else {
        setDobYear("");
        setDobMonth("");
        setDobDay("");
      }
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
    if (form.gender !== initialForm.gender) return true;
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

  // DOB is composed from three dropdowns. We hold day/month/year in their own
  // state (so a partial pick survives) and recompose `form.dateOfBirth` to
  // YYYY-MM-DD whenever all three are set (clamping the day to the chosen
  // month/year so e.g. 31 Feb can't be submitted). Seeded from the loaded DOB.
  function setDobPart(part: "day" | "month" | "year", value: string) {
    const day = part === "day" ? value : dobDay;
    const month = part === "month" ? value : dobMonth; // 1-12 as string
    const year = part === "year" ? value : dobYear;
    if (part === "day") setDobDay(value);
    if (part === "month") setDobMonth(value);
    if (part === "year") setDobYear(value);
    if (day && month && year) {
      const maxDay = new Date(Number(year), Number(month), 0).getDate();
      const clampedDay = Math.min(Number(day), maxDay);
      if (clampedDay !== Number(day)) setDobDay(String(clampedDay));
      patchField(
        "dateOfBirth",
        `${year}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`,
      );
    } else {
      patchField("dateOfBirth", "");
    }
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
      if (form.gender !== initialForm.gender && form.gender) {
        patientPatch.gender = form.gender;
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
          {/* Profile photo — resolved display URL from GET /auth/me
              (registration / reception-set photo). Read-only here; editing
              the photo lives on the staff profile + patient-edit surfaces. */}
          <div
            className="mb-4 flex items-center gap-4"
            data-testid="patient-profile-photo"
          >
            <PatientAvatar
              photoUrl={me?.photoUrl ?? null}
              name={form.name || me?.name}
              size={56}
            />
          </div>
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
              <div
                data-testid="patient-profile-dob"
                className="grid grid-cols-3 gap-2"
              >
                <FancySelect
                  testId="patient-profile-dob-day"
                  ariaLabel="Day of birth"
                  placeholder="Day"
                  value={dobDay}
                  onChange={(v) => setDobPart("day", v)}
                  options={Array.from({ length: 31 }, (_, i) => ({
                    value: String(i + 1),
                    label: String(i + 1),
                  }))}
                />
                <FancySelect
                  testId="patient-profile-dob-month"
                  ariaLabel="Month of birth"
                  placeholder="Month"
                  value={dobMonth}
                  onChange={(v) => setDobPart("month", v)}
                  options={DOB_MONTHS.map((m, i) => ({
                    value: String(i + 1),
                    label: m,
                  }))}
                />
                <FancySelect
                  testId="patient-profile-dob-year"
                  ariaLabel="Year of birth"
                  placeholder="Year"
                  value={dobYear}
                  onChange={(v) => setDobPart("year", v)}
                  options={DOB_YEARS.map((y) => ({
                    value: String(y),
                    label: String(y),
                  }))}
                />
              </div>
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
                value={displayPhone}
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

            <Field label="Gender">
              <FancySelect
                testId="patient-profile-gender-input"
                ariaLabel="Gender"
                placeholder="Select gender"
                value={form.gender}
                onChange={(v) => patchField("gender", v)}
                options={GENDER_OPTIONS}
              />
            </Field>
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
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
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
