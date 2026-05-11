import Link from "next/link";
import Image from "next/image";
import { Github, Twitter, Linkedin } from "lucide-react";
import { Container } from "./Container";
import logoIcon from "../../assets/HD_Icon.png";

const cols = [
  {
    title: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/solutions", label: "Solutions" },
      { href: "/pricing", label: "Pricing" },
      { href: "https://medcore.globusdemos.com/login", label: "Live demo" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
      { href: "/about#careers", label: "Careers" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "/features#clinical", label: "Clinical" },
      { href: "/features#finance", label: "Finance" },
      { href: "/features#mobile", label: "Mobile app" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "#", label: "Privacy" },
      { href: "#", label: "Terms" },
      { href: "#", label: "Data processing" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
      <Container className="py-14">
        <div className="grid gap-10 md:grid-cols-5">
          <div className="md:col-span-2">
            <Link
              href="/"
              className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white"
            >
              <Image
                src={logoIcon}
                alt="MedCore"
                width={32}
                height={32}
                className="rounded-lg"
              />
              MedCore
            </Link>
            <p className="mt-4 max-w-sm text-sm text-gray-600 dark:text-gray-400">
              Hospital management software engineered for Indian clinics and
              hospitals. GST-aware billing, DLT-compliant SMS, UPI-first
              payments.
            </p>
            <div className="mt-6 flex gap-3">
              <a
                href="#"
                aria-label="Twitter"
                className="rounded-full p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <Twitter className="h-5 w-5" />
              </a>
              <a
                href="#"
                aria-label="LinkedIn"
                className="rounded-full p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <Linkedin className="h-5 w-5" />
              </a>
              <a
                href="#"
                aria-label="GitHub"
                className="rounded-full p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <Github className="h-5 w-5" />
              </a>
            </div>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                {c.title}
              </h4>
              <ul className="mt-4 space-y-2">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-gray-600 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 border-t border-gray-200 pt-6 text-sm text-gray-500 dark:border-gray-800">
          (c) {new Date().getFullYear()} MedCore. Built in Bangalore, India.
        </div>
      </Container>
    </footer>
  );
}
