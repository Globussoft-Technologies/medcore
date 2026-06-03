"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Container } from "./Container";
import logoHorizontal from "../../assets/MedCore_Logo1_0001_Layer-3.png";
import logoHorizontalDark from "../../assets/MedCore_Logo1_0003_Layer-6.png";

const links = [
  { href: "/features", label: "Features" },
  { href: "/solutions", label: "Solutions" },
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export function MarketingNav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-gray-200/70 bg-white/80 backdrop-blur-md dark:border-gray-800/70 dark:bg-gray-950/80">
      <Container className="flex h-16 items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-lg text-gray-900 dark:text-white"
        >
          <Image
            src={logoHorizontal}
            alt="MedCore"
            width={160}
            height={32}
            priority
            className="h-8 w-auto dark:hidden"
          />
          <Image
            src={logoHorizontalDark}
            alt="MedCore"
            width={160}
            height={32}
            priority
            className="hidden h-8 w-auto dark:block"
          />
        </Link>

        <nav className="hidden md:flex items-center gap-7">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-gray-700 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm font-medium text-gray-700 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400"
          >
            Log in
          </Link>
          <Link
            href="/contact"
            className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Book a demo
          </Link>
          {/* Public quick-appointment booking — no login needed. */}
          <Link
            href="/book"
            className="rounded-full border border-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-600 shadow-sm hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
          >
            Book appointment
          </Link>
        </div>

        <button
          className="md:hidden rounded-lg p-2 text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </Container>

      {open && (
        <div className="md:hidden border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="space-y-1 px-4 py-4">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-base font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2 text-base font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Log in
            </Link>
            <Link
              href="/contact"
              onClick={() => setOpen(false)}
              className="mt-2 block rounded-full bg-blue-600 px-4 py-2 text-center text-base font-semibold text-white"
            >
              Book a demo
            </Link>
            <Link
              href="/book"
              onClick={() => setOpen(false)}
              className="mt-2 block rounded-full border border-emerald-500 px-4 py-2 text-center text-base font-semibold text-emerald-600 dark:text-emerald-400"
            >
              Book appointment
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
