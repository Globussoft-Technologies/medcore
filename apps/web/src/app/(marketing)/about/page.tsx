import Image from "next/image";
import { Heart, ShieldCheck, IndianRupee } from "lucide-react";
import { Container } from "../_components/Container";
import { CTASection } from "../_components/CTASection";

type TeamMember = {
  name: string;
  role: string;
  image?: string;
};

export const metadata = {
  title: "About",
  description:
    "MedCore is built by engineers and doctors for Indian hospitals. GST, UPI, India UIP immunization schedule, and DLT-compliant messaging are first-class, not afterthoughts.",
  alternates: { canonical: "https://medcore.software/about" },
};

const team: TeamMember[] = [
  {
    name: "Sumit Ghosh",
    role: "Founder & CEO",
    image:
      "https://media.licdn.com/dms/image/v2/D5603AQFNYIIlpwexxg/profile-displayphoto-shrink_200_200/profile-displayphoto-shrink_200_200/0/1691612503562?e=2147483647&v=beta&t=GTnLsyrjcf1OVV-ZgFUT2iGZBEQqP2Ez-GvV8fePgyY",
  },
  {
    name: "Sourav Patra",
    role: "COO",
    image:
      "https://media.licdn.com/dms/image/v2/D5603AQFtor3CsW_FuQ/profile-displayphoto-shrink_100_100/profile-displayphoto-shrink_100_100/0/1692163383222?e=1778716800&v=beta&t=DdQp_M0bSDCA1KXxnYI_KES2WH1rIS9wxxz0kmtxWQw",
  },
  {
    name: "Aishwarya M",
    role: "CTO",
    image:
      "https://media.licdn.com/dms/image/v2/D5603AQEb5kBWW7OhQg/profile-displayphoto-shrink_200_200/B56ZbXw3ENGsAg-/0/1747376633259?e=2147483647&v=beta&t=9oSnQCXrnMcOE4LdOh_cUiWmdVMa6QMBYYkYX5G81js",
  },
];

function getInitials(name: string): string {
  return name
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const timeline = [
  {
    year: "Jan 2026",
    title: "Founded",
    text: "MedCore started inside a 40-bed hospital in Bangalore, solving real pain in OPD, billing and pharmacy workflows.",
  },
  {
    year: "Feb 2026",
    title: "Beta",
    text: "Opened beta to 12 hospitals across Karnataka and Tamil Nadu. 45 modules shipped.",
  },
  {
    year: "Apr 2026",
    title: "Production",
    text: "Generally available. India-first pricing, Hindi on the roadmap, HIPAA alignment underway.",
  },
];

export default function AboutPage() {
  return (
    <>
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
              Built with doctors, not for them.
            </h1>
            <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
              MedCore is engineered for Indian hospitals — GST, DLT-compliant
              SMS, UPI-first payments and the India UIP immunization schedule
              baked in.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-20">
        <Container className="max-w-3xl">
          <div className="space-y-6 text-lg leading-relaxed text-gray-700 dark:text-gray-300">
            <p>
              We started MedCore in 2024 after watching our co-founder&apos;s
              family clinic drown in paperwork. Every HIS we tried was either a
              15-year-old desktop app or a Western SaaS that didn&apos;t know
              what CGST+SGST meant. So we built our own.
            </p>
            <p>
              Today MedCore runs OPD queues, admissions, billing, pharmacy, lab,
              HR, payroll and a patient mobile app — all from one login.
              It&apos;s the same platform a solo clinic with one doctor and a
              200-bed multi-specialty hospital use, because your tools should
              grow with you, not against you.
            </p>
            <p>
              We&apos;re a small, honest team. We ship every week. We answer
              support tickets ourselves. And we&apos;ll never sell your patient
              data — it&apos;s not our business model and never will be.
            </p>
          </div>
        </Container>
      </section>

      {/* Values */}
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <h2 className="text-center text-3xl font-bold text-gray-900 dark:text-white">
            What we believe
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              {
                icon: Heart,
                title: "Built with doctors, not for them",
                text: "Every feature is shipped after a doctor or nurse has actually used it on a real shift.",
              },
              {
                icon: ShieldCheck,
                title: "Data never leaves your region",
                text: "India-hosted by default. Enterprise can choose a dedicated instance in any AWS region.",
              },
              {
                icon: IndianRupee,
                title: "Honest pricing, no hidden fees",
                text: "No per-patient fees. No setup fees on self-serve tiers. Cancel any time, keep your data.",
              },
            ].map((v) => {
              const Icon = v.icon;
              return (
                <div
                  key={v.title}
                  className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm dark:border-gray-800 dark:bg-gray-900"
                >
                  <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400">
                    <Icon className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {v.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                    {v.text}
                  </p>
                </div>
              );
            })}
          </div>
        </Container>
      </section>

      {/* Team */}
      <section className="py-20">
        <Container>
          <h2 className="text-center text-3xl font-bold text-gray-900 dark:text-white">
            Team
          </h2>
          <p className="mt-2 text-center text-sm text-gray-500">
            Small team. Big opinions about hospital software.
          </p>
          <div className="mx-auto mt-12 flex max-w-4xl flex-wrap justify-center gap-x-6 gap-y-10">
            {team.map((m) => (
              <div
                key={m.name}
                className="w-full text-center sm:w-[calc(50%-0.75rem)] md:w-[calc(33.333%-1rem)]"
              >
                {m.image ? (
                  <Image
                    src={m.image}
                    alt={`Portrait of ${m.name}`}
                    width={128}
                    height={128}
                    className="mx-auto h-32 w-32 rounded-full object-cover ring-2 ring-white shadow-md dark:ring-gray-800"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="mx-auto flex h-32 w-32 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-emerald-400 text-3xl font-bold text-white shadow-md"
                  >
                    {getInitials(m.name)}
                  </div>
                )}
                <h3 className="mt-4 text-base font-semibold text-gray-900 dark:text-white">
                  {m.name}
                </h3>
                <p className="text-sm text-gray-500">{m.role}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* Timeline */}
      <section className="bg-gray-50 py-20 dark:bg-gray-900/40">
        <Container>
          <h2 className="text-center text-3xl font-bold text-gray-900 dark:text-white">
            Our journey
          </h2>
          <div className="mx-auto mt-12 max-w-3xl space-y-6">
            {timeline.map((t) => (
              <div
                key={t.title}
                className="flex items-center gap-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
              >
                <div className="w-24 shrink-0 whitespace-nowrap text-2xl font-extrabold text-blue-600 dark:text-blue-400">
                  {t.year}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {t.title}
                  </h3>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {t.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <CTASection />
    </>
  );
}
