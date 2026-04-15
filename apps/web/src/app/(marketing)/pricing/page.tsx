import Link from "next/link";
import { Check, X } from "lucide-react";
import { Container } from "../_components/Container";
import { CTASection } from "../_components/CTASection";

export const metadata = {
  title: "Pricing",
  description:
    "Transparent monthly pricing for MedCore. Starter, Professional, and Enterprise plans — all modules included. No hidden fees, no setup charges.",
  alternates: { canonical: "https://medcore.globusdemos.com/pricing" },
};

const tiers = [
  {
    name: "Starter",
    price: "₹9,999",
    period: "/month",
    tag: "For solo clinics",
    bullets: [
      "Up to 5 users",
      "Single branch",
      "Core modules",
      "WhatsApp 1,000 msg/mo",
      "Email support",
    ],
    cta: "Start with Starter",
  },
  {
    name: "Professional",
    price: "₹24,999",
    period: "/month",
    tag: "For growing hospitals",
    highlight: true,
    bullets: [
      "Up to 25 users",
      "2 branches",
      "All modules",
      "WhatsApp 10,000 msg/mo",
      "Priority support",
      "Patient mobile app",
    ],
    cta: "Start with Professional",
  },
  {
    name: "Enterprise",
    price: "Contact us",
    period: "",
    tag: "For multi-specialty",
    bullets: [
      "Unlimited users",
      "Multi-branch",
      "SLA and uptime credits",
      "Dedicated onboarding",
      "Custom integrations",
      "On-prem or dedicated cloud",
    ],
    cta: "Book enterprise demo",
  },
];

const matrix: { feature: string; s: boolean | string; p: boolean | string; e: boolean | string }[] = [
  { feature: "Appointments + walk-in", s: true, p: true, e: true },
  { feature: "OPD queue + token displays", s: true, p: true, e: true },
  { feature: "GST-compliant billing", s: true, p: true, e: true },
  { feature: "Digital prescriptions (QR)", s: true, p: true, e: true },
  { feature: "Pharmacy dispense", s: true, p: true, e: true },
  { feature: "Lab orders and reports", s: false, p: true, e: true },
  { feature: "Admissions, wards, bed census", s: false, p: true, e: true },
  { feature: "HR: roster, leaves, payroll", s: false, p: true, e: true },
  { feature: "Insurance / TPA claims", s: false, p: true, e: true },
  { feature: "Patient mobile app", s: false, p: true, e: true },
  { feature: "OT + surgery workflow", s: false, p: false, e: true },
  { feature: "Blood bank", s: false, p: false, e: true },
  { feature: "Multi-branch analytics", s: false, p: false, e: true },
  { feature: "SLA and dedicated onboarding", s: false, p: false, e: true },
  { feature: "Custom integrations (HL7, etc.)", s: false, p: false, e: true },
];

const faqs = [
  { q: "What's included in each plan?", a: "All plans include hosting, updates, daily backups and email support. See the comparison table above for module-level details." },
  { q: "Is there a setup fee?", a: "No. Starter and Professional are self-onboard. Enterprise includes a one-time onboarding package quoted separately." },
  { q: "What about data migration?", a: "We import patient lists, medicine masters and staff from CSV/Excel at no charge. Complex migrations from legacy HIS are scoped per project." },
  { q: "Is there a free trial?", a: "Yes — 14-day free trial on Starter and Professional. No credit card needed. You can also try the live demo immediately." },
  { q: "Can I change plans later?", a: "Yes, upgrade or downgrade any time. We pro-rate the difference so you're never locked in." },
  { q: "Is my data HIPAA-safe?", a: "We follow HIPAA best practices (encryption at rest, audit trail, role-based access), but we are not HIPAA-certified yet. For India, we align with DPDP Act requirements." },
  { q: "Where is data hosted?", a: "India region by default (Mumbai). Enterprise can request a dedicated instance in any AWS region." },
  { q: "Do you charge for patients or transactions?", a: "No per-patient or per-invoice fees. Pricing is per seat. WhatsApp messages above the included quota are billed at cost." },
];

function Cell({ v }: { v: boolean | string }) {
  if (typeof v === "string") return <td className="p-4 text-center text-sm text-gray-600 dark:text-gray-400">{v}</td>;
  return (
    <td className="p-4 text-center">
      {v ? <Check className="mx-auto h-5 w-5 text-emerald-500" /> : <X className="mx-auto h-5 w-5 text-gray-300 dark:text-gray-700" />}
    </td>
  );
}

export default function PricingPage() {
  return (
    <>
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
              Honest pricing. No hidden fees.
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Pay per user, not per patient. Cancel anytime. 14-day free trial.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-16">
        <Container>
          <div className="grid gap-6 md:grid-cols-3">
            {tiers.map((t) => (
              <div
                key={t.name}
                className={`relative flex flex-col rounded-2xl border p-8 ${
                  t.highlight
                    ? "border-blue-500 bg-white shadow-xl dark:bg-gray-900"
                    : "border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900"
                }`}
              >
                {t.highlight && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-xs font-semibold text-white">
                    Most popular
                  </span>
                )}
                <div className="text-sm font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">{t.tag}</div>
                <h2 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t.name}</h2>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold text-gray-900 dark:text-white">{t.price}</span>
                  {t.period && <span className="text-gray-500">{t.period}</span>}
                </div>
                <ul className="mt-6 space-y-2.5 text-sm text-gray-700 dark:text-gray-300">
                  {t.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
                      {b}
                    </li>
                  ))}
                </ul>
                <div className="flex-1" />
                <Link
                  href="/contact"
                  className={`mt-8 rounded-full px-5 py-3 text-center text-sm font-semibold ${
                    t.highlight
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : "border border-gray-300 text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {t.cta}
                </Link>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* Comparison matrix */}
      <section className="py-16">
        <Container>
          <h2 className="text-center text-2xl font-bold text-gray-900 dark:text-white">Compare plans</h2>
          <div className="mt-10 overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-sm font-semibold text-gray-700 dark:border-gray-800 dark:text-gray-300">
                  <th className="p-4 text-left">Feature</th>
                  <th className="p-4 text-center">Starter</th>
                  <th className="p-4 text-center">Professional</th>
                  <th className="p-4 text-center">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((row) => (
                  <tr key={row.feature} className="border-b border-gray-100 text-sm text-gray-700 last:border-0 dark:border-gray-800 dark:text-gray-300">
                    <td className="p-4">{row.feature}</td>
                    <Cell v={row.s} />
                    <Cell v={row.p} />
                    <Cell v={row.e} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Container>
      </section>

      {/* FAQ */}
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-3xl font-bold text-gray-900 dark:text-white">Frequently asked questions</h2>
            <div className="mt-10 space-y-4">
              {faqs.map((f) => (
                <details
                  key={f.q}
                  className="group rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <summary className="flex cursor-pointer items-center justify-between text-base font-semibold text-gray-900 dark:text-white">
                    {f.q}
                    <span className="ml-4 text-gray-400 group-open:rotate-45 transition">+</span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-400">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </Container>
      </section>

      <CTASection />
    </>
  );
}
