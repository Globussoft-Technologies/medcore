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
import {
  Phone,
  KeyRound,
  ArrowRight,
  Shield,
  Sparkles,
  HeartPulse,
  CheckCircle2,
} from "lucide-react";
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
  // Identity is keyed on (phone + name) — duplicate phones are allowed, so we
  // collect the name to disambiguate which account to open after OTP.
  const [name, setName] = useState("");
  // Login identity is keyed on (phone + name + hospital). The patient picks
  // which hospital their account is at; the server only signs them in if a
  // matching patient exists in that tenant.
  const [tenantId, setTenantId] = useState("");
  const [hospitals, setHospitals] = useState<
    Array<{ id: string; name: string; code: string | null }>
  >([]);
  const [hospitalsLoading, setHospitalsLoading] = useState(true);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when login fails because no patient exists at the selected hospital —
  // drives the inline "Register" call-to-action.
  const [noAccount, setNoAccount] = useState(false);
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

  // Load the hospital/clinic list for the "Select Hospital" dropdown from the
  // API (GET /public/hospitals) — never hardcoded. If there's exactly one
  // tenant, preselect it. Always clears the loading flag so the dropdown
  // renders even on failure, and re-runs on every mount (including
  // back-navigation from /patient/register) so the field is never missing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{
          data: Array<{ id: string; name: string; code: string | null }>;
        }>("/public/hospitals");
        if (cancelled) return;
        const list = res.data ?? [];
        setHospitals(list);
        if (list.length === 1) setTenantId(list[0].id);
      } catch {
        // Non-fatal: server falls back to phone+name when no hospital sent.
      } finally {
        if (!cancelled) setHospitalsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function sendCode(): Promise<void> {
    if (busy) return;
    setError(null);
    setNoAccount(false);
    setInfo(null);
    if (hospitals.length > 0 && !tenantId) {
      setError("Select your hospital or clinic.");
      return;
    }
    if (name.trim().length < 2) {
      setError("Enter the name on your account.");
      return;
    }
    const e164 = normaliseToE164(phone);
    if (!e164) {
      setError(
        "Enter a valid phone number — 10 digits for India, or full +country code (e.g. +91 9876543210).",
      );
      return;
    }
    setBusy(true);
    try {
      // Pre-check BEFORE sending an OTP: does a patient with this
      // (name + phone) exist at the selected hospital? No point texting a
      // code to someone who has no account — tell them to register instead.
      // Reuses /auth/check-availability, which returns `namePhoneTaken`
      // (true when that name+phone already exists in the tenant).
      try {
        const chk = await api.post<{
          data: { namePhoneTaken: boolean };
        }>("/auth/check-availability", {
          name: name.trim(),
          phone: phone.trim(),
          tenantId: tenantId || undefined,
        });
        if (chk?.data && chk.data.namePhoneTaken === false) {
          setNoAccount(true);
          setError(
            "You don't have an account at the selected hospital. Please register first.",
          );
          return; // do NOT send the OTP
        }
      } catch {
        // If the pre-check itself fails (network/rate-limit), don't block
        // login — fall through to OTP; the verify step still enforces the
        // (phone + name + tenant) match server-side.
      }

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
        { idToken, name: name.trim(), tenantId: tenantId || undefined },
        // Opt out of the api lib's global 401 handler: a 401 here means
        // "this phone isn't registered / token rejected", NOT an expired
        // session. Without this, the generic "Your session has expired"
        // toast fires and the page bounces to /login, masking the real
        // reason. We surface the server's own message inline instead.
        { skip401Redirect: true },
      );
      if (res?.success) {
        // Cookies set by server response — bounce to dashboard.
        router.push("/patient/dashboard");
      } else {
        setError(res?.error || "Couldn't sign you in. Please try again.");
      }
    } catch (err) {
      // 404 NO_ACCOUNT → no patient at the selected hospital; nudge to
      // register. Any other error surfaces its own message.
      const e = err as Error & {
        status?: number;
        payload?: { code?: string; error?: string };
      };
      if (e?.status === 404 && e?.payload?.code === "NO_ACCOUNT") {
        setNoAccount(true);
        setError(
          e.payload.error ||
            "You don't have an account at the selected hospital. Please register first.",
        );
      } else {
        setError(e instanceof Error ? e.message : "Couldn't verify code");
      }
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
    <section
      className="grid w-full flex-1 items-stretch lg:grid-cols-2"
      data-testid="patient-login-shell"
    >
      {/* LEFT — brand panel (hidden on mobile; the form is what matters on phone) */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-blue-600 via-blue-700 to-emerald-600 px-10 py-16 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute inset-0 -z-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.18),transparent_60%)]" />
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wider backdrop-blur-sm">
            {/* <Sparkles className="h-3.5 w-3.5" /> */}
            Your care, in your pocket
          </div>
          <h2 className="mt-6 text-4xl font-extrabold leading-tight tracking-tight">
            Welcome back.
            <br />
            <span className="bg-gradient-to-r from-white to-emerald-200 bg-clip-text text-transparent">
              Sign in securely.
            </span>
          </h2>
          <p className="mt-5 max-w-md text-base leading-relaxed text-blue-50/90">
            One-time codes over SMS — no passwords to remember. Access your
            appointments, prescriptions, lab reports and bills, all in one place.
          </p>
        </div>
        <ul className="relative z-10 mt-10 space-y-3 text-sm text-blue-50/90">
          {[
            "Live OPD token & wait time",
            "Prescriptions with QR verification",
            "Lab reports as soon as they're ready",
            "Pay bills with UPI in seconds",
          ].map((f) => (
            <li key={f} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-300" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* RIGHT — auth card */}
      <div className="flex items-center justify-center px-4 py-12 sm:px-6 lg:px-12">
        <div className="w-full max-w-md">
          {/* Mobile-only compact brand banner (the desktop aside is hidden < lg) */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-emerald-500 text-white shadow-sm shadow-blue-600/20">
              <HeartPulse className="h-6 w-6" />
            </span>
            <div>
              <div className="text-base font-semibold tracking-tight text-gray-900 dark:text-white">
                MedCore Patient Portal
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Your care, in your pocket
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <header className="space-y-2">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
                {step === "phone" ? (
                  <>
                    <Phone className="h-3.5 w-3.5" /> Step 1 of 2
                  </>
                ) : (
                  <>
                    <KeyRound className="h-3.5 w-3.5" /> Step 2 of 2
                  </>
                )}
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                Sign in
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {step === "phone"
                  ? "Enter your phone number to receive a one-time code."
                  : "Enter the 6-digit code we just sent to your phone."}
              </p>
            </header>

            <div className="mt-6">
              {step === "phone" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendCode();
                  }}
                  className="space-y-5"
                >
                  <div className="space-y-1.5">
                    <label
                      htmlFor="patient-login-hospital"
                      className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                    >
                      Hospital / Clinic
                    </label>
                    <select
                      id="patient-login-hospital"
                      data-testid="patient-login-hospital-select"
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                      disabled={busy || hospitalsLoading}
                      className="block h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 transition focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    >
                      <option value="">
                        {hospitalsLoading
                          ? "Loading hospitals…"
                          : hospitals.length === 0
                            ? "No hospitals available"
                            : "Select your hospital…"}
                      </option>
                      {hospitals.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                          {h.code ? ` (${h.code})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="patient-login-name"
                      className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                    >
                      Full name
                    </label>
                    <input
                      id="patient-login-name"
                      data-testid="patient-login-name-input"
                      type="text"
                      autoComplete="name"
                      className="block h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      placeholder="Name on your account"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy}
                      required
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-500">
                      Must match the name on your account.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="patient-login-phone"
                      className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                    >
                      Phone number
                    </label>
                    <div className="relative">
                      <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        id="patient-login-phone"
                        data-testid="patient-login-phone-input"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        className="block h-12 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-3 text-base text-gray-900 placeholder:text-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                        placeholder="+91 9876543210"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        disabled={busy}
                        required
                      />
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-500">
                      10 digits for India, or full +country code.
                    </p>
                  </div>
                  <button
                    type="submit"
                    data-testid="patient-login-send-code"
                    disabled={busy}
                    className="group inline-flex h-12 w-full min-w-[44px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? (
                      "Sending…"
                    ) : (
                      <>
                        Send code
                        <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                      </>
                    )}
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void verifyCode();
                  }}
                  className="space-y-5"
                >
                  <div className="space-y-1.5">
                    <label
                      htmlFor="patient-login-otp"
                      className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                    >
                      6-digit code
                    </label>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        id="patient-login-otp"
                        data-testid="patient-login-otp-input"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        className="block h-12 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-3 text-center text-lg font-semibold tracking-[0.5em] text-gray-900 placeholder:text-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                        placeholder="••••••"
                        value={otp}
                        onChange={(e) =>
                          setOtp(e.target.value.replace(/\D/g, ""))
                        }
                        disabled={busy}
                        required
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    data-testid="patient-login-verify"
                    disabled={busy}
                    className="inline-flex h-12 w-full min-w-[44px] items-center justify-center rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? "Verifying…" : "Verify & continue"}
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
                      className="inline-flex h-11 min-w-[44px] items-center text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                    >
                      Change number
                    </button>
                    <button
                      type="button"
                      data-testid="patient-login-resend"
                      onClick={() => void resend()}
                      disabled={busy}
                      className="inline-flex h-11 min-w-[44px] items-center text-blue-600 underline-offset-4 hover:underline disabled:opacity-60 dark:text-blue-400"
                    >
                      Resend code
                    </button>
                  </div>
                </form>
              )}
            </div>

            {error ? (
              <div
                role="alert"
                data-testid="patient-login-error"
                className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                <p>{error}</p>
                {noAccount ? (
                  <a
                    href="/patient/register"
                    data-testid="patient-login-register-link"
                    className="mt-2 inline-block font-semibold text-red-700 underline hover:text-red-900 dark:text-red-200"
                  >
                    Register a new account →
                  </a>
                ) : null}
              </div>
            ) : null}
            {info && !error ? (
              <p
                data-testid="patient-login-info"
                className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300"
              >
                {info}
              </p>
            ) : null}

            <div className="mt-6 border-t border-gray-100 pt-5 dark:border-gray-800">
              <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                New patient?{" "}
                <a
                  href="/patient/register"
                  data-testid="patient-login-register-link"
                  className="font-semibold text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                >
                  Create an account
                </a>
              </p>
            </div>
          </div>

          <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-gray-500 dark:text-gray-500">
            <Shield className="h-3.5 w-3.5 text-emerald-500" />
            Protected by end-to-end encryption. Your data stays in India.
          </p>

          {/* Invisible reCAPTCHA container — Firebase mounts the widget here.
              Must exist in the DOM before ensureRecaptcha() runs (the effect
              above schedules that after first paint). */}
          <div id="patient-recaptcha" />
        </div>
      </div>
    </section>
  );
}
