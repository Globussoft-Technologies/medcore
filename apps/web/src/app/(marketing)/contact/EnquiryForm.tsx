"use client";

import { useState, FormEvent } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";

type Status = "idle" | "submitting" | "success" | "error";

const fieldBase =
  "mt-1 block w-full rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950 dark:text-white dark:placeholder-gray-500";

const labelBase = "block text-sm font-medium text-gray-800 dark:text-gray-200";

export function EnquiryForm() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    const form = e.currentTarget;
    const fd = new FormData(form);

    // Client-side guard for required fields (server also validates).
    const required = ["fullName", "email", "phone", "hospitalName", "hospitalSize", "role"];
    for (const key of required) {
      if (!String(fd.get(key) || "").trim()) {
        setStatus("error");
        setError("Please fill in all required fields.");
        return;
      }
    }

    const payload = {
      fullName: String(fd.get("fullName") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      phone: String(fd.get("phone") || "").trim(),
      hospitalName: String(fd.get("hospitalName") || "").trim(),
      hospitalSize: String(fd.get("hospitalSize") || ""),
      role: String(fd.get("role") || ""),
      message: String(fd.get("message") || "").trim(),
      preferredContactTime: String(fd.get("preferredContactTime") || "") || undefined,
      // Honeypot
      website: String(fd.get("website") || ""),
    };

    try {
      const resp = await fetch("/api/enquiry/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.success) {
        setStatus("error");
        setError(data?.error || "Something went wrong. Please try again or email hello@medcore.in.");
        return;
      }
      setStatus("success");
      form.reset();
    } catch {
      setStatus("error");
      setError("Network error. Please try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
          <CheckCircle2 className="h-8 w-8" />
        </div>
        <h2 className="mt-5 text-2xl font-bold text-gray-900 dark:text-white">Thanks — we&apos;ll be in touch.</h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          We&apos;ve received your enquiry and will reply within one business day.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-6 text-sm font-semibold text-blue-600 hover:underline"
        >
          Submit another enquiry
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
          <label htmlFor="fullName" className={labelBase}>Full name *</label>
          <input id="fullName" name="fullName" type="text" required className={fieldBase} placeholder="Dr. Meera Rao" />
        </div>
        <div>
          <label htmlFor="email" className={labelBase}>Work email *</label>
          <input id="email" name="email" type="email" required className={fieldBase} placeholder="meera@hospital.in" />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="phone" className={labelBase}>Phone (with country code) *</label>
          <input id="phone" name="phone" type="tel" required className={fieldBase} placeholder="+91 98xxxxxxxx" />
        </div>
        <div>
          <label htmlFor="hospitalName" className={labelBase}>Hospital name *</label>
          <input id="hospitalName" name="hospitalName" type="text" required className={fieldBase} placeholder="Asha Hospital" />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="hospitalSize" className={labelBase}>Hospital size *</label>
          <select id="hospitalSize" name="hospitalSize" required defaultValue="" className={fieldBase}>
            <option value="" disabled>Select...</option>
            <option value="1-10">1-10 beds</option>
            <option value="10-50">10-50 beds</option>
            <option value="50-200">50-200 beds</option>
            <option value="200+">200+ beds</option>
          </select>
        </div>
        <div>
          <label htmlFor="role" className={labelBase}>Your role *</label>
          <select id="role" name="role" required defaultValue="" className={fieldBase}>
            <option value="" disabled>Select...</option>
            <option value="Administrator">Administrator</option>
            <option value="Doctor">Doctor</option>
            <option value="IT">IT</option>
            <option value="Other">Other</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="preferredContactTime" className={labelBase}>Preferred contact time</label>
        <select id="preferredContactTime" name="preferredContactTime" defaultValue="Anytime" className={fieldBase}>
          <option value="Morning">Morning</option>
          <option value="Afternoon">Afternoon</option>
          <option value="Evening">Evening</option>
          <option value="Anytime">Anytime</option>
        </select>
      </div>

      <div>
        <label htmlFor="message" className={labelBase}>Message</label>
        <textarea
          id="message"
          name="message"
          rows={4}
          className={fieldBase}
          placeholder="Tell us about your current setup and what you're hoping to improve."
        />
      </div>

      {status === "error" && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/20 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
        {status === "submitting" ? "Sending..." : "Request a Demo"}
      </button>

      <p className="text-center text-xs text-gray-500">
        By submitting, you agree that MedCore may contact you about the demo. We will never share your information.
      </p>
    </form>
  );
}
