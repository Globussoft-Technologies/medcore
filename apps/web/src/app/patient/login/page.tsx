"use client";

// Patient phone-OTP login page (Pearl §5.3 / §6.1 — gap #5 piece 2 of 4).
//
// Two-step flow:
//   1. Phone input → POST /api/v1/patient-auth/otp-request → moves to step 2.
//   2. OTP input → POST /api/v1/patient-auth/otp-verify → cookies set by the
//      server, then router.push('/patient').
//
// Functional > pretty per the piece-2 scope. Piece 3 (dashboard tiles) and
// piece 4 (offline cache) will polish the look. We deliberately do NOT use
// the dashboard's `<LanguageDropdown>` or `<BranchPicker>` — this page lives
// in the bare `/patient` route group whose layout omits both.
//
// Touch targets: every interactive control is h-11 (44px) per Pearl §6.2.
// API errors render inline next to `data-testid="patient-login-error"` so
// the e2e (future) can assert on a specific element rather than a toast.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

type Step = "phone" | "otp";

interface OtpRequestResponse {
  success: boolean;
  data?: { sent: boolean } | null;
  error?: string | null;
}
interface OtpVerifyResponse {
  success: boolean;
  data?: {
    user?: { id: string; name: string; role: string };
    accessToken?: string;
  } | null;
  error?: string | null;
}

export default function PatientLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function sendCode(): Promise<void> {
    if (busy) return;
    setError(null);
    setInfo(null);
    if (!/^\+?[0-9]{10,15}$/.test(phone.trim())) {
      setError("Enter a valid phone number (10–15 digits, optional +).");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<OtpRequestResponse>(
        "/patient-auth/otp-request",
        { phone: phone.trim() },
      );
      if (res?.success) {
        setStep("otp");
        setInfo(
          "If this number is registered, a 6-digit code has been sent.",
        );
      } else {
        setError(res?.error || "Couldn't send code — please try again.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't send code";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(): Promise<void> {
    if (busy) return;
    setError(null);
    setInfo(null);
    if (!/^\d{6}$/.test(otp.trim())) {
      setError("Enter the 6-digit code from the SMS.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<OtpVerifyResponse>(
        "/patient-auth/otp-verify",
        { phone: phone.trim(), otp: otp.trim() },
      );
      if (res?.success) {
        // Cookies (medcore_at / medcore_rt / medcore_csrf) are already set
        // by the API response. Bounce to the patient landing page.
        router.push("/patient");
      } else {
        setError(res?.error || "Invalid or expired code");
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Couldn't verify code";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function resend(): void {
    // Re-runs sendCode against the same phone — the server enforces the
    // 3-per-10-min throttle and will surface a 429 inline if exceeded.
    void sendCode();
  }

  return (
    <section className="mx-auto max-w-sm space-y-6 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-slate-600">
          {step === "phone"
            ? "Enter your phone number to receive a one-time code."
            : "Enter the 6-digit code we just sent."}
        </p>
      </header>

      {step === "phone" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <label
              htmlFor="patient-login-phone"
              className="block text-sm font-medium text-slate-800"
            >
              Phone number
            </label>
            <input
              id="patient-login-phone"
              data-testid="patient-login-phone-input"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className="block h-11 w-full rounded-md border border-slate-300 px-3 text-base"
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
              required
            />
          </div>
          <button
            type="submit"
            data-testid="patient-login-send-code"
            disabled={busy}
            className="inline-flex h-11 w-full min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verifyCode();
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <label
              htmlFor="patient-login-otp"
              className="block text-sm font-medium text-slate-800"
            >
              6-digit code
            </label>
            <input
              id="patient-login-otp"
              data-testid="patient-login-otp-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="block h-11 w-full rounded-md border border-slate-300 px-3 text-base tracking-widest"
              placeholder="123456"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              disabled={busy}
              required
            />
          </div>
          <button
            type="submit"
            data-testid="patient-login-verify"
            disabled={busy}
            className="inline-flex h-11 w-full min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              data-testid="patient-login-back"
              onClick={() => {
                setStep("phone");
                setOtp("");
                setError(null);
                setInfo(null);
              }}
              className="inline-flex h-11 min-w-[44px] items-center text-slate-700 underline-offset-2 hover:underline"
            >
              Change number
            </button>
            <button
              type="button"
              data-testid="patient-login-resend"
              onClick={resend}
              disabled={busy}
              className="inline-flex h-11 min-w-[44px] items-center text-slate-700 underline-offset-2 hover:underline disabled:opacity-60"
            >
              Resend code
            </button>
          </div>
        </form>
      )}

      {error ? (
        <p
          role="alert"
          data-testid="patient-login-error"
          className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}
      {info && !error ? (
        <p
          data-testid="patient-login-info"
          className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {info}
        </p>
      ) : null}

      <p className="text-center text-sm text-slate-600">New patient? <a href="/patient/register" data-testid="patient-login-register-link" className="font-medium text-slate-900 underline-offset-2 hover:underline">Create an account</a></p>
    </section>
  );
}
