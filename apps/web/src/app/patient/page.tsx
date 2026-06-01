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
import {
  ArrowRight,
  CalendarCheck,
  FileText,
  Receipt,
  HeartPulse,
  Sparkles,
  Shield,
  CheckCircle2,
} from "lucide-react";
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
        // CLS hardening: top-anchor the spinner with roughly the hero's
        // above-the-fold offset (the hero's `py-16 sm:py-24` lands its first
        // content ~8rem down) and reserve full height, so when the probe
        // settles and the marketing surface swaps in, first-viewport content
        // doesn't jump from a vertically-centered spinner to a top-anchored
        // hero. This is the unauthed surface Lighthouse measures, where the
        // centered→top reflow was driving Cumulative Layout Shift.
        className="flex min-h-screen w-full flex-1 items-start justify-center pt-32 text-sm text-gray-500 dark:text-gray-400"
      >
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          Loading…
        </div>
      </section>
    );
  }

  return (
    <section className="w-full flex-1">
      {/* HERO */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.12),transparent_60%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.2),transparent_60%)]" />
        <div className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-1.5 text-sm font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
            <Sparkles className="h-4 w-4" />
            Your care, in your pocket
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-6xl dark:text-white">
            Welcome to your
            <br />
            <span className="bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text text-transparent">
              Patient Portal.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-600 dark:text-gray-400">
            Sign in to view your appointments, prescriptions, bills, and medical
            records — all in one secure place.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/patient/login"
              data-testid="patient-landing-signin"
              className="group inline-flex h-12 min-w-11 items-center justify-center gap-2 rounded-full bg-blue-600 px-7 text-base font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700"
            >
              Sign in
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/patient/register"
              data-testid="patient-landing-register"
              className="inline-flex h-12 min-w-11 items-center justify-center rounded-full border border-gray-300 bg-white px-7 text-base font-semibold text-gray-800 transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
            >
              Create account
            </Link>
          </div>
          <p className="mt-6 inline-flex items-center justify-center gap-1.5 text-xs text-gray-500 dark:text-gray-500">
            <Shield className="h-3.5 w-3.5 text-emerald-500" />
            DPDP Act 2023 compliant — your data stays in India.
          </p>
        </div>
      </div>

      {/* WHAT YOU CAN DO */}
      <div className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: CalendarCheck,
              title: "Book appointments",
              desc: "See real-time OPD availability and book in a few taps. Get your live token & wait estimate.",
            },
            {
              icon: FileText,
              title: "Prescriptions & lab reports",
              desc: "Every prescription comes with a tamper-proof QR. Lab reports arrive as soon as they're verified.",
            },
            {
              icon: Receipt,
              title: "Bills & UPI payments",
              desc: "View GST-aware invoices, pay with UPI or card, and download receipts instantly.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                <f.icon className="h-6 w-6" />
              </div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                {f.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                {f.desc}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-2xl border border-gray-200 bg-gradient-to-br from-blue-50 via-white to-emerald-50 p-6 sm:p-8 dark:border-gray-800 dark:from-blue-950/30 dark:via-gray-900 dark:to-emerald-950/30">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-emerald-500 text-white shadow-sm shadow-blue-600/20">
                <HeartPulse className="h-6 w-6" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Get started in under a minute
                </h2>
                <ul className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                  {[
                    "8 Indian languages supported",
                    "Self-serve DPDP data export",
                    "Works offline with the PWA",
                  ].map((b) => (
                    <li key={b} className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <Link
              href="/patient/register"
              className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-full bg-blue-600 px-6 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
            >
              Create account
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
