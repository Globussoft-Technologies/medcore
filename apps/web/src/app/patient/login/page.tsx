"use client";

// Patient phone-OTP login page — Firebase Phone Authentication.
//
// Replaces the old server-issued SMS-OTP flow (POST /patient-auth/otp-request
// + /patient-auth/otp-verify). Firebase handles SMS delivery + code
// generation; our backend only verifies the resulting Firebase ID token and
// mints the medcore_at / medcore_rt session cookies via
// POST /patient-auth/firebase-verify. That preserves the existing audit log,
// tenant scoping, rate limiting, and BOLA defenses — only the OTP transport
// changed.
//
// Two-step flow:
//   1. Phone input → ensureRecaptcha() + sendOtp(phoneE164) → step 2.
//   2. OTP input → verifyOtp(code) → POST the Firebase ID token to our API
//      → server mints cookies → router.push('/patient/dashboard').
//
// reCAPTCHA: Firebase requires a bot-check before sending the SMS. We mount
// an INVISIBLE verifier under #patient-recaptcha so the user never sees the
// widget unless Firebase decides they look like a bot.
//
// Touch targets remain h-11 (44px) per Pearl §6.2. All testids prefixed
// `patient-login-*` are preserved from the old flow so component-level
// smoke tests don't need to relearn them (the integration tests pinning
// /patient-auth/otp-request URLs DO need to be rewritten — see
// __tests__/page.test.tsx; they assume the old transport).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import {
  ensureRecaptcha,
  disposeRecaptcha,
  sendOtp,
  verifyOtp,
  resetPhoneAuthState,
} from "@/lib/firebase";

type Step = "phone" | "otp";

interface FirebaseVerifyResponse {
  success: boolean;
  data?: {
    user?: { id: string; name: string; role: string; phone: string };
  } | null;
  error?: string | null;
}

// Accept either 10-digit (assume +91), 12-digit starting +91, or any valid
// E.164 — Firebase requires E.164 so we'll normalise before sending.
function normaliseToE164(input: string): string | null {
  const trimmed = input.trim().replace(/[\s-]/g, "");
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;
  if (/^\d{10}$/.test(trimmed)) return `+91${trimmed}`; // India default
  return null;
}

export default function PatientLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Remember the normalised E.164 across the two steps so the verify step
  // doesn't depend on whatever the user might have typed into the phone
  // input in the meantime.
  const e164Ref = useRef<string | null>(null);

  // Mount the invisible reCAPTCHA verifier on first render. Cleanup on
  // unmount so a fresh widget gets installed on the next visit (Firebase
  // attaches DOM state to the container).
  useEffect(() => {
    try {
      ensureRecaptcha("patient-recaptcha");
    } catch (err) {
      // Misconfigured env vars throw inside Firebase init. Surface as the
      // first error the user sees rather than letting the page render
      // half-broken.
      setError(
        err instanceof Error
          ? err.message
          : "Patient sign-in is unavailable right now.",
      );
    }
    return () => {
      disposeRecaptcha();
      resetPhoneAuthState();
    };
  }, []);

  async function sendCode(): Promise<void> {
    if (busy) return;
    setError(null);
    setInfo(null);
    const e164 = normaliseToE164(phone);
    if (!e164) {
      setError(
        "Enter a valid phone number — 10 digits for India, or full +country code (e.g. +91 9876543210).",
      );
      return;
    }
    setBusy(true);
    try {
      await sendOtp(e164);
      e164Ref.current = e164;
      setStep("otp");
      setInfo("A 6-digit code has been sent to your phone.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send code");
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
      // Step A — confirm with Firebase, get ID token.
      const idToken = await verifyOtp(otp.trim());
      // Step B — hand the ID token to our backend so it can verify with
      // firebase-admin, look up the Patient by phone, and mint our session
      // cookies. The server is the only thing that should be issuing
      // medcore_at / medcore_rt — we don't store the Firebase token
      // anywhere client-side (no localStorage), it's just a one-shot
      // bearer to the exchange endpoint.
      const res = await api.post<FirebaseVerifyResponse>(
        "/patient-auth/firebase-verify",
        { idToken },
      );
      if (res?.success) {
        // Cookies set by server response — bounce to dashboard.
        router.push("/patient/dashboard");
      } else {
        setError(res?.error || "Couldn't sign you in. Please try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't verify code");
    } finally {
      setBusy(false);
    }
  }

  async function resend(): Promise<void> {
    // Send a fresh code for the SAME normalised E.164. resetPhoneAuthState
    // first so any stale ConfirmationResult isn't reused.
    resetPhoneAuthState();
    setOtp("");
    await sendCode();
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
              placeholder="+91 9876543210"
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
                resetPhoneAuthState();
              }}
              className="inline-flex h-11 min-w-[44px] items-center text-slate-700 underline-offset-2 hover:underline"
            >
              Change number
            </button>
            <button
              type="button"
              data-testid="patient-login-resend"
              onClick={() => void resend()}
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

      <p className="text-center text-sm text-slate-600">
        New patient?{" "}
        <a
          href="/patient/register"
          data-testid="patient-login-register-link"
          className="font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          Create an account
        </a>
      </p>

      {/* Invisible reCAPTCHA container — Firebase mounts the widget here.
          Must exist in the DOM before ensureRecaptcha() runs (the effect
          above schedules that after first paint). */}
      <div id="patient-recaptcha" />
    </section>
  );
}
