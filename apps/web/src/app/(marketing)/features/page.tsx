import Image from "next/image";
import {
  CheckCircle2,
  Stethoscope,
  Brain,
  Headphones,
  ClipboardList,
  PhoneCall,
  Globe2,
  Megaphone,
  Receipt,
  Sparkles,
  Clock,
} from "lucide-react";
import { Container } from "../_components/Container";
import { CTASection } from "../_components/CTASection";

export const metadata = {
  title: "Features",
  description:
    "Clinical, operations, finance, HR, engagement, and mobile — every module in MedCore's hospital management platform explained.",
  alternates: { canonical: "https://medcore.globusdemos.com/features" },
};

type Section = {
  id: string;
  title: string;
  tagline: string;
  bullets: string[];
  shot: { src: string; alt: string };
};

const sections: Section[] = [
  {
    id: "clinical",
    title: "Clinical",
    tagline: "Everything a doctor and nurse need, on one screen.",
    bullets: [
      "Structured EHR with vitals, allergies and problem list",
      "Digital prescriptions with scannable QR",
      "Lab orders with delta-flag alerts",
      "Controlled substance tracking",
      "Discharge summaries in one click",
      "ANC + pediatric + India UIP immunization schedule",
      "Telemedicine with Jitsi waiting room",
      "ICD-10 coded diagnoses",
      "Referrals and coordinated visits",
      "Ambient scribe with post-hoc speaker relabel",
    ],
    shot: { src: "/screenshots/17-prescriptions.png", alt: "Prescriptions" },
  },
  {
    id: "operations",
    title: "Operations",
    tagline: "Every patient, every bed, every queue — live.",
    bullets: [
      "OPD queue with vulnerability flagging",
      "Real-time updates via Socket.IO",
      "Admissions and ward/bed census",
      "Emergency triage and ambulance dispatch",
      "OT scheduling and surgery workflow",
      "Blood bank with component separation",
      "Visitor check-in and passes",
      "Asset management with depreciation",
      "Token displays on TVs",
      "Claims auto-drafted from scribe SOAP + ICD-10",
      "Runtime rate-limit toggle for load tests",
    ],
    shot: { src: "/screenshots/12-queue.png", alt: "OPD queue" },
  },
  {
    id: "finance",
    title: "Finance",
    tagline: "Billing that your accountant will actually like.",
    bullets: [
      "GST-aware invoicing with CGST+SGST split",
      "Razorpay with signed webhook",
      "UPI-first payment flows",
      "Insurance / TPA claims and pre-auth",
      "Payment plans and EMIs",
      "Refunds and discount approvals",
      "Packages (maternity, cardiac, etc.)",
      "Purchase orders with auto-PO threshold",
      "Expense and budget tracking",
    ],
    shot: { src: "/screenshots/37-billing.png", alt: "Billing" },
  },
  {
    id: "hr",
    title: "HR",
    tagline: "Roster, leaves and payroll in one flow.",
    bullets: [
      "Shift roster across departments",
      "Leave workflow with approvals",
      "Leave calendar and holidays",
      "Payroll with pay slip PDF",
      "7 role-based access levels",
      "Certifications and renewal alerts",
      "Duty roster and my-schedule",
      "Doctor schedules and availability",
      "Audit trail for every action",
    ],
    shot: { src: "/screenshots/20-admissions.png", alt: "Admissions" },
  },
  {
    id: "engagement",
    title: "Engagement",
    tagline: "Patients hear from you on the channel they already use.",
    bullets: [
      "Real-time notifications: WhatsApp, SMS, email, push",
      "DLT-compliant SMS templates",
      "Feedback and NPS collection",
      "Complaints with SLA tracking",
      "Broadcast campaigns",
      "Patient chat",
      "Appointment reminders",
      "Lab-report-ready alerts",
      "Discharge follow-ups",
    ],
    shot: { src: "/screenshots/66-chat.png", alt: "Chat" },
  },
  {
    id: "mobile",
    title: "Mobile",
    tagline: "Your hospital, in the patient's pocket.",
    bullets: [
      "Patient app with live queue and push",
      "In-app lab reports and prescription QR",
      "Doctor-lite app for rounds and approvals",
      "Offline-friendly caching",
      "Branded per hospital",
      "Android + iOS from one codebase",
      "Appointment booking",
      "Bill pay via UPI",
      "Telemedicine from the app",
    ],
    shot: { src: "/screenshots/03-dashboard-admin.png", alt: "Mobile-ready dashboard" },
  },
  {
    id: "ai",
    title: "AI + Automation",
    tagline: "Clinical AI that meets Indian doctors where they work.",
    bullets: [
      "AI triage chatbot in English + Hindi (Sarvam AI)",
      "Ambient SOAP scribe with DOCTOR/PATIENT/ATTENDANT relabel",
      "Drug interaction + contraindication safety checks",
      "Ambient chart search with cited sources",
      "No-show risk scoring per appointment",
      "ER triage severity classifier (MEWS + LLM ESI)",
      "Pharmacy demand forecast (Holt-Winters)",
      "Patient-friendly lab report explainer (HITL approval)",
      "Medication adherence reminders with quiet-hours defer",
      "AI-drafted discharge + referral letters",
      "Claims auto-draft from SOAP + ICD-10 + CPT",
      "Denial-risk predictor with machine-replayable auto-fix",
      "Prompt registry with versioning + one-click rollback",
    ],
    shot: { src: "/screenshots/17-prescriptions.png", alt: "AI scribe" },
  },
  {
    id: "compliance",
    title: "Compliance & Interoperability",
    tagline: "ABDM-ready, FHIR-native, audit-logged end to end.",
    bullets: [
      "ABDM / ABHA linking with sandbox + production gateway",
      "Consent artefacts and CareContext discovery",
      "FHIR R4 Patient + Encounter + $everything bundles",
      "HL7 v2 inbound endpoint for legacy lab / LIS gateways",
      "Insurance TPA claims with Medi-Assist + Paramount adapters (plus mock)",
      "DLT-compliant SMS templates",
      "Audit log on every mutation with CSV export",
      "Indian data residency — Sarvam AI India-region inference",
      "Razorpay webhook HMAC-SHA256 raw-body verification",
      "Multi-tenant foundation (Tenant table + scoping middleware)",
      "Prompt registry with versioning and rollback",
    ],
    shot: { src: "/screenshots/37-billing.png", alt: "Compliance" },
  },
];

export default function FeaturesPage() {
  return (
    <>
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
              Every feature you&apos;d expect — and a few you won&apos;t.
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              45 modules, built over two years with doctors, nurses and
              administrators who actually run hospitals.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {sections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="rounded-full border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:border-blue-400 hover:text-blue-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                >
                  {s.title}
                </a>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* AI AGENTS — named-product framing */}
      <section className="bg-gradient-to-br from-indigo-50 to-blue-50 py-20 dark:from-indigo-950/30 dark:to-blue-950/30">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wider text-indigo-700 dark:border-indigo-900 dark:bg-gray-900 dark:text-indigo-300">
              AI agents that ship today
            </div>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
              Specialised agents, not a generic chatbot
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Each agent owns one job, hands off cleanly to the next, and writes
              an audit row for every decision. Every prompt is versioned in the
              DB with one-click rollback.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Stethoscope,
                name: "Triage Agent",
                tagline: "Patient-facing",
                desc: "Symptom triage in 8 Indian languages with SNOMED-anchored routing. Recommends a specialty, books the slot, or escalates a red flag to the agent console.",
              },
              {
                icon: ClipboardList,
                name: "Scribe Agent",
                tagline: "Doctor-facing",
                desc: "Ambient SOAP scribe with DOCTOR / PATIENT / ATTENDANT speaker tags. Pre-fills ICD-10 + CPT codes that the Claims Agent picks up.",
              },
              {
                icon: Brain,
                name: "Radiology Agent",
                tagline: "Radiologist-facing",
                desc: "Drafts impressions + findings on uploaded imaging studies with per-finding confidence. HITL workflow — radiologist approves or amends before release.",
              },
              {
                icon: Receipt,
                name: "Claims Agent",
                tagline: "Reception-facing",
                desc: "Auto-drafts the TPA claim from the Scribe Agent's SOAP + ICD-10. Predicts denial risk before submission. Reception reviews in 30s instead of re-keying.",
              },
              {
                icon: Headphones,
                name: "Agent Console",
                tagline: "Staff-facing",
                desc: "When any AI agent escalates, a human agent sees the full transcript, AI-extracted SOAP, top-3 doctor matches, and red flags — with one-click hand-off.",
              },
              {
                icon: Sparkles,
                name: "Predictions Agent",
                tagline: "Ops-facing",
                desc: "No-show scoring, pharmacy demand forecast (Holt-Winters), ER triage severity (MEWS + LLM ESI), adherence nudges. All running on your data, no SaaS export.",
              },
            ].map((a) => {
              const Icon = a.icon;
              return (
                <div
                  key={a.name}
                  className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                    <Icon className="h-6 w-6" />
                  </div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                    {a.name}
                  </h3>
                  <div className="text-xs uppercase tracking-wider text-gray-500">
                    {a.tagline}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                    {a.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </Container>
      </section>

      {sections.map((s, i) => (
        <section
          key={s.id}
          id={s.id}
          className={`scroll-mt-24 py-20 ${i % 2 ? "bg-gray-50 dark:bg-gray-900/40" : ""}`}
        >
          <Container>
            <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
              <div className={i % 2 ? "lg:order-2" : ""}>
                <div className="text-sm font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                  {s.title}
                </div>
                <h2 className="mt-2 text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
                  {s.tagline}
                </h2>
                <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-x-6">
                  {s.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-md dark:border-gray-800 dark:bg-gray-900 ${i % 2 ? "lg:order-1" : ""}`}>
                <Image src={s.shot.src} alt={s.shot.alt} width={900} height={560} className="h-auto w-full" />
              </div>
            </div>
          </Container>
        </section>
      ))}

      {/* COMING NEXT QUARTER — honest roadmap */}
      <section className="border-t border-gray-200 py-20 dark:border-gray-800">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <Clock className="h-3.5 w-3.5" /> On the roadmap
            </div>
            <h2 className="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
              What we&apos;re building next
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              We&apos;d rather tell you what isn&apos;t ready yet than oversell.
              These are the four capabilities on deck for the next two
              quarters — pre-order partnership is open if you want to be the
              design partner for any of them.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {[
              {
                icon: PhoneCall,
                title: "Voice Receptionist",
                eta: "Next quarter",
                desc: "24/7 voice agent on your hospital line: qualifies the caller (booking / lab report / billing / triage), books into the OPD queue, or hands off to a human in the agent console with full context.",
              },
              {
                icon: Globe2,
                title: "International Patient Coordination",
                eta: "Next quarter",
                desc: "Visa support letter workflow, multi-currency billing display, language translation, flight + hotel + local transport checklist. Built for hospitals doing medical tourism — single international patient = 5-10x avg domestic ARPU.",
              },
              {
                icon: PhoneCall,
                title: "Outbound Follow-up Agent",
                eta: "Q2 next",
                desc: "Voice + WhatsApp outbound caller that contacts new enquiries, qualifies, follows up until booked, bridges to reception when the patient is on the phone. Reuses the Voice Receptionist infrastructure.",
              },
              {
                icon: Megaphone,
                title: "Marketing-site Builder",
                eta: "Q2 next",
                desc: "Per-hospital landing pages (specialty / doctor profiles / cost calculators) with lead capture wired directly into the agent console queue. Owns the patient from organic search, not from the front desk.",
              },
            ].map((r) => {
              const Icon = r.icon;
              return (
                <div
                  key={r.title}
                  className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="flex items-start gap-4">
                    <div className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
                      <Icon className="h-6 w-6" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                          {r.title}
                        </h3>
                        <span className="text-xs font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
                          {r.eta}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                        {r.desc}
                      </p>
                    </div>
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
