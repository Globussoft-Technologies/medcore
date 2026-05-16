import Link from "next/link";
import {
  CheckCircle2,
  Stethoscope,
  Building,
  Building2,
  X,
} from "lucide-react";
import { Container } from "../_components/Container";
import { CTASection } from "../_components/CTASection";

export const metadata = {
  title: "Solutions by Hospital Size",
  description:
    "MedCore adapts to small clinics, mid-size hospitals, and multi-specialty hospitals. Pick the bundle that fits your practice.",
  alternates: { canonical: "https://medcore.globusdemos.com/solutions" },
};

const solutions = [
  {
    icon: Stethoscope,
    title: "Small Clinic",
    size: "1-3 doctors",
    priceFrom: "₹9,999/mo",
    bullets: [
      "Online + walk-in appointments",
      "Digital prescriptions with QR",
      "GST-compliant billing",
      "WhatsApp reminders (DLT)",
      "Patient records and vitals",
      "Pharmacy dispense",
    ],
    cta: "Start with Starter",
  },
  {
    icon: Building,
    title: "Mid-size Hospital",
    size: "10-30 beds",
    priceFrom: "₹24,999/mo",
    bullets: [
      "Admissions, wards and bed census",
      "Lab orders and in-house pharmacy",
      "Shift roster, leaves and payroll",
      "Insurance / TPA pre-auth + claims",
      "Razorpay + UPI + payment plans",
      "Patient mobile app",
    ],
    cta: "Talk to sales",
    highlight: true,
  },
  {
    icon: Building2,
    title: "Multi-specialty",
    size: "30+ beds, multiple departments",
    priceFrom: "Contact us",
    bullets: [
      "OT scheduling and surgery workflow",
      "Emergency triage and ambulance dispatch",
      "Blood bank with component separation",
      "Multi-branch analytics and audit trail",
      "Dedicated onboarding and SLA",
      "Custom integrations (HL7, lab machines)",
    ],
    cta: "Book enterprise demo",
  },
];

export default function SolutionsPage() {
  return (
    <>
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
              Built for the <span className="text-blue-600 dark:text-blue-400">75%</span> nobody else serves.
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Corporate hospital groups have 20% of the Indian market and their
              own custom stacks. Everyone else — solo clinics, mid-sized
              hospitals, multi-specialty — is stuck choosing between 15-year-old
              desktop apps and Western SaaS that doesn&apos;t know what CGST
              means. MedCore is the modern stack built for that 75% directly,
              not as a corporate-HMS hand-me-down.
            </p>
          </div>
        </Container>
      </section>

      {/* VS CORPORATE HMS */}
      <section className="py-20">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
              The modern stack vs the legacy one
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Most hospital tech is AI features layered on top of billing
              software from 2008. We rebuilt the workflow from the ground up.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-6 dark:border-gray-800 dark:bg-gray-900/40">
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                Legacy HMS (the other guys)
              </div>
              <h3 className="mt-1 text-lg font-semibold text-gray-700 dark:text-gray-400">
                Billing software with AI bolted on
              </h3>
              <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                {[
                  "Desktop-era data models, then a SaaS wrapper",
                  "AI features = chatbot plugin, no agent handoffs",
                  "Per-module silos (billing, lab, pharmacy don't share state)",
                  "Pricing: per-bed + per-user + per-integration",
                  "Multi-month onboarding consultants",
                  "Patient app is a static brochure",
                ].map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <X className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border-2 border-blue-500 bg-blue-50/40 p-6 shadow-md shadow-blue-100 dark:border-blue-500 dark:bg-blue-950/30 dark:shadow-none">
              <div className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                MedCore — the modern stack
              </div>
              <h3 className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
                AI-native, system-of-record + action + transaction
              </h3>
              <ul className="mt-4 space-y-2 text-sm text-gray-700 dark:text-gray-300">
                {[
                  "Workflows rebuilt around AI agents, not bolted on",
                  "Named agents with one-click hand-off + audit trail",
                  "Single tenant-scoped EHR — billing, lab, pharmacy share state",
                  "Flat per-month pricing — no per-bed, no per-user, no per-integration",
                  "Self-serve onboarding wizard, live in days",
                  "Patient app with live queue, lab reports, prescription QR, bill pay",
                ].map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Container>
      </section>

      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
              Same platform. Three sizes.
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Pick the bundle. Upgrade in-place as you grow — no migration, no
              re-onboarding.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {solutions.map((s) => {
              const Icon = s.icon;
              return (
                <div
                  key={s.title}
                  className={`relative flex flex-col rounded-2xl border p-7 shadow-sm ${
                    s.highlight
                      ? "border-blue-500 bg-blue-50/40 shadow-blue-100 dark:border-blue-500 dark:bg-blue-950/30"
                      : "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
                  }`}
                >
                  {s.highlight && (
                    <span className="absolute -top-3 left-7 rounded-full bg-blue-600 px-3 py-0.5 text-xs font-semibold text-white">
                      Most popular
                    </span>
                  )}
                  <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                    <Icon className="h-6 w-6" />
                  </div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">{s.title}</h2>
                  <p className="text-sm text-gray-500">{s.size}</p>
                  <div className="mt-4 text-sm text-gray-500">
                    from <span className="text-lg font-bold text-gray-900 dark:text-white">{s.priceFrom}</span>
                  </div>
                  <ul className="mt-6 space-y-2.5 text-sm text-gray-700 dark:text-gray-300">
                    {s.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
                        {b}
                      </li>
                    ))}
                  </ul>
                  <div className="flex-1" />
                  <div className="mt-8 flex gap-3">
                    <Link
                      href="/contact"
                      className={`flex-1 rounded-full px-4 py-2 text-center text-sm font-semibold ${
                        s.highlight
                          ? "bg-blue-600 text-white hover:bg-blue-700"
                          : "border border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
                      }`}
                    >
                      {s.cta}
                    </Link>
                    <Link
                      href="/pricing"
                      className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      Pricing
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </Container>
      </section>

      <CTASection />
    </>
  );
}
