import Link from "next/link";
import Image from "next/image";
import {
  Activity,
  Stethoscope,
  Receipt,
  Smartphone,
  Users,
  Building2,
  Wallet,
  HeartPulse,
  ArrowRight,
  CheckCircle2,
  Brain,
  Shield,
  FileJson,
  Languages,
  TrendingUp,
  Sparkles,
} from "lucide-react";
import { Container } from "./_components/Container";
import { FeatureCard } from "./_components/FeatureCard";
import { CTASection } from "./_components/CTASection";

export const metadata = {
  title: "MedCore — Hospital management built for Indian hospitals",
  description:
    "Run your hospital, not spreadsheets. AI triage, ambient scribe, drug-safety checks, claims auto-draft, ABDM-ready, FHIR R4 export, HL7 v2 inbound, TPA claims, pharmacy, and a patient app — all in one platform.",
};

const logos = ["Asha Hospital", "Sunrise Clinic", "Greenleaf Care", "Medicity", "Lotus Health", "Nova Med"];

const metrics = [
  { v: "150+", l: "OPD patients/day" },
  { v: "45", l: "modules" },
  { v: "1,300+", l: "lab tests" },
  { v: "24/7", l: "uptime" },
];

const shots = [
  { src: "/screenshots/03-dashboard-admin.png", alt: "Admin dashboard" },
  { src: "/screenshots/10-appointments.png", alt: "Appointments" },
  { src: "/screenshots/20-admissions.png", alt: "Admissions" },
  { src: "/screenshots/37-billing.png", alt: "Billing" },
  { src: "/screenshots/32-lab.png", alt: "Lab" },
  { src: "/screenshots/17-prescriptions.png", alt: "Prescriptions" },
];

export default function HomePage() {
  return (
    <>
      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.15),transparent_60%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.25),transparent_60%)]" />
        <Container className="py-20 md:py-28">
          <div className="mx-auto max-w-4xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-1.5 text-sm font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
              <Activity className="h-4 w-4" />
              45 modules. One platform.
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-6xl md:text-7xl dark:text-white">
              Run your hospital.
              <br />
              <span className="bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text text-transparent">
                Not spreadsheets.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-600 dark:text-gray-400 md:text-xl">
              MedCore runs your OPD queue, admissions, billing, pharmacy, lab,
              HR and a patient mobile app — with AI triage, ambient scribe,
              drug-safety checks, claims auto-drafted from SOAP, ABDM/ABHA,
              FHIR R4 and HL7 v2 inbound baked in.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/contact"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-7 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/20 hover:bg-blue-700"
              >
                Request a demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="https://medcore.globusdemos.com/login"
                className="inline-flex items-center justify-center rounded-full border border-gray-300 bg-white px-7 py-3 text-base font-semibold text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800"
              >
                Try the live demo
              </Link>
            </div>
            <p className="mt-4 text-sm text-gray-500 dark:text-gray-500">
              Demo login: <code className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">admin@medcore.local</code> /{" "}
              <code className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">admin123</code>
            </p>
          </div>
        </Container>
      </section>

      {/* LOGO CLOUD */}
      <section className="border-y border-gray-200 bg-gray-50 py-10 dark:border-gray-800 dark:bg-gray-900/40">
        <Container>
          <p className="text-center text-sm font-medium uppercase tracking-wider text-gray-500">
            Trusted by growing hospitals across India
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-12 gap-y-4">
            {logos.map((l) => (
              <span key={l} className="text-xl font-semibold text-gray-400 dark:text-gray-600">
                {l}
              </span>
            ))}
          </div>
        </Container>
      </section>

      {/* WHAT YOU GET */}
      <section className="py-20">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">What you get on day one</h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Three things your front desk will notice immediately.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            <FeatureCard
              icon={Users}
              title="Live OPD queue"
              description="Real-time queue with token displays, vulnerability flagging and Socket.IO live updates for every counter."
            />
            <FeatureCard
              icon={Receipt}
              title="GST-aware billing"
              description="Auto CGST+SGST split, packages, Razorpay + UPI, insurance claims and refund workflows baked in."
            />
            <FeatureCard
              icon={Smartphone}
              title="Patient mobile app"
              description="Patients get their live token, prescription QR and lab reports in a branded Android/iOS app."
            />
          </div>
        </Container>
      </section>

      {/* FEATURE MOSAIC */}
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">Everything in one place</h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              From the moment a patient walks in to payroll at month-end.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={HeartPulse} title="Clinical" description="EHR, prescriptions with QR, lab orders, ANC, pediatric growth, immunization." href="/features#clinical" />
            <FeatureCard icon={Activity} title="Operations" description="OPD queue, admissions, OT, surgery, emergency, ambulance, blood bank." href="/features#operations" />
            <FeatureCard icon={Wallet} title="Finance" description="GST invoicing, packages, payment plans, Razorpay, TPA claims, refunds." href="/features#finance" />
            <FeatureCard icon={Users} title="HR" description="Shift roster, leaves, payroll, pay slips, certifications, 7 role levels." href="/features#hr" />
            <FeatureCard icon={Building2} title="Engagement" description="WhatsApp + SMS + email + push, feedback, NPS, complaints with SLA." href="/features#engagement" />
            <FeatureCard icon={Smartphone} title="Mobile" description="Patient app with live queue and lab reports, doctor-lite app for rounds." href="/features#mobile" />
            <FeatureCard icon={Brain} title="AI + Automation" description="AI triage, ambient SOAP scribe with speaker relabel, drug-safety checks, chart search, claims auto-draft, no-show predictions." href="/features#ai" />
            <FeatureCard icon={Shield} title="Compliance & Interop" description="ABDM / ABHA linking, FHIR R4 export, HL7 v2 inbound, DLT-compliant SMS, audit trail, multi-tenant ready." href="/features#compliance" />
          </div>
        </Container>
      </section>

      {/* AI + INTEROP BANNER */}
      <section className="py-20">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300">
              <Sparkles className="h-3.5 w-3.5" /> New this quarter
            </div>
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
              Clinical AI, built for Indian data
            </h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Sarvam AI with in-country inference, 10 Indian languages, and data that never leaves India.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            <FeatureCard
              icon={Stethoscope}
              title="AI Triage + Ambient Scribe"
              description="Symptom triage in the patient's language, plus an ambient scribe that writes SOAP notes during the consult with optional acoustic speaker diarization (AssemblyAI) or manual post-hoc speaker relabel."
            />
            <FeatureCard
              icon={Brain}
              title="Ambient chart search"
              description="Ask natural-language questions over a patient's chart — answers cite the source notes, labs and uploaded documents."
            />
            <FeatureCard
              icon={TrendingUp}
              title="ML-driven predictions"
              description="No-show scoring, pharmacy demand forecast, ER triage severity, adherence nudges — all running on your data."
            />
            <FeatureCard
              icon={Receipt}
              title="Claims auto-draft from SOAP"
              description="The scribe's ICD-10 + CPT codes pre-fill a TPA claim draft so reception reviews in 30 seconds instead of re-keying the whole form."
            />
            <FeatureCard
              icon={Sparkles}
              title="Prompt registry + rollback"
              description="Every LLM prompt is versioned in the DB. Admins activate a new version or one-shot roll back — every mutation audit-logged."
            />
            <FeatureCard
              icon={Brain}
              title="AI Radiology drafting"
              description="Upload an imaging study, AI drafts an impression + findings with per-finding confidence, radiologist approves or amends with HITL workflow."
            />
            <FeatureCard
              icon={Shield}
              title="ABDM-ready, ABHA linking"
              description="Link Ayushman Bharat Health Accounts, request consents, push care contexts to the national stack."
            />
            <FeatureCard
              icon={FileJson}
              title="FHIR R4 + HL7 v2"
              description="FHIR R4 Patient / Encounter / $everything bundles, plus a rate-limited HL7 v2 inbound endpoint for legacy lab analysers."
            />
            <FeatureCard
              icon={Languages}
              title="Indian data residency"
              description="Sarvam AI inference inside India, transcription in 10 languages, audit-logged egress."
            />
          </div>
        </Container>
      </section>

      {/* SCREENSHOT STRIP */}
      <section className="py-20">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">See it in action</h2>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              Real screens from the product — not mockups.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {shots.map((s) => (
              <div
                key={s.src}
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition hover:shadow-lg dark:border-gray-800 dark:bg-gray-900"
              >
                <Image src={s.src} alt={s.alt} width={800} height={500} className="h-auto w-full" />
                <div className="border-t border-gray-100 px-4 py-3 text-sm font-medium text-gray-700 dark:border-gray-800 dark:text-gray-300">
                  {s.alt}
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* TESTIMONIALS */}
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                q: "Our OPD wait time dropped from 40 minutes to 12. The live token display alone was worth the switch.",
                n: "Dr. Meera Rao",
                r: "Medical Director, Asha Hospital",
              },
              {
                q: "We replaced three tools with MedCore. Billing, pharmacy and lab now talk to each other without exports.",
                n: "Ravi Prasad",
                r: "Administrator, Sunrise Clinic",
              },
              {
                q: "The patient mobile app reduced our front-desk calls by half in the first month.",
                n: "Shalini Kumar",
                r: "Operations Head, Greenleaf Care",
              },
            ].map((t) => (
              <figure
                key={t.n}
                className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <blockquote className="text-base leading-relaxed text-gray-700 dark:text-gray-300">
                  &ldquo;{t.q}&rdquo;
                </blockquote>
                <figcaption className="mt-6 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-emerald-500" />
                  <div>
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">{t.n}</div>
                    <div className="text-xs text-gray-500">{t.r}</div>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </Container>
      </section>

      {/* METRICS */}
      <section className="py-16">
        <Container>
          <div className="grid gap-8 rounded-3xl border border-gray-200 bg-white p-10 shadow-sm sm:grid-cols-2 md:grid-cols-4 dark:border-gray-800 dark:bg-gray-900">
            {metrics.map((m) => (
              <div key={m.l} className="text-center">
                <div className="text-4xl font-extrabold text-blue-600 dark:text-blue-400">{m.v}</div>
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">{m.l}</div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <CTASection />
    </>
  );
}
