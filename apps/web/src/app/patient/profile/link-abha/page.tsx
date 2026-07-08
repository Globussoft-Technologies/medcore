"use client";

// Patient self-service "Link ABHA via Aadhaar OTP".
//
// What: an authenticated patient links their ABHA (Ayushman Bharat Health
//   Account) to their own record using an Aadhaar OTP — either creating a NEW
//   ABHA or connecting an EXISTING one. Mirrors the public pre-login booking
//   Aadhaar flow (apps/web/.../book/page.tsx) but runs authenticated (cookie
//   auth via `api.*`) and finishes by binding the OTP-verified ABHA to the
//   caller's Patient row.
// Which: hits the M1 ABDM routes on /api/v1/abdm/abha/* —
//   enrol/request-otp + enrol/verify-otp (new), login/request-otp +
//   login/verify-otp (existing), then enrol/link-self to persist.
// Why: the profile "Link ABHA (Aadhaar OTP)" CTA pointed here but the page
//   didn't exist (404). The real Aadhaar-OTP engine + sandbox creds already
//   exist server-side; this is the missing patient-facing surface.
//
// Security note: the Aadhaar number is sent once to request the OTP and is
// never stored in the browser; the ABDM X-Token stays server-side (we only
// ever hold an opaque sessionId).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

type Mode = "new" | "existing";
type Stage = "aadhaar" | "otp" | "done";

interface AbhaProfile {
  abhaNumber?: string | null;
  abhaAddress?: string | null;
  name?: string | null;
  gender?: string | null;
  dob?: string | null;
}

export default function LinkAbhaPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("new");
  const [stage, setStage] = useState<Stage>("aadhaar");
  const [aadhaar, setAadhaar] = useState("");
  const [otp, setOtp] = useState("");
  const [mobile, setMobile] = useState("");
  const [txnId, setTxnId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [profile, setProfile] = useState<AbhaProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestPath =
    mode === "new" ? "/abdm/abha/enrol/request-otp" : "/abdm/abha/login/request-otp";
  const verifyPath =
    mode === "new" ? "/abdm/abha/enrol/verify-otp" : "/abdm/abha/login/verify-otp";

  function resetToStart(nextMode?: Mode) {
    if (nextMode) setMode(nextMode);
    setStage("aadhaar");
    setOtp("");
    setTxnId("");
    setSessionId("");
    setProfile(null);
    setError(null);
  }

  async function requestOtp() {
    setError(null);
    const digits = aadhaar.replace(/\D/g, "");
    if (!/^\d{12}$/.test(digits)) {
      setError("Enter a valid 12-digit Aadhaar number.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ data: { txnId: string } }>(requestPath, {
        aadhaar: digits,
      });
      if (!res.data?.txnId) throw new Error("Could not send the Aadhaar OTP. Try again.");
      setTxnId(res.data.txnId);
      setStage("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the OTP.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyAndLink() {
    setError(null);
    if (!/^\d{4,8}$/.test(otp.trim())) {
      setError("Enter the OTP sent to your Aadhaar-linked mobile.");
      return;
    }
    // Enrolment (new ABHA) needs the mobile to attach; login does not.
    const mob = mobile.replace(/\D/g, "");
    if (mode === "new" && !/^\d{10}$/.test(mob)) {
      setError("Enter the 10-digit mobile to link with this new ABHA.");
      return;
    }
    setBusy(true);
    try {
      // 1. Verify the OTP → server stashes the X-Token, returns sessionId + profile.
      const verifyBody: Record<string, string> =
        mode === "new"
          ? { txnId, otp: otp.trim(), mobile: mob }
          : { txnId, otp: otp.trim() };
      const verifyRes = await api.post<{
        data: { profile: AbhaProfile; sessionId: string | null };
      }>(verifyPath, verifyBody);
      const sid = verifyRes.data?.sessionId;
      if (!sid) throw new Error("ABDM did not return a valid session. Please try again.");
      setSessionId(sid);
      setProfile(verifyRes.data.profile ?? null);

      // 2. Bind the verified ABHA to MY patient record.
      const linkRes = await api.post<{ data: { profile: AbhaProfile } }>(
        "/abdm/abha/enrol/link-self",
        { sessionId: sid },
      );
      setProfile(linkRes.data?.profile ?? verifyRes.data.profile ?? null);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify the OTP.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <Link
        href="/patient/profile"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to profile
      </Link>

      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          Link ABHA with Aadhaar OTP
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Securely link your Ayushman Bharat Health Account. Your Aadhaar is
          encrypted, never stored, and the OTP is sent to your Aadhaar-linked
          mobile.
        </p>

        {stage === "done" ? (
          <div
            data-testid="link-abha-success"
            className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200"
          >
            <ShieldCheck className="h-8 w-8" />
            <p className="mt-2 text-base font-semibold">ABHA linked to your record</p>
            <dl className="mt-3 space-y-1">
              {profile?.name ? <DoneRow label="Name" value={profile.name} /> : null}
              {profile?.abhaNumber ? (
                <DoneRow label="ABHA number" value={profile.abhaNumber} />
              ) : null}
              {profile?.abhaAddress ? (
                <DoneRow label="ABHA address" value={profile.abhaAddress} />
              ) : null}
            </dl>
            <button
              type="button"
              onClick={() => router.push("/patient/profile")}
              className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Mode: create new ABHA vs link an existing one. */}
            <div className="mt-5 grid grid-cols-2 gap-2">
              {(["new", "existing"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  data-testid={`link-abha-mode-${m}`}
                  onClick={() => resetToStart(m)}
                  disabled={busy}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                    mode === m
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                  }`}
                >
                  {m === "new" ? "Create new ABHA" : "Link existing ABHA"}
                </button>
              ))}
            </div>

            {stage === "aadhaar" ? (
              <div className="mt-5 space-y-3">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Aadhaar number
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  data-testid="link-abha-aadhaar"
                  value={aadhaar}
                  onChange={(e) => setAadhaar(e.target.value)}
                  placeholder="12-digit Aadhaar"
                  maxLength={14}
                  className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
                {error ? <ErrorNote>{error}</ErrorNote> : null}
                <button
                  type="button"
                  data-testid="link-abha-send-otp"
                  onClick={() => void requestOtp()}
                  disabled={busy}
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Send OTP
                </button>
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {mode === "new" ? (
                  <>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                      Mobile to link
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      data-testid="link-abha-mobile"
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      placeholder="10-digit mobile"
                      maxLength={10}
                      className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                    />
                  </>
                ) : null}
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
                  OTP
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  data-testid="link-abha-otp"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="Enter OTP"
                  maxLength={8}
                  className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
                {error ? <ErrorNote>{error}</ErrorNote> : null}
                <button
                  type="button"
                  data-testid="link-abha-verify"
                  onClick={() => void verifyAndLink()}
                  disabled={busy}
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Verify &amp; link
                </button>
                <button
                  type="button"
                  onClick={() => resetToStart()}
                  disabled={busy}
                  className="w-full text-center text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400"
                >
                  Start over
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DoneRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-emerald-100 pb-1 dark:border-emerald-900/50">
      <dt className="text-emerald-700 dark:text-emerald-300">{label}</dt>
      <dd className="font-medium text-emerald-900 dark:text-emerald-100">{value}</dd>
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      data-testid="link-abha-error"
      className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
