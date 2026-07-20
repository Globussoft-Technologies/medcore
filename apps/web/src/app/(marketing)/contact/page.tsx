import { Container } from "../_components/Container";
import { EnquiryForm } from "./EnquiryForm";
import { Mail, Phone, MapPin } from "lucide-react";

export const metadata = {
  title: "Contact & Demo Request",
  description:
    "Request a personalized MedCore demo. Our team will reply within one business day with a walkthrough tailored to your hospital's size and specialty.",
  alternates: { canonical: "https://medcore.globusdemos.com/contact" },
};

export default function ContactPage() {
  return (
    <section className="py-20">
      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-extrabold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
            Let&apos;s talk.
          </h1>
          <p className="mt-4 text-lg text-gray-600 dark:text-gray-400">
            Tell us about your hospital. We&apos;ll reply within one business day.
          </p>
        </div>

        <div className="mt-14 grid gap-10 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <EnquiryForm />
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Get in touch</h2>
              <ul className="mt-5 space-y-5 text-sm">
                <li className="flex gap-3">
                  <Mail className="h-5 w-5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">Email</div>
                    <a href="mailto:support@medcore.software" className="text-gray-600 hover:text-blue-600 dark:text-gray-400">
                      support@medcore.software
                    </a>
                  </div>
                </li>
                <li className="flex gap-3">
                  <Phone className="h-5 w-5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">Phone</div>
                    <a href="tel:+917566063718" className="text-gray-600 hover:text-blue-600 dark:text-gray-400">
                      +91 75660 63718
                    </a>
                  </div>
                </li>
                <li className="flex gap-3">
                  <MapPin className="h-5 w-5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white">Office</div>
                    <p className="text-gray-600 dark:text-gray-400">Bangalore, India</p>
                  </div>
                </li>
              </ul>
            </div>

            {/* Google Maps embed — keyless iframe (no Maps JS SDK, no API key,
                lazy-loaded so it never blocks first paint). The keyless embed
                only renders a light basemap, so in dark mode we apply a CSS
                filter (invert + hue-rotate) so it blends with the dark theme.
                See `.map-embed` in globals.css. */}
            <div className="relative h-56 overflow-hidden rounded-3xl border border-gray-200 shadow-sm dark:border-gray-800">
              <iframe
                title="MedCore office — Udaya Mansion, Koramangala, Bengaluru"
                src="https://www.google.com/maps?q=Udaya%20Mansion%2C%20Koramangala%2C%20Bengaluru&output=embed"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                className="map-embed h-full w-full border-0"
              />
              <div className="pointer-events-none absolute bottom-4 left-4 rounded-full bg-white/90 px-3 py-1.5 text-xs font-semibold text-gray-700 shadow dark:bg-gray-900/90 dark:text-gray-200">
                <MapPin className="mr-1 inline h-3.5 w-3.5 text-blue-600" />
                Koramangala, Bengaluru
              </div>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
