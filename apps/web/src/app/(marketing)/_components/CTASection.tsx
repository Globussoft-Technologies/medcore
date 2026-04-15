import Link from "next/link";
import { Container } from "./Container";

export function CTASection({
  title = "Ready to streamline your hospital?",
  subtitle = "Book a 30-minute demo with our team. We'll tailor it to your workflow.",
  primaryHref = "/contact",
  primaryLabel = "Book a demo",
  secondaryHref = "https://medcore.globusdemos.com/login",
  secondaryLabel = "Try the live demo",
}: {
  title?: string;
  subtitle?: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <section className="py-20">
      <Container>
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 via-blue-700 to-emerald-600 px-8 py-16 text-center shadow-xl">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.2),transparent_50%)]" />
          <div className="relative">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">{title}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-blue-50">{subtitle}</p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href={primaryHref}
                className="inline-flex items-center justify-center rounded-full bg-white px-7 py-3 text-base font-semibold text-blue-700 shadow-sm hover:bg-blue-50"
              >
                {primaryLabel}
              </Link>
              <Link
                href={secondaryHref}
                className="inline-flex items-center justify-center rounded-full border border-white/30 bg-white/10 px-7 py-3 text-base font-semibold text-white backdrop-blur hover:bg-white/20"
              >
                {secondaryLabel}
              </Link>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
