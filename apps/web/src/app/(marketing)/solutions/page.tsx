import Link from "next/link";
import { CheckCircle2, Stethoscope, Building, Building2 } from "lucide-react";
import { Container } from "../_components/Container";
import { CTASection } from "../_components/CTASection";

export const metadata = { title: "Solutions — MedCore" };

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
              One platform. Built for how you grow.
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              From a solo clinic to a 200-bed multi-specialty — same login, same mobile app.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-20">
        <Container>
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
