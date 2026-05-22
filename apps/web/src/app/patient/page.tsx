"use client";

// Patient PWA landing page (Pearl §6.1 — gap #5 piece 1 of 4 + piece 3a).
//
// Two surfaces, picked by a one-shot /auth/me probe on mount:
//   - Unauthed (no cookie / 401): the original welcome marketing surface
//     with a "Sign in" CTA → /patient/login. Same shape as piece 1 shipped.
//   - Authed (cookie valid, role PATIENT): bounce to /patient/dashboard so
//     the post-login `router.push("/patient")` from login/page.tsx lands
//     on a real surface instead of the welcome page.
//
// We intentionally do this client-side rather than via apps/web/middleware
// because there's no Next middleware in this repo today, and the patient
// JWT lives in an httpOnly cookie that a server component can't read
// without a full session-loader (which would couple the patient surface
// to the staff dashboard's session machinery).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";

interface MeResponse {
  success: boolean;
  data?: {
    user?: { id: string; role?: string };
  } | null;
}

type Phase = "probing" | "unauthed";

export default function PatientLandingPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("probing");

  useEffect(() => {
    let cancelled = false;
    async function probe(): Promise<void> {
      try {
        const res = await api.get<MeResponse>("/auth/me", {
          skip401Redirect: true,
        });
        if (cancelled) return;
        if (res?.success && res.data?.user?.role === "PATIENT") {
          router.replace("/patient/dashboard");
          return;
        }
        setPhase("unauthed");
      } catch {
        if (!cancelled) setPhase("unauthed");
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (phase === "probing") {
    return (
      <section
        data-testid="patient-landing-probing"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"
      >
        Loading…
      </section>
    );
  }

  return (
    <section className="space-y-6 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to your Patient Portal
        </h1>
        <p className="text-base text-slate-600">
          Sign in to your account to view appointments, prescriptions, bills,
          and medical records — all in one place.
        </p>
      </header>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-landing-signin"
        >
          Sign in
        </Link>
        <button
          type="button"
          disabled
          title="Available after sign in"
          className="inline-flex h-11 min-w-[44px] cursor-not-allowed items-center justify-center rounded-md border border-slate-300 px-6 text-sm font-medium text-slate-400"
          data-testid="patient-landing-book"
        >
          Book an appointment
        </button>
      </div>
    </section>
  );
}
