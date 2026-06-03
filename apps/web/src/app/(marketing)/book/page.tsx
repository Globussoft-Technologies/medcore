"use client";

// Public quick-appointment booking (June 2026).
//
// A no-login booking flow reachable from the marketing nav ("Book appointment").
// Three short steps, minimal input — matches the marketing site's blue/emerald
// styling:
//   1. Symptom + date  → POST /public/booking/suggest-doctors
//   2. Pick a suggested doctor + an open slot
//   3. Name + WhatsApp number → POST /public/booking/book
//      (auto-registers the patient by phone, sends a WhatsApp confirmation,
//       and the patient can sign in later with the same number)
//
// Calls the PUBLIC endpoints with bare fetch (NOT the @/lib/api client, which
// attaches auth cookies/CSRF we don't want on an unauthenticated surface).

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  Calendar,
  Stethoscope,
  Clock,
  Phone,
  User,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Star,
} from "lucide-react";
import { Container } from "../_components/Container";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

interface DoctorSuggestion {
  doctorId: string;
  name: string;
  specialization: string | null;
  experienceYears: number | null;
  averageRating: number | null;
  consultationFee: number | null;
  slots: string[];
}

type Step = "symptom" | "doctor" | "details" | "done";

// Next 7 days for the date strip (mirrors the Pearl day-picker shape).
function nextDays(count: number): { iso: string; weekday: string; day: string }[] {
  const out: { iso: string; weekday: string; day: string }[] = [];
  const base = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({
      iso,
      weekday: d.toLocaleDateString("en-IN", { weekday: "short" }),
      day: String(d.getDate()).padStart(2, "0"),
    });
  }
  return out;
}

export default function QuickBookPage() {
  const days = nextDays(7);

  const [step, setStep] = useState<Step>("symptom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [symptom, setSymptom] = useState("");
  const [date, setDate] = useState(days[0].iso);
  const [doctors, setDoctors] = useState<DoctorSuggestion[]>([]);

  const [selectedDoctor, setSelectedDoctor] = useState<DoctorSuggestion | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  const [confirmation, setConfirmation] = useState<{
    doctorName: string;
    date: string;
    slotStart: string | null;
    displayToken: string | null;
  } | null>(null);

  async function findDoctors() {
    setError(null);
    if (symptom.trim().length < 2) {
      setError("Please tell us your symptom or who you'd like to see.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/public/booking/suggest-doctors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symptom: symptom.trim(), date }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Couldn't find doctors. Please try again.");
        return;
      }
      const list: DoctorSuggestion[] = json.data?.doctors ?? [];
      if (list.length === 0) {
        setError(
          "No doctors are available on that date. Try a different day.",
        );
        setDoctors([]);
        return;
      }
      setDoctors(list);
      setStep("doctor");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmBooking() {
    setError(null);
    if (!selectedDoctor || !selectedSlot) {
      setError("Please pick a doctor and a time slot.");
      return;
    }
    if (name.trim().length < 2) {
      setError("Please enter your name.");
      return;
    }
    if (!/^[+]?[\d\s-]{10,15}$/.test(phone.trim())) {
      setError("Enter a valid 10–15 digit WhatsApp number.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/public/booking/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          doctorId: selectedDoctor.doctorId,
          date,
          slotId: selectedSlot,
          symptom: symptom.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Couldn't complete your booking. Please try again.");
        return;
      }
      setConfirmation({
        doctorName: json.data.doctorName,
        date: json.data.date,
        slotStart: json.data.slotStart,
        displayToken: json.data.displayToken,
      });
      setStep("done");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const primaryBtn =
    "inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";
  const ghostBtn =
    "inline-flex items-center justify-center gap-2 rounded-full border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800";
  const inputCls =
    "w-full rounded-xl border border-gray-300 px-4 py-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100";

  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.12),transparent_60%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.2),transparent_60%)]" />
      <Container className="py-16 md:py-20">
        <div className="mx-auto max-w-2xl">
          <div className="mb-8 text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-1.5 text-sm font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
              <Activity className="h-4 w-4" />
              Book in under a minute — no account needed
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 sm:text-4xl dark:text-white">
              Book your{" "}
              <span className="bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text text-transparent">
                appointment
              </span>
            </h1>
            <p className="mx-auto mt-3 max-w-md text-gray-600 dark:text-gray-400">
              Tell us what's wrong, pick a doctor and time, and we'll text your
              confirmation on WhatsApp.
            </p>
          </div>

          <div
            data-testid="quick-book-card"
            className="rounded-3xl border border-gray-200 bg-white p-6 shadow-xl sm:p-8 dark:border-gray-800 dark:bg-gray-900"
          >
            {/* Step indicator */}
            <ol className="mb-6 flex items-center justify-center gap-2 text-xs font-medium">
              {(["symptom", "doctor", "details"] as Step[]).map((s, i) => {
                const order = ["symptom", "doctor", "details", "done"];
                const active = step === s;
                const done = order.indexOf(step) > i;
                return (
                  <li key={s} className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                        active
                          ? "bg-blue-600 text-white"
                          : done
                            ? "bg-emerald-500 text-white"
                            : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                    </span>
                    {i < 2 && <span className="h-px w-6 bg-gray-200 dark:bg-gray-800" />}
                  </li>
                );
              })}
            </ol>

            {error && (
              <p
                role="alert"
                data-testid="quick-book-error"
                className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                {error}
              </p>
            )}

            {/* ── Step 1: symptom + date ── */}
            {step === "symptom" && (
              <div className="space-y-5">
                <div>
                  <label
                    htmlFor="qb-symptom"
                    className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    <Stethoscope className="h-4 w-4 text-blue-600" />
                    What brings you in?
                  </label>
                  <input
                    id="qb-symptom"
                    data-testid="quick-book-symptom"
                    type="text"
                    value={symptom}
                    onChange={(e) => setSymptom(e.target.value)}
                    placeholder="e.g. fever and cough, skin rash, or 'general doctor'"
                    className={inputCls}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void findDoctors();
                    }}
                  />
                </div>
                <div>
                  <span className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200">
                    <Calendar className="h-4 w-4 text-blue-600" />
                    Pick a date
                  </span>
                  <div className="flex flex-wrap gap-2" data-testid="quick-book-dates">
                    {days.map((d) => (
                      <button
                        key={d.iso}
                        type="button"
                        onClick={() => setDate(d.iso)}
                        data-testid={`quick-book-date-${d.iso}`}
                        className={`flex w-14 flex-col items-center rounded-xl border px-2 py-2 text-center transition ${
                          date === d.iso
                            ? "border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                            : "border-gray-200 text-gray-600 hover:border-blue-300 dark:border-gray-700 dark:text-gray-300"
                        }`}
                      >
                        <span className="text-[11px] uppercase">{d.weekday}</span>
                        <span className="text-lg font-bold">{d.day}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="quick-book-find"
                  disabled={busy}
                  onClick={() => void findDoctors()}
                  className={`${primaryBtn} w-full`}
                >
                  {busy ? "Finding doctors…" : "Find a doctor"}
                  {!busy && <ArrowRight className="h-4 w-4" />}
                </button>
              </div>
            )}

            {/* ── Step 2: pick doctor + slot ── */}
            {step === "doctor" && (
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Available doctors for{" "}
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {new Date(date).toLocaleDateString("en-IN", {
                      weekday: "long",
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                  :
                </p>
                <div className="space-y-3" data-testid="quick-book-doctors">
                  {doctors.map((d) => {
                    const picked = selectedDoctor?.doctorId === d.doctorId;
                    return (
                      <div
                        key={d.doctorId}
                        data-testid={`quick-book-doctor-${d.doctorId}`}
                        className={`rounded-2xl border p-4 transition ${
                          picked
                            ? "border-blue-600 bg-blue-50/40 dark:bg-blue-950/30"
                            : "border-gray-200 dark:border-gray-700"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDoctor(d);
                            setSelectedSlot(null);
                          }}
                          className="flex w-full items-start justify-between gap-3 text-left"
                        >
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900 dark:text-gray-100">
                              {d.name}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {d.specialization ?? "General"}
                              {d.experienceYears
                                ? ` · ${d.experienceYears} yrs exp`
                                : ""}
                            </p>
                          </div>
                          {d.averageRating ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                              <Star className="h-3 w-3 fill-current" />
                              {d.averageRating.toFixed(1)}
                            </span>
                          ) : null}
                        </button>

                        {picked && (
                          <div className="mt-3" data-testid="quick-book-slots">
                            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                              <Clock className="h-3.5 w-3.5 text-blue-600" />
                              Pick a time
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {d.slots.map((s) => (
                                <button
                                  key={s}
                                  type="button"
                                  data-testid={`quick-book-slot-${s}`}
                                  onClick={() => setSelectedSlot(s)}
                                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                                    selectedSlot === s
                                      ? "border-blue-600 bg-blue-600 text-white"
                                      : "border-gray-300 text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-200"
                                  }`}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setStep("symptom")}
                    className={ghostBtn}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    type="button"
                    data-testid="quick-book-to-details"
                    disabled={!selectedDoctor || !selectedSlot}
                    onClick={() => setStep("details")}
                    className={primaryBtn}
                  >
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {/* ── Step 3: name + phone ── */}
            {step === "details" && (
              <div className="space-y-5">
                <div className="rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-800/60">
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {selectedDoctor?.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {new Date(date).toLocaleDateString("en-IN", {
                      weekday: "long",
                      day: "numeric",
                      month: "short",
                    })}{" "}
                    at {selectedSlot}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="qb-name"
                    className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    <User className="h-4 w-4 text-blue-600" />
                    Your name
                  </label>
                  <input
                    id="qb-name"
                    data-testid="quick-book-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full name"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label
                    htmlFor="qb-phone"
                    className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    <Phone className="h-4 w-4 text-blue-600" />
                    WhatsApp number
                  </label>
                  <input
                    id="qb-phone"
                    data-testid="quick-book-phone"
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 9876543210"
                    className={inputCls}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    We'll send your confirmation here. You can sign in later with
                    this number.
                  </p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setStep("doctor")}
                    className={ghostBtn}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    type="button"
                    data-testid="quick-book-confirm"
                    disabled={busy}
                    onClick={() => void confirmBooking()}
                    className={primaryBtn}
                  >
                    {busy ? "Booking…" : "Book appointment"}
                  </button>
                </div>
              </div>
            )}

            {/* ── Done ── */}
            {step === "done" && confirmation && (
              <div className="text-center" data-testid="quick-book-done">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                  <CheckCircle2 className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
                </div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                  You're booked!
                </h2>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                  Your appointment with{" "}
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {confirmation.doctorName}
                  </span>{" "}
                  on{" "}
                  {new Date(confirmation.date).toLocaleDateString("en-IN", {
                    weekday: "long",
                    day: "numeric",
                    month: "short",
                  })}
                  {confirmation.slotStart ? ` at ${confirmation.slotStart}` : ""} is
                  confirmed.
                </p>
                {confirmation.displayToken && (
                  <p className="mt-3 inline-block rounded-full bg-blue-50 px-4 py-1.5 text-sm font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                    Token: {confirmation.displayToken}
                  </p>
                )}
                <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                  We've sent the details to your WhatsApp. Sign in anytime with your
                  phone number to view appointments and reports.
                </p>
                <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <Link href="/patient/login" className={primaryBtn}>
                    Sign in with my number
                  </Link>
                  <Link href="/" className={ghostBtn}>
                    Back to home
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}
