"use client";

// Issue #45 fix: the form now runs the SAME Zod schema that the server runs
// (imported from @medcore/shared), so the "Invalid enquiry payload" generic
// toast is gone. Each field renders its own <p role="alert"> inline. Server-
// side 400 responses are expected to carry structured `errors: [{field, ...}]`
// which we map back onto the same field-error state.
import { useState, FormEvent } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
import {
  marketingEnquirySchema,
  type MarketingEnquiryFieldError,
} from "@medcore/shared";
import { useTranslation } from "@/lib/i18n";

type Status = "idle" | "submitting" | "success" | "error";

const fieldBase =
  "mt-1 block w-full rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:placeholder-gray-500";

const fieldBaseError =
  "mt-1 block w-full rounded-xl border border-red-400 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20 dark:border-red-700 dark:bg-gray-950 dark:text-white";

const labelBase = "block text-sm font-medium text-gray-800 dark:text-gray-200";

type FieldErrors = Partial<Record<string, string>>;

export function EnquiryForm() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("idle");
  // generalError is reserved for non-field problems (network, 5xx). Field
  // errors render inline under the input; we never fall back to a generic
  // toast when the server returns field-level info.
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function errClass(field: string): string {
    return fieldErrors[field] ? fieldBaseError : fieldBase;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setGeneralError(null);
    setFieldErrors({});

    const form = e.currentTarget;
    const fd = new FormData(form);

    const rawPayload = {
      fullName: String(fd.get("fullName") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      phone: String(fd.get("phone") || "").trim(),
      hospitalName: String(fd.get("hospitalName") || "").trim(),
      hospitalSize: String(fd.get("hospitalSize") || ""),
      role: String(fd.get("role") || ""),
      message: String(fd.get("message") || "").trim(),
      preferredContactTime:
        String(fd.get("preferredContactTime") || "") || undefined,
      // Honeypot
      website: String(fd.get("website") || ""),
    };

    // Client-side validation with the shared schema.
    const parsed = marketingEnquirySchema.safeParse(rawPayload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const iss of parsed.error.issues) {
        const field = iss.path.join(".") || "_root";
        // First error per field wins (matches what the user sees when the
        // server responds — avoids message thrashing).
        if (!next[field]) next[field] = iss.message;
      }
      setFieldErrors(next);
      setStatus("error");
      return;
    }

    try {
      // POST directly to the Express router — nginx routes /api/* to the
      // Express backend, bypassing the Next.js API layer.
      const apiBase = process.env.NEXT_PUBLIC_API_URL || "/api/v1";
      const resp = await fetch(`${apiBase}/marketing/enquiry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data = await resp.json().catch(() => ({}));

      // 400 = validation errors; 409 = duplicate-email conflict. Both carry a
      // structured `errors: [{field,message}]` list we render inline.
      if (
        (resp.status === 400 || resp.status === 409) &&
        Array.isArray(data?.errors)
      ) {
        // Map structured server errors back onto field state — identical UX
        // to client-side validation.
        const next: FieldErrors = {};
        for (const err of data.errors as MarketingEnquiryFieldError[]) {
          if (!next[err.field]) next[err.field] = err.message;
        }
        setFieldErrors(next);
        setStatus("error");
        return;
      }

      if (!resp.ok || !data?.success) {
        setStatus("error");
        setGeneralError(
          data?.error ||
            t(
              "contact.error.generic",
              "Something went wrong. Please try again or email hello@medcore.in."
            )
        );
        return;
      }
      setStatus("success");
      form.reset();
    } catch {
      setStatus("error");
      setGeneralError(
        t("contact.error.network", "Network error. Please try again.")
      );
    }
  }

  if (status === "success") {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
          <CheckCircle2 className="h-8 w-8" />
        </div>
        <h2 className="mt-5 text-2xl font-bold text-gray-900 dark:text-white">
          {t("contact.success.title", "Thanks — we'll be in touch.")}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          {t(
            "contact.success.body",
            "We've received your enquiry and will reply within one business day."
          )}
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-6 text-sm font-semibold text-blue-600 hover:underline"
        >
          {t("contact.success.again", "Submit another enquiry")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      {/* Honeypot — hidden from users, tempting for bots. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Leave this field blank</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="fullName" className={labelBase}>
            {t("contact.field.fullName", "Full name")} *
          </label>
          <input
            id="fullName"
            name="fullName"
            type="text"
            className={errClass("fullName")}
            placeholder={t("contact.field.fullName.placeholder", "Dr. Meera Rao")}
            aria-invalid={!!fieldErrors.fullName}
            aria-describedby={fieldErrors.fullName ? "fullName-error" : undefined}
          />
          {fieldErrors.fullName && (
            <p id="fullName-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.fullName}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="email" className={labelBase}>
            {t("contact.field.email", "Work email")} *
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className={errClass("email")}
            placeholder={t("contact.field.email.placeholder", "meera@hospital.in")}
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
          />
          {fieldErrors.email && (
            <p id="email-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.email}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="phone" className={labelBase}>
            {t("contact.field.phone", "Phone (Indian mobile, optional)")}
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            className={errClass("phone")}
            placeholder={t("contact.field.phone.placeholder", "+91 98xxxxxxxx")}
            aria-invalid={!!fieldErrors.phone}
            aria-describedby={fieldErrors.phone ? "phone-error" : undefined}
          />
          {fieldErrors.phone && (
            <p id="phone-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.phone}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="hospitalName" className={labelBase}>
            {t("contact.field.hospitalName", "Hospital name")} *
          </label>
          <input
            id="hospitalName"
            name="hospitalName"
            type="text"
            className={errClass("hospitalName")}
            placeholder={t("contact.field.hospitalName.placeholder", "Asha Hospital")}
            aria-invalid={!!fieldErrors.hospitalName}
            aria-describedby={
              fieldErrors.hospitalName ? "hospitalName-error" : undefined
            }
          />
          {fieldErrors.hospitalName && (
            <p id="hospitalName-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.hospitalName}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="hospitalSize" className={labelBase}>
            {t("contact.field.hospitalSize", "Hospital size")} *
          </label>
          <select
            id="hospitalSize"
            name="hospitalSize"
            defaultValue=""
            className={errClass("hospitalSize")}
            aria-invalid={!!fieldErrors.hospitalSize}
            aria-describedby={
              fieldErrors.hospitalSize ? "hospitalSize-error" : undefined
            }
          >
            <option value="" disabled>
              {t("contact.field.select", "Select...")}
            </option>
            <option value="1-10">1-10 beds</option>
            <option value="10-50">10-50 beds</option>
            <option value="50-200">50-200 beds</option>
            <option value="200+">200+ beds</option>
          </select>
          {fieldErrors.hospitalSize && (
            <p id="hospitalSize-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.hospitalSize}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="role" className={labelBase}>
            {t("contact.field.role", "Your role")} *
          </label>
          <select
            id="role"
            name="role"
            defaultValue=""
            className={errClass("role")}
            aria-invalid={!!fieldErrors.role}
            aria-describedby={fieldErrors.role ? "role-error" : undefined}
          >
            <option value="" disabled>
              {t("contact.field.select", "Select...")}
            </option>
            <option value="Administrator">
              {t("contact.role.admin", "Administrator")}
            </option>
            <option value="Doctor">{t("contact.role.doctor", "Doctor")}</option>
            <option value="IT">{t("contact.role.it", "IT")}</option>
            <option value="Other">{t("contact.role.other", "Other")}</option>
          </select>
          {fieldErrors.role && (
            <p id="role-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {fieldErrors.role}
            </p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="preferredContactTime" className={labelBase}>
          {t("contact.field.preferredContactTime", "Preferred contact time")}
        </label>
        <select
          id="preferredContactTime"
          name="preferredContactTime"
          defaultValue="Anytime"
          className={fieldBase}
        >
          <option value="Morning">{t("contact.time.morning", "Morning")}</option>
          <option value="Afternoon">
            {t("contact.time.afternoon", "Afternoon")}
          </option>
          <option value="Evening">{t("contact.time.evening", "Evening")}</option>
          <option value="Anytime">{t("contact.time.anytime", "Anytime")}</option>
        </select>
      </div>

      <div>
        <label htmlFor="message" className={labelBase}>
          {t("contact.field.message", "Message")} *
        </label>
        <textarea
          id="message"
          name="message"
          rows={4}
          className={errClass("message")}
          placeholder={t(
            "contact.field.message.placeholder",
            "Tell us about your current setup and what you're hoping to improve."
          )}
          aria-invalid={!!fieldErrors.message}
          aria-describedby={fieldErrors.message ? "message-error" : undefined}
        />
        {fieldErrors.message && (
          <p id="message-error" role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
            {fieldErrors.message}
          </p>
        )}
      </div>

      {status === "error" && generalError && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
        >
          {generalError}
        </div>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/20 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
        {status === "submitting"
          ? t("contact.submit.loading", "Sending...")
          : t("contact.submit", "Request a Demo")}
      </button>

      <p className="text-center text-xs text-gray-500">
        {t(
          "contact.consent",
          "By submitting, you agree that MedCore may contact you about the demo. We will never share your information."
        )}
      </p>
    </form>
  );
}
