"use client";

// Public AI-assisted appointment booking (June 2026).
//
// A no-login booking flow reachable from the marketing nav ("Book appointment"):
//   1. Identity   — name, WhatsApp number, gender, DOB, (optional) email.
//   2. AI chat    — a multi-turn assistant (greets you by name) that asks about
//                   your symptoms; type or speak (Sarvam voice). Tap "Find a
//                   doctor" when ready → the conversation becomes the symptom
//                   text for /suggest-doctors.
//   3. Doctor     — pick a suggested doctor + an open slot → book.
//   4. OTP        — verify the WhatsApp number (Firebase) → patient dashboard.
//
// Calls the PUBLIC endpoints with bare fetch (NOT the @/lib/api client, which
// attaches auth cookies/CSRF we don't want on an unauthenticated surface).

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import Link from "next/link";
// Firebase Phone Auth — SAME mechanism the patient login page uses.
// Firebase sends the SMS + owns the 6-digit code; we exchange the resulting
// ID token at /patient-auth/firebase-verify for our session cookie.
import {
  ensureRecaptcha,
  disposeRecaptcha,
  sendOtp,
  verifyOtp as firebaseVerifyOtp,
  resetPhoneAuthState,
} from "@/lib/firebase";
import {
  Activity,
  Calendar,
  Stethoscope,
  Clock,
  Phone,
  User,
  Mail,
  Cake,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Star,
  ShieldCheck,
  Mic,
  Square,
  Loader2,
  Bot,
  Send,
  AlertTriangle,
  CalendarX,
  ChevronDown,
  Check,
} from "lucide-react";
import { Container } from "../_components/Container";
import {
  firstQuickBookIdentityError,
  validateQuickBookIdentity,
  type QuickBookIdentityErrors,
} from "./identity-validation";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

interface DoctorSuggestion {
  doctorId: string;
  name: string;
  specialization: string | null;
  experienceYears: number | null;
  averageRating: number | null;
  consultationFee: number | null;
  // Booking shape depends on the doctor's appointmentMode:
  //   SLOT    → `slots` holds open HH:MM times; patient picks one.
  //   TOKEN   → no time grid; `nextToken` is the number they'll be given.
  //   CALLING → no time / token; book by arrival on the chosen date.
  appointmentMode: "SLOT" | "TOKEN" | "CALLING";
  slots: string[];
  nextToken: number | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type Step = "identity" | "chat" | "doctor" | "otp" | "done";

// Next 7 days for the date strip (mirrors the Pearl day-picker shape).
function nextDays(count: number): { iso: string; weekday: string; day: string }[] {
  const out: { iso: string; weekday: string; day: string }[] = [];
  const base = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({
      iso,
      weekday: d.toLocaleDateString("en-IN", { weekday: "short" }),
      day: String(d.getDate()).padStart(2, "0"),
    });
  }
  return out;
}

// Pretty "Mon, 12 Jun" label for an ISO date string (used in the TOKEN /
// CALLING doctor cards, which book against a date rather than a time slot).
function fmtDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// "Zero" code points for the digit blocks of every supported (and most other
// Indian) scripts. A script's digits are 10 contiguous code points, so any
// digit's value = its code point − the block's zero.
const DIGIT_ZEROS = [
  0x0030, // ASCII
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic
  0x0966, // Devanagari (Hindi/Marathi)
  0x09e6, // Bengali
  0x0a66, // Gurmukhi (Punjabi)
  0x0ae6, // Gujarati
  0x0b66, // Odia
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0xff10, // Fullwidth
];

// Normalise ANY of those scripts' decimal digits to ASCII — language-agnostic.
function asciifyDigits(text: string): string {
  return Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      for (const zero of DIGIT_ZEROS) {
        if (code >= zero && code <= zero + 9) return String(code - zero);
      }
      return ch;
    })
    .join("");
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Detect ANY future date the patient mentions in chat and return it as an ISO
// string (resolves the next occurrence — not limited to a fixed window). Works
// across ALL supported languages: it normalises any script's DIGITS to ASCII
// (the universal path), handles today/tomorrow + spelled-out numbers, English
// month names, and resolves a bare day-of-month to its next future occurrence
// (this month if still ahead, else next month). Returns null if no date.
function detectDateFromText(text: string): string | null {
  const lower = text.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // "today" / "tomorrow" across en + the 8 supported Indian languages.
  const TODAY = /\btoday\b|आज|আজ|இன்று|నేడు|ఈరోజు|ಇಂದು|ഇന്ന്|आज्/u;
  const TOMORROW =
    /\btomorrow\b|कल|आगामी कल|আগামীকাল|কাল|நாளை|రేపు|ನಾಳೆ|നാളെ|उद्या/u;
  if (TODAY.test(lower)) return toIso(today);
  if (TOMORROW.test(lower)) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    return toIso(t);
  }

  // Spelled-out day numbers (common languages). The digit path below covers
  // everyone who types a numeral, so this is best-effort enrichment only.
  const NUM_WORDS: Record<string, number> = {
    // English
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30,
    // Hindi
    एक: 1, दो: 2, तीन: 3, चार: 4, पाँच: 5, पांच: 5, छह: 6, सात: 7, आठ: 8,
    नौ: 9, दस: 10,
    // Bengali
    এক: 1, দুই: 2, তিন: 3, চার: 4, পাঁচ: 5, ছয়: 6, সাত: 7, আট: 8, নয়: 9,
    দশ: 10,
    // Tamil
    ஒன்று: 1, இரண்டு: 2, மூன்று: 3, நான்கு: 4, ஐந்து: 5, ஆறு: 6, ஏழு: 7,
    எட்டு: 8, ஒன்பது: 9, பத்து: 10,
    // Telugu
    ఒకటి: 1, రెండు: 2, మూడు: 3, నాలుగు: 4, ఐదు: 5, ఆరు: 6, ఏడు: 7, ఎనిమిది: 8,
    తొమ్మిది: 9, పది: 10,
    // Kannada
    ಒಂದು: 1, ಎರಡು: 2, ಮೂರು: 3, ನಾಲ್ಕು: 4, ಐದು: 5, ಆರು: 6, ಏಳು: 7, ಎಂಟು: 8,
    ಒಂಬತ್ತು: 9, ಹತ್ತು: 10,
    // Malayalam
    ഒന്ന്: 1, രണ്ട്: 2, മൂന്ന്: 3, നാല്: 4, അഞ്ച്: 5, ആറ്: 6, ഏഴ്: 7, എട്ട്: 8,
    ഒമ്പത്: 9, പത്ത്: 10,
    // Marathi (reuses Devanagari)
    एकवीस: 21,
  };

  let ascii = asciifyDigits(text).toLowerCase();
  for (const [word, n] of Object.entries(NUM_WORDS)) {
    ascii = ascii.replace(new RegExp(word, "gi"), ` ${n} `);
  }

  // Month names → 0-based index, across English + Indian languages. Each
  // inner array lists alternative spellings for that month (Jan…Dec).
  const MONTH_ALIASES: string[][] = [
    ["jan", "january", "জানু", "जनवरी", "जाने"],
    ["feb", "february", "ফেব্রু", "फरवरी", "फेब्रु"],
    ["mar", "march", "মার্চ", "मार्च"],
    ["apr", "april", "এপ্রিল", "अप्रैल", "एप्रिल"],
    ["may", "মে", "मई"],
    ["jun", "june", "জুন", "জুনের", "जून"],
    ["jul", "july", "জুলাই", "जुलाई"],
    ["aug", "august", "আগস্ট", "अगस्त"],
    ["sep", "sept", "september", "সেপ্টেম্বর", "সেপ্টে", "सितंबर", "सितम्बर"],
    ["oct", "october", "অক্টোবর", "अक्टूबर", "ऑक्टो"],
    ["nov", "november", "নভেম্বর", "नवंबर", "नवम्बर"],
    ["dec", "december", "ডিসেম্বর", "दिसंबर", "दिसम्बर"],
  ];
  let explicitMonth: number | null = null;
  for (let m = 0; m < MONTH_ALIASES.length; m++) {
    if (MONTH_ALIASES[m].some((alias) => ascii.includes(alias))) {
      explicitMonth = m;
      break;
    }
  }

  // "date" markers across languages — a number is only treated as a BOOKING
  // date when it sits next to one of these (or a month name / explicit
  // booking-intent word). This avoids reading durations like "two days" /
  // "दो दिन से बुखार" / "3 weeks" as a date.
  const DATE_MARKER =
    "tarikh|tareekh|তারিখ|তারিখে|তারিখ|को|तारीख|தேதி|తేదీ|ದಿನಾಂಕ|തീയതി";
  // Duration words that mean "for N days/weeks/..." — NOT a date.
  const DURATION_AFTER =
    "day|days|week|weeks|month|months|hour|hours|din|dino|দিন|সপ্তাহ|hafte|hafta|week";

  let num: string | undefined;

  // 1) A number directly before a date marker ("8 तारीख", "12 তারিখে").
  const nearMarker = ascii.match(
    new RegExp(`(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*(?:${DATE_MARKER})`, "i"),
  );
  if (nearMarker) num = nearMarker[1];

  // 2) A number next to a month name ("12 June", "June 12").
  if (!num && explicitMonth !== null) {
    const monthRe = MONTH_ALIASES[explicitMonth]
      .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const beforeMonth = ascii.match(
      new RegExp(`(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*(?:${monthRe})`, "i"),
    );
    const afterMonth = ascii.match(
      new RegExp(`(?:${monthRe})\\s*(\\d{1,2})`, "i"),
    );
    num = beforeMonth?.[1] ?? afterMonth?.[1];
  }

  // 3) An explicit ordinal ("the 8th", "on 20") — but NOT if it's followed by
  //    a duration word ("2 days"). Only with an ordinal suffix or an "on"/
  //    booking cue do we accept a bare number, so durations don't false-match.
  if (!num) {
    const ordinal = ascii.match(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s*(?:${DURATION_AFTER}))`,
        "i",
      ),
    );
    if (ordinal) num = ordinal[1];
  }
  if (!num) {
    // "on the 8" / "book ... 8" — a number preceded by a booking cue.
    const cued = ascii.match(
      new RegExp(
        `(?:on|book(?:ing)?|appointment|chahiye|kijiye|chai|date|day)\\s*(?:the\\s*)?(\\d{1,2})\\b(?!\\s*(?:${DURATION_AFTER}))`,
        "i",
      ),
    );
    if (cued) num = cued[1];
  }

  if (!num) return null;
  const day = parseInt(num, 10);
  if (day < 1 || day > 31) return null;

  // "next month" hint.
  const nextMonth = /next month|अगले महीने|আগামী মাসে/u.test(ascii);

  // Build the target date. If a month was named, use it; else the current
  // month — and if that day has already passed (or "next month" was said),
  // roll to the following month. Clamp the day to the month's length.
  const candidate = new Date(today);
  const targetMonth =
    explicitMonth !== null ? explicitMonth : today.getMonth();
  let targetYear = today.getFullYear();
  if (explicitMonth !== null && explicitMonth < today.getMonth()) {
    targetYear += 1; // a past month name means next year
  }
  // Clamp day to that month's max.
  const maxDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const clampedDay = Math.min(day, maxDay);
  candidate.setFullYear(targetYear, targetMonth, clampedDay);

  // If no explicit month and the day is in the past (or "next month"), advance.
  if (
    explicitMonth === null &&
    (nextMonth || candidate.getTime() < today.getTime())
  ) {
    candidate.setMonth(candidate.getMonth() + 1, Math.min(day, 28));
    const m2 = new Date(
      candidate.getFullYear(),
      candidate.getMonth() + 1,
      0,
    ).getDate();
    candidate.setDate(Math.min(day, m2));
  }
  return toIso(candidate);
}

// Normalise a typed phone to E.164 for Firebase (mirrors patient/login).
function normaliseToE164(input: string): string | null {
  const trimmed = input.trim().replace(/[\s-]/g, "");
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;
  if (/^\d{10}$/.test(trimmed)) return `+91${trimmed}`; // India default
  return null;
}

// DOB dropdown options.
const DOB_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOB_THIS_YEAR = new Date().getFullYear();
// 120 years back → today (oldest plausible patient first when reversed).
const DOB_YEARS = Array.from({ length: 120 }, (_, i) => DOB_THIS_YEAR - i);

// ── FancySelect ──────────────────────────────────────────────────────────
// A styled, animated dropdown (native <select> can't be skinned internally).
// Closes on outside-click / Escape, animates the popover, highlights the
// selected option. Used for the DOB Day / Month / Year pickers.
interface FancyOption {
  value: string;
  label: string;
}
function FancySelect({
  value,
  onChange,
  options,
  placeholder,
  testId,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FancyOption[];
  placeholder: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Detect dark mode → hand the portal popover a SOLID hex background.
  const [isDark, setIsDark] = useState(false);
  // Position of the open menu (computed from the trigger's rect). The menu is
  // PORTALED to <body> so it escapes the card's `backdrop-blur` context, which
  // otherwise forced the menu background to composite as translucent.
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => setMounted(true), []);

  function openMenu() {
    setIsDark(document.documentElement.classList.contains("dark"));
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.bottom + 6, width: r.width });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function reposition() {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left, top: r.bottom + 6, width: r.width });
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`flex w-full items-center justify-between gap-1 rounded-xl border bg-white px-3 py-3 text-sm shadow-sm transition-all duration-200 hover:border-gray-400 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:bg-gray-900 ${
          open
            ? "border-blue-500 ring-4 ring-blue-500/15"
            : "border-gray-300 dark:border-gray-700"
        }`}
      >
        <span
          className={
            selected
              ? "text-gray-900 dark:text-gray-100"
              : "text-gray-400 dark:text-gray-500"
          }
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${
            open ? "rotate-180 text-blue-500" : ""
          }`}
        />
      </button>
      {mounted &&
        open &&
        rect &&
        createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            className="fixed z-[1000] max-h-56 origin-top overflow-y-auto rounded-xl border border-gray-200 p-1 shadow-2xl ring-1 ring-black/10 mc-anim-scale-in dark:border-gray-600 dark:ring-white/10"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              backgroundColor: isDark ? "#0f172a" : "#ffffff",
            }}
          >
            {options.map((o) => {
              const isSel = o.value === value;
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      isSel
                        ? "bg-gradient-to-r from-blue-600 to-indigo-600 font-medium text-white shadow-sm"
                        : "text-gray-700 hover:bg-blue-50 hover:text-blue-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:hover:text-white"
                    }`}
                  >
                    {o.label}
                    {isSel && <Check className="h-4 w-4" />}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}

export default function QuickBookPage() {
  const router = useRouter();
  // 30-day base window (scrollable strip). A date the patient names in chat
  // that falls outside this window is appended via `extraDates`.
  const baseDays = nextDays(30);
  const [extraDates, setExtraDates] = useState<string[]>([]);
  // Merge base + any chat-added dates, sorted, de-duped.
  const days = (() => {
    const map = new Map<string, { iso: string; weekday: string; day: string }>();
    for (const d of baseDays) map.set(d.iso, d);
    for (const iso of extraDates) {
      if (!map.has(iso)) {
        const dt = new Date(iso);
        map.set(iso, {
          iso,
          weekday: dt.toLocaleDateString("en-IN", { weekday: "short" }),
          day: String(dt.getDate()).padStart(2, "0"),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.iso.localeCompare(b.iso));
  })();

  const [step, setStep] = useState<Step>("identity");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identityErrors, setIdentityErrors] =
    useState<QuickBookIdentityErrors>({});

  // Cycling headline word — the WHOLE phrase re-animates (slides L→R) each time
  // the word changes. `headlineKey` bumps to retrigger the slide animation.
  const HEADLINE_WORDS = [
    "appointment",
    "consultation",
    "check-up",
    "follow-up",
    "doctor visit",
  ];
  const [headlineWord, setHeadlineWord] = useState(0);
  const [headlineKey, setHeadlineKey] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setHeadlineWord((w) => (w + 1) % HEADLINE_WORDS.length);
      setHeadlineKey((k) => k + 1);
    }, 3200);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [date, setDate] = useState(days[0].iso);
  const [doctors, setDoctors] = useState<DoctorSuggestion[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<DoctorSuggestion | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  // Hospital selection. The AI asks which hospital once it's ready to suggest
  // doctors; the chat shows these as clickable chips. The chosen tenantId
  // scopes the doctor suggestions + the booking to that hospital.
  const [hospitals, setHospitals] = useState<
    Array<{ id: string; name: string; code: string | null }>
  >([]);
  const [tenantId, setTenantId] = useState("");
  // True once the chat is ready for doctors but the patient hasn't picked a
  // hospital yet → the chat shows the hospital chips instead of doctors.
  const [awaitingHospital, setAwaitingHospital] = useState(false);
  // Infinite scroll for the hospital picker: with many hospitals the list
  // would grow unbounded and push the page. We cap the panel height + scroll,
  // and only render `hospitalVisibleCount` rows, revealing another page as the
  // user nears the bottom. Reset to one page each time the picker (re)opens.
  const HOSPITAL_PAGE = 8;
  const [hospitalVisibleCount, setHospitalVisibleCount] = useState(HOSPITAL_PAGE);
  useEffect(() => {
    if (awaitingHospital) setHospitalVisibleCount(HOSPITAL_PAGE);
  }, [awaitingHospital]);
  // Reveal the next page when the scroll position is within ~120px of the end.
  function onHospitalScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setHospitalVisibleCount((c) =>
        c >= hospitals.length
          ? c
          : Math.min(c + HOSPITAL_PAGE, hospitals.length),
      );
    }
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/public/hospitals`);
        const json = await res.json();
        if (cancelled) return;
        const list = (json?.data ?? []) as Array<{
          id: string;
          name: string;
          code: string | null;
        }>;
        setHospitals(list);
        // If there's only one hospital, pick it silently — no need to ask.
        if (list.length === 1) setTenantId(list[0].id);
      } catch {
        // Non-fatal: booking falls back to subdomain/default tenant.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Identity (collected FIRST). Gender + DOB required; email optional.
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<"" | "MALE" | "FEMALE" | "OTHER">("");
  // DOB is composed from three friendly dropdowns (day / month / year) and
  // stored as the same YYYY-MM-DD string the API expects.
  const [dob, setDob] = useState("");
  const [dobDay, setDobDay] = useState("");
  const [dobMonth, setDobMonth] = useState("");
  const [dobYear, setDobYear] = useState("");
  const [email, setEmail] = useState("");

  // ── ABHA (ABDM M1 V3) "Continue with Aadhaar" state ──────────────────
  // Optional identity shortcut: the patient enters their Aadhaar, gets an
  // OTP, and on verify we auto-populate the identity fields from their ABHA
  // profile. Calls the PUBLIC endpoints with bare fetch (same convention as
  // the rest of this page). The Aadhaar/OTP go straight to the API over
  // HTTPS and are RSA-encrypted server-side — we never store them here.
  const [abhaOpen, setAbhaOpen] = useState(false);
  const [abhaStage, setAbhaStage] = useState<"aadhaar" | "otp">("aadhaar");
  const [abhaAadhaar, setAbhaAadhaar] = useState("");
  const [abhaOtp, setAbhaOtp] = useState("");
  const [abhaMobile, setAbhaMobile] = useState("");
  const [abhaTxnId, setAbhaTxnId] = useState("");
  const [abhaBusy, setAbhaBusy] = useState(false);
  const [abhaError, setAbhaError] = useState<string | null>(null);
  // Set once a profile has been fetched — shows the linked-ABHA banner.
  const [abhaNumber, setAbhaNumber] = useState<string | null>(null);
  const [abhaAddress, setAbhaAddress] = useState<string | null>(null);

  // AI chat state. The conversation lives only in the browser; on "Find a
  // doctor" the user turns are concatenated into the symptom text.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [emergency, setEmergency] = useState<string | null>(null);
  // Detected language of the patient's voice input (e.g. "bn-IN"). Sent to the
  // chat so the AI replies in the SAME language the patient spoke.
  const [chatLanguage, setChatLanguage] = useState<string | null>(null);
  // The scrollable messages container — we scroll THIS element (not the page)
  // so new messages don't push the whole page down.
  const messagesBoxRef = useRef<HTMLDivElement | null>(null);
  // The AI "decides" the patient has described enough, then a doctor panel
  // appears beside the chat. `doctorsLoading` covers the fetch; `doctorsSearched`
  // flips true after the first attempt so we can show a "no doctors" message
  // even when the result is empty.
  const [doctorsLoading, setDoctorsLoading] = useState(false);
  const [doctorsSearched, setDoctorsSearched] = useState(false);

  // Voice input (Sarvam) — shared by the chat composer. `voiceState` drives
  // the mic button; the recorder POSTs to /public/booking/transcribe.
  const [voiceState, setVoiceState] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // OTP step state (verify the WhatsApp number → sets the patient session).
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);

  const [confirmation, setConfirmation] = useState<{
    doctorName: string;
    date: string;
    slotStart: string | null;
    displayToken: string | null;
  } | null>(null);

  // Auto-scroll ONLY the chat box to the newest message — never the page.
  // (scrollIntoView would scroll every ancestor incl. the window, making the
  // whole page jump down on each message.)
  useEffect(() => {
    const box = messagesBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, chatBusy]);

  // Re-fetch suggestions when the date changes IF the panel is already open
  // (the patient has described enough and a doctor list is showing).
  useEffect(() => {
    if (step === "chat" && doctors.length > 0) {
      setSelectedSlot(null);
      void loadDoctorSuggestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Mount the invisible reCAPTCHA verifier ONLY once we reach the OTP step —
  // not on page load. (Mounting it on Step 1 made Google's reCAPTCHA badge /
  // "localhost not supported" warning appear before the user ever needs OTP.)
  // The #qb-recaptcha container is always in the DOM, so this is safe to defer.
  useEffect(() => {
    if (step !== "otp") return;
    try {
      ensureRecaptcha("qb-recaptcha");
    } catch (err) {
      setOtpError(
        err instanceof Error
          ? err.message
          : "Verification is unavailable right now.",
      );
    }
    return () => disposeRecaptcha();
  }, [step]);

  const [otpSent, setOtpSent] = useState(false);
  useEffect(() => {
    if (step !== "otp" || otpSent) return;
    setOtpSent(true);
    void requestOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, otpSent]);

  // Recompose the YYYY-MM-DD `dob` whenever a day/month/year dropdown changes.
  // Clamps the day to the chosen month/year so e.g. 31 Feb can't be submitted.
  function setDobPart(part: "day" | "month" | "year", value: string) {
    const day = part === "day" ? value : dobDay;
    const month = part === "month" ? value : dobMonth; // 1-12 as string
    const year = part === "year" ? value : dobYear;
    if (part === "day") setDobDay(value);
    if (part === "month") setDobMonth(value);
    if (part === "year") setDobYear(value);
    if (day && month && year) {
      const maxDay = new Date(Number(year), Number(month), 0).getDate();
      const clampedDay = Math.min(Number(day), maxDay);
      if (clampedDay !== Number(day)) setDobDay(String(clampedDay));
      setDob(
        `${year}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`,
      );
    } else {
      setDob("");
    }
  }

  // ── ABHA: apply a fetched profile onto the identity fields ───────────
  function applyAbhaProfile(profile: {
    abhaNumber?: string | null;
    abhaAddress?: string | null;
    name?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    mobile?: string | null;
    email?: string | null;
  }) {
    if (profile.name) setName(profile.name);
    if (profile.mobile) {
      // Keep the last 10 digits as the WhatsApp number.
      const digits = profile.mobile.replace(/\D/g, "");
      if (digits.length >= 10) setPhone(digits.slice(-10));
    }
    if (profile.gender) {
      const g = profile.gender.trim().toUpperCase();
      setGender(
        g.startsWith("M") ? "MALE" : g.startsWith("F") ? "FEMALE" : "OTHER",
      );
    }
    if (profile.email) setEmail(profile.email);
    // DOB — accept YYYY-MM-DD, DD-MM-YYYY, or a bare year.
    if (profile.dateOfBirth) {
      const raw = profile.dateOfBirth.trim();
      let y = "";
      let m = "";
      let d = "";
      const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      const dmy = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (iso) {
        [, y, m, d] = iso;
      } else if (dmy) {
        [, d, m, y] = dmy;
      } else if (/^\d{4}$/.test(raw)) {
        y = raw;
      }
      if (y) setDobYear(y);
      if (m) setDobMonth(String(Number(m)));
      if (d) setDobDay(String(Number(d)));
      if (y && m && d) {
        setDob(
          `${y}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`,
        );
      }
    }
    setAbhaNumber(profile.abhaNumber ?? null);
    setAbhaAddress(profile.abhaAddress ?? null);
  }

  // ── ABHA step 1: request the Aadhaar OTP ─────────────────────────────
  async function requestAbhaOtp() {
    setAbhaError(null);
    const digits = abhaAadhaar.replace(/\D/g, "");
    if (!/^\d{12}$/.test(digits)) {
      setAbhaError("Enter a valid 12-digit Aadhaar number.");
      return;
    }
    setAbhaBusy(true);
    try {
      const res = await fetch(`${API_BASE}/public/abha/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aadhaar: digits }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.data?.txnId) {
        throw new Error(json?.error || "Could not send the Aadhaar OTP. Try again.");
      }
      setAbhaTxnId(json.data.txnId);
      setAbhaStage("otp");
      // Prefill the OTP-stage mobile from the WhatsApp number if entered.
      const wa = phone.replace(/\D/g, "");
      if (wa.length >= 10) setAbhaMobile(wa.slice(-10));
    } catch (err) {
      setAbhaError(err instanceof Error ? err.message : "Could not send the OTP.");
    } finally {
      setAbhaBusy(false);
    }
  }

  // ── ABHA step 2: verify OTP → create/fetch ABHA → auto-populate ──────
  async function verifyAbhaOtp() {
    setAbhaError(null);
    if (!/^\d{4,8}$/.test(abhaOtp.trim())) {
      setAbhaError("Enter the OTP sent to your Aadhaar-linked mobile.");
      return;
    }
    const mobile = abhaMobile.replace(/\D/g, "");
    if (!/^\d{10}$/.test(mobile)) {
      setAbhaError("Enter the 10-digit mobile linked to this ABHA/Aadhaar.");
      return;
    }
    setAbhaBusy(true);
    try {
      const res = await fetch(`${API_BASE}/public/abha/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txnId: abhaTxnId,
          otp: abhaOtp.trim(),
          mobile,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.data?.profile) {
        throw new Error(json?.error || "OTP verification failed. Try again.");
      }
      applyAbhaProfile(json.data.profile);
      setAbhaOpen(false); // collapse to the linked-ABHA banner
      setAbhaStage("aadhaar");
      setAbhaAadhaar("");
      setAbhaOtp("");
    } catch (err) {
      setAbhaError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setAbhaBusy(false);
    }
  }

  // ── Step 1 → 2: identity gate ────────────────────────────────────────
  function startChat() {
    setError(null);
    const nextErrors = validateQuickBookIdentity({
      name,
      phone,
      gender,
      dob,
      email,
    });
    setIdentityErrors(nextErrors);
    const firstError = firstQuickBookIdentityError(nextErrors);
    if (firstError) {
      setError(firstError);
      return;
    }
    // Seed the assistant greeting (knows the patient's first name).
    const firstName = name.trim().split(/\s+/)[0];
    setMessages([
      {
        role: "assistant",
        content: `Hi ${firstName}! I'm your MedCore assistant. Tell me what's bothering you — your symptoms, how long you've had them, anything that helps. You can type or tap the mic to speak. When you're ready, tap "Find a doctor".`,
      },
    ]);
    setStep("chat");
  }

  // ── Step 2: AI chat ──────────────────────────────────────────────────
  async function sendChat(text: string) {
    const content = text.trim();
    if (!content || chatBusy || emergency) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setChatInput("");
    setChatBusy(true);

    // If the patient named ANY future date ("on the 8th", "15 June", "আট
    // তারিখে", "tomorrow", "next month 5th"), auto-switch the picker — adding
    // it as a chip if it's outside the visible 30-day strip — and fetch
    // doctors for that day.
    const detected = detectDateFromText(content);
    const effectiveDate = detected ?? date;
    if (detected && detected !== date) {
      if (!days.some((d) => d.iso === detected)) {
        setExtraDates((prev) =>
          prev.includes(detected) ? prev : [...prev, detected],
        );
      }
      setDate(detected);
      setSelectedSlot(null);
    }
    try {
      const res = await fetch(`${API_BASE}/public/booking/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next,
          name: name.trim(),
          // Reply in the language the patient spoke (if detected via voice).
          ...(chatLanguage ? { language: chatLanguage } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "The assistant is busy. Please try again.");
        return;
      }
      if (json.data?.isEmergency) {
        setEmergency(json.data.emergencyReason || "This may be an emergency.");
        return;
      }
      const reply = (json.data?.reply ?? "").trim();
      if (reply) {
        setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      }
      // Confirm an auto-switched date in the chat so the change is visible.
      if (detected && detected !== date) {
        const pretty = new Date(detected).toLocaleDateString("en-IN", {
          weekday: "long",
          day: "numeric",
          month: "short",
        });
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Got it — I'll look for doctors on ${pretty}. 📅`,
          },
        ]);
      }
      // Fetch doctors when: the server says we're ready, the panel is already
      // open, OR the patient just named a date (so we honour the requested day
      // right away). Use the freshly-detected date if any.
      const readyToSuggest =
        json.data?.readyForDoctors || doctors.length > 0 || detected;
      if (readyToSuggest) {
        // Before suggesting doctors, the patient must pick a HOSPITAL (the AI
        // asks). If there are several hospitals and none chosen yet, show the
        // hospital chips instead of loading doctors. Once chosen (or only one
        // hospital exists), load the doctors scoped to it.
        if (!tenantId && hospitals.length > 1) {
          setAwaitingHospital(true);
        } else {
          void loadDoctorSuggestions(next, effectiveDate);
        }
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setChatBusy(false);
    }
  }

  // Silent fetch — concatenate the user turns into one symptom string and
  // populate the doctor panel that sits beside the chat. Re-run when the date
  // changes (the date strip stays in the chat). Does NOT change the step.
  // `dateOverride` lets a freshly-detected chat date be used immediately
  // (React's `date` state hasn't updated yet within the same handler).
  // `tenantOverride` does the same for the hospital: when called straight from
  // the hospital-chip click, `setTenantId(h.id)` hasn't applied yet, so the
  // caller passes `h.id` here so suggestions are scoped to the chosen hospital
  // (without it the request would fall back to the default tenant — the cause
  // of "I picked Kolkata but got Default doctors / my appointment vanished").
  async function loadDoctorSuggestions(
    history?: ChatMessage[],
    dateOverride?: string,
    tenantOverride?: string,
  ) {
    const src = history ?? messages;
    const symptomText = src
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(". ")
      .trim();
    if (symptomText.length < 2) return;
    setDoctorsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/public/booking/suggest-doctors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symptom: symptomText,
          date: dateOverride ?? date,
          // Scope suggestions to the chosen hospital. Prefer the explicit
          // override (fresh chip click) over the possibly-stale state.
          tenantId: tenantOverride || tenantId || undefined,
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setDoctors(json.data?.doctors ?? []);
      } else {
        setDoctors([]);
      }
    } catch {
      setDoctors([]);
    } finally {
      setDoctorsSearched(true);
      setDoctorsLoading(false);
    }
  }

  // ── Voice input (Sarvam) — fills the chat composer ───────────────────
  async function toggleVoice() {
    setError(null);
    if (voiceState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (voiceState === "transcribing") return;

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Voice input isn't supported in this browser. Please type instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone permission denied. Please allow it or type instead.");
      return;
    }

    audioChunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(audioChunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      if (blob.size === 0) {
        setVoiceState("idle");
        return;
      }
      setVoiceState("transcribing");
      try {
        const base64 = await blobToBase64(blob);
        const res = await fetch(`${API_BASE}/public/booking/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: base64 }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error || "Couldn't understand the audio. Please type instead.");
        } else {
          const text = (json.data?.transcript ?? "").trim();
          if (text) {
            setChatInput((prev) => (prev ? `${prev} ${text}` : text));
            // Remember the spoken language so the AI replies in it.
            if (json.data?.language) setChatLanguage(json.data.language);
          } else {
            setError("Didn't catch that. Please try again or type instead.");
          }
        }
      } catch {
        setError("Network error during transcription. Please type instead.");
      } finally {
        setVoiceState("idle");
      }
    };
    recorder.start();
    setVoiceState("recording");
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── Step 3: book the picked doctor/slot (identity already collected) ──
  async function confirmBooking() {
    setError(null);
    if (!selectedDoctor) {
      setError("Please pick a doctor.");
      return;
    }
    // SLOT mode needs a time; TOKEN/CALLING book against the date with no slot.
    if (selectedDoctor.appointmentMode === "SLOT" && !selectedSlot) {
      setError("Please pick a time slot.");
      return;
    }
    setBusy(true);
    try {
      const symptomText = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join(". ")
        .trim();
      const res = await fetch(`${API_BASE}/public/booking/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          doctorId: selectedDoctor.doctorId,
          date,
          // Only SLOT mode carries a slotId.
          ...(selectedDoctor.appointmentMode === "SLOT" && selectedSlot
            ? { slotId: selectedSlot }
            : {}),
          symptom: symptomText || undefined,
          gender,
          dateOfBirth: dob,
          email: email.trim() || undefined,
          // The chosen hospital — books into it and keys patient identity on
          // (phone + name + this tenant).
          tenantId: tenantId || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error || "Couldn't complete your booking. Please try again.");
        return;
      }
      setConfirmation({
        doctorName: json.data.doctorName,
        date: json.data.date,
        slotStart: json.data.slotStart,
        displayToken: json.data.displayToken,
      });
      setStep("otp");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // ── OTP via Firebase Phone Auth (SAME path as patient/login) ─────────
  async function requestOtp() {
    setOtpError(null);
    const e164 = normaliseToE164(phone);
    if (!e164) {
      setOtpError("Enter a valid phone number to receive the code.");
      return;
    }
    try {
      await sendOtp(e164);
    } catch (err) {
      setOtpError(
        err instanceof Error
          ? err.message
          : "Couldn't send the code. Tap resend to retry.",
      );
    }
  }

  async function verifyOtp() {
    setOtpError(null);
    if (!/^\d{6}$/.test(otp.trim())) {
      setOtpError("Enter the 6-digit code from the SMS.");
      return;
    }
    setBusy(true);
    try {
      const idToken = await firebaseVerifyOtp(otp.trim());
      const res = await fetch(`${API_BASE}/patient-auth/firebase-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        // Send the booked name so (phone + name) resolves to THIS chart when
        // the phone has multiple accounts (e.g. a family share one number).
        body: JSON.stringify({ idToken, name: name.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setOtpError(json.error || "Couldn't sign you in. Please try again.");
        return;
      }
      router.push("/patient/dashboard");
    } catch (err) {
      setOtpError(
        err instanceof Error ? err.message : "Couldn't verify the code.",
      );
    } finally {
      setBusy(false);
    }
  }

  const primaryBtn =
    "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full bg-gradient-to-r from-blue-600 via-indigo-600 to-emerald-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-blue-600/40 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-lg";
  const ghostBtn =
    "inline-flex items-center justify-center gap-2 rounded-full border border-gray-300 bg-white/60 px-5 py-3 text-sm font-medium text-gray-700 backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-300 hover:bg-white hover:shadow-md dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:bg-gray-800";
  const inputCls =
    "w-full rounded-xl border border-gray-300 bg-white/80 px-4 py-3 text-sm shadow-sm transition-all duration-200 placeholder:text-gray-400 hover:border-gray-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-900/80 dark:text-gray-100 dark:hover:border-gray-600";
  const fieldErrorCls = "mt-1 text-xs font-medium text-red-600 dark:text-red-300";
  const inputClassFor = (field: keyof QuickBookIdentityErrors) =>
    identityErrors[field]
      ? `${inputCls} border-red-400 focus:border-red-500 focus:ring-red-500/15 dark:border-red-500`
      : inputCls;

  const stepOrder: Step[] = ["identity", "chat", "doctor", "otp", "done"];
  const hasUserTurn = messages.some((m) => m.role === "user");

  return (
    <section className="relative overflow-hidden">
      {/* Animated gradient backdrop + floating colour blobs */}
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.12),transparent_60%)] dark:bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.22),transparent_60%)]" />
      <div className="pointer-events-none absolute -left-24 top-10 -z-10 h-72 w-72 rounded-full bg-blue-400/20 blur-3xl mc-anim-blob dark:bg-blue-600/20" />
      <div className="pointer-events-none absolute -right-24 top-40 -z-10 h-80 w-80 rounded-full bg-emerald-400/20 blur-3xl mc-anim-blob [animation-delay:3s] dark:bg-emerald-600/20" />
      <div className="pointer-events-none absolute bottom-0 left-1/3 -z-10 h-72 w-72 rounded-full bg-indigo-400/15 blur-3xl mc-anim-blob [animation-delay:6s] dark:bg-indigo-600/15" />

      <Container className="py-16 md:py-20">
        <div className="flex flex-col items-start gap-10 lg:flex-row lg:gap-12">
          {/* ════ LEFT: about MedCore — HIDDEN once the chat's side-panel
              layout is active (the hospital picker OR the doctor suggestions)
              so the panel has room and the chat stays readable. ════ */}
          <aside
            className={`w-full lg:sticky lg:top-24 lg:w-[38%] lg:shrink-0 mc-anim-slide-left ${
              step === "chat" &&
              (awaitingHospital ||
                doctors.length > 0 ||
                doctorsLoading ||
                doctorsSearched)
                ? "hidden"
                : ""
            }`}
          >
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50/80 px-4 py-1.5 text-sm font-medium text-blue-700 shadow-sm backdrop-blur mc-anim-pop dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Book in under a minute — no account needed
            </div>
            <h1 className="overflow-hidden text-3xl font-extrabold leading-tight tracking-tight text-gray-900 sm:text-4xl lg:text-5xl dark:text-white">
              {/* The WHOLE phrase re-animates (glides L→R) on each word change. */}
              <span
                key={headlineKey}
                className="mc-will-transform block transform-gpu mc-anim-headline"
              >
                Book your{" "}
                <span className="mc-gradient-animate bg-gradient-to-r from-blue-600 via-indigo-500 to-emerald-500 bg-clip-text text-transparent">
                  {HEADLINE_WORDS[headlineWord]}
                </span>{" "}
                with MedCore
              </span>
            </h1>
            <p className="mt-4 max-w-md text-gray-600 dark:text-gray-400">
              Tell our AI assistant what's wrong, and we'll match you to the
              right doctor on our panel — then text your confirmation on
              WhatsApp. No account, no paperwork.
            </p>

            {/* Value props */}
            <ul className="mt-8 space-y-5">
              {[
                {
                  icon: Bot,
                  title: "AI finds your doctor",
                  desc: "Describe your symptoms — our assistant routes you to the right specialist.",
                },
                {
                  icon: ShieldCheck,
                  title: "Verified doctors",
                  desc: "Every doctor on our panel is credential-checked.",
                },
                {
                  icon: Clock,
                  title: "Book in under a minute",
                  desc: "No account, no paperwork. Just a few taps.",
                },
                {
                  icon: Phone,
                  title: "WhatsApp confirmation",
                  desc: "Your appointment details land straight on WhatsApp.",
                },
              ].map((f, i) => (
                <li
                  key={f.title}
                  className={`flex gap-3.5 mc-anim-slide-up mc-delay-${i + 1}`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-md shadow-blue-500/20">
                    <f.icon className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="font-semibold text-gray-800 dark:text-gray-100">
                      {f.title}
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                      {f.desc}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            {/* Trust stats */}
            <div className="mt-8 grid max-w-sm grid-cols-4 gap-3 rounded-2xl border border-white/60 bg-white/70 p-4 shadow-lg backdrop-blur dark:border-white/10 dark:bg-gray-900/60">
              {[
                { value: "50k+", label: "Patients" },
                { value: "300+", label: "Doctors" },
                { value: "4.8★", label: "Rating" },
                { value: "<60s", label: "To book" },
              ].map((s, i) => (
                <div key={s.label} className={`text-center mc-anim-pop mc-delay-${i + 1}`}>
                  <p className="bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text text-lg font-extrabold text-transparent">
                    {s.value}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    {s.label}
                  </p>
                </div>
              ))}
            </div>

            <p className="mt-5 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              End-to-end encrypted · Your data stays in India
            </p>
          </aside>

          {/* ════ RIGHT: the booking form ════ */}
          <div
            className={`mx-auto w-full min-w-0 transition-all duration-500 ease-out lg:flex-1 ${
              step === "chat"
                ? awaitingHospital ||
                  doctors.length > 0 ||
                  doctorsLoading ||
                  doctorsSearched
                  ? "max-w-none" // full width — info column is hidden here
                  : "max-w-3xl"
                : "max-w-2xl"
            }`}
          >
          <div
            data-testid="quick-book-card"
            className="rounded-3xl border border-white/60 bg-white/80 p-6 shadow-2xl shadow-blue-900/5 ring-1 ring-black/[0.02] backdrop-blur-xl mc-anim-scale-in sm:p-8 dark:border-white/10 dark:bg-gray-900/80 dark:shadow-black/20"
          >
            {/* Step indicator */}
            <ol className="mb-7 flex items-start justify-center gap-2 text-xs font-medium">
              {(["identity", "chat", "doctor"] as Step[]).map((s, i) => {
                const active = step === s;
                const done = stepOrder.indexOf(step) > i;
                return (
                  <li key={s} className="flex items-center gap-2">
                    <span className="flex flex-col items-center gap-1">
                      <span
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300 ${
                          active
                            ? "scale-110 bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-600/30 mc-anim-glow"
                            : done
                              ? "bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/20"
                              : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500"
                        }`}
                      >
                        {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                      </span>
                      <span
                        className={`text-[10px] font-medium capitalize transition-colors ${
                          active
                            ? "text-blue-600 dark:text-blue-400"
                            : done
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-gray-400 dark:text-gray-600"
                        }`}
                      >
                        {s === "identity" ? "You" : s === "chat" ? "Symptoms" : "Doctor"}
                      </span>
                    </span>
                    {i < 2 && (
                      <span
                        className={`mb-4 h-0.5 w-8 rounded-full transition-colors duration-500 ${
                          done
                            ? "bg-gradient-to-r from-emerald-500 to-teal-500"
                            : "bg-gray-200 dark:bg-gray-800"
                        }`}
                      />
                    )}
                  </li>
                );
              })}
            </ol>

            {error && (
              <p
                role="alert"
                data-testid="quick-book-error"
                className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 mc-anim-pop dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}

            {/* ── Step 1: identity ── */}
            {step === "identity" && (
              <div className="space-y-5">
                {/* ── Continue with Aadhaar (ABHA) ── */}
                {abhaNumber ? (
                  // Linked — collapse to a success banner.
                  <div
                    data-testid="quick-book-abha-linked"
                    className="flex items-start justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 mc-anim-pop dark:border-emerald-900/50 dark:bg-emerald-950/40"
                  >
                    <div className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <div>
                        <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                          ABHA linked — details auto-filled
                        </p>
                        <p className="text-xs text-emerald-700 dark:text-emerald-300">
                          {abhaAddress ?? abhaNumber}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      data-testid="quick-book-abha-clear"
                      onClick={() => {
                        setAbhaNumber(null);
                        setAbhaAddress(null);
                      }}
                      className="text-xs font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900 dark:text-emerald-300"
                    >
                      Clear
                    </button>
                  </div>
                ) : abhaOpen ? (
                  <div
                    data-testid="quick-book-abha-panel"
                    className="rounded-2xl border border-blue-200 bg-blue-50/60 p-4 mc-anim-pop dark:border-blue-900/50 dark:bg-blue-950/30"
                  >
                    {abhaError && (
                      <p
                        role="alert"
                        data-testid="quick-book-abha-error"
                        className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                      >
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {abhaError}
                      </p>
                    )}
                    {abhaStage === "aadhaar" ? (
                      <>
                        <label
                          htmlFor="qb-abha-aadhaar"
                          className="mb-1.5 block text-sm font-medium text-gray-800 dark:text-gray-200"
                        >
                          Aadhaar number
                        </label>
                        <input
                          id="qb-abha-aadhaar"
                          data-testid="quick-book-abha-aadhaar"
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={14}
                          value={abhaAadhaar}
                          onChange={(e) => setAbhaAadhaar(e.target.value)}
                          placeholder="12-digit Aadhaar"
                          className={inputCls}
                        />
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          We'll send an OTP to your Aadhaar-linked mobile. Your
                          Aadhaar is encrypted and never stored.
                        </p>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            data-testid="quick-book-abha-send-otp"
                            disabled={abhaBusy}
                            onClick={() => void requestAbhaOtp()}
                            className={`${primaryBtn} flex-1`}
                          >
                            <span className="relative z-10 inline-flex items-center gap-2">
                              {abhaBusy ? "Sending…" : "Send OTP"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAbhaOpen(false);
                              setAbhaError(null);
                            }}
                            className={ghostBtn}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <label
                          htmlFor="qb-abha-otp"
                          className="mb-1.5 block text-sm font-medium text-gray-800 dark:text-gray-200"
                        >
                          Enter OTP
                        </label>
                        <input
                          id="qb-abha-otp"
                          data-testid="quick-book-abha-otp"
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={8}
                          value={abhaOtp}
                          onChange={(e) => setAbhaOtp(e.target.value)}
                          placeholder="OTP"
                          className={inputCls}
                        />
                        <label
                          htmlFor="qb-abha-mobile"
                          className="mb-1.5 mt-3 block text-sm font-medium text-gray-800 dark:text-gray-200"
                        >
                          Mobile linked to ABHA
                        </label>
                        <input
                          id="qb-abha-mobile"
                          data-testid="quick-book-abha-mobile"
                          type="tel"
                          inputMode="tel"
                          maxLength={10}
                          value={abhaMobile}
                          onChange={(e) => setAbhaMobile(e.target.value)}
                          placeholder="10-digit mobile"
                          className={inputCls}
                        />
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            data-testid="quick-book-abha-verify"
                            disabled={abhaBusy}
                            onClick={() => void verifyAbhaOtp()}
                            className={`${primaryBtn} flex-1`}
                          >
                            <span className="relative z-10 inline-flex items-center gap-2">
                              {abhaBusy ? "Verifying…" : "Verify & auto-fill"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAbhaStage("aadhaar");
                              setAbhaError(null);
                            }}
                            className={ghostBtn}
                          >
                            Back
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="mc-anim-slide-up">
                    <button
                      type="button"
                      data-testid="quick-book-abha-start"
                      onClick={() => {
                        setAbhaOpen(true);
                        setAbhaStage("aadhaar");
                        setAbhaError(null);
                      }}
                      className={`${ghostBtn} w-full justify-center border-blue-300 text-blue-700 hover:border-blue-400 dark:border-blue-800 dark:text-blue-300`}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Continue with Aadhaar (ABHA)
                    </button>
                    <p className="mt-1.5 text-center text-xs text-gray-500 dark:text-gray-400">
                      Auto-fill your details from your ABHA — or enter them
                      manually below.
                    </p>
                  </div>
                )}

                <div className="mc-anim-slide-up mc-delay-1">
                  <label
                    htmlFor="qb-name"
                    className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    <User className="h-4 w-4 text-blue-600" />
                    Your name
                  </label>
                  <input
                    id="qb-name"
                    data-testid="quick-book-name"
                    type="text"
                    value={name}
                    aria-invalid={!!identityErrors.name}
                    aria-describedby={
                      identityErrors.name ? "quick-book-name-error" : undefined
                    }
                    onChange={(e) => {
                      setName(e.target.value);
                      setIdentityErrors((prev) => ({ ...prev, name: undefined }));
                    }}
                    placeholder="Full name"
                    className={inputClassFor("name")}
                  />
                  {identityErrors.name && (
                    <p
                      id="quick-book-name-error"
                      data-testid="quick-book-name-error"
                      className={fieldErrorCls}
                    >
                      {identityErrors.name}
                    </p>
                  )}
                </div>
                <div className="mc-anim-slide-up mc-delay-2">
                  <label
                    htmlFor="qb-phone"
                    className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    <Phone className="h-4 w-4 text-blue-600" />
                    WhatsApp number
                  </label>
                  <input
                    id="qb-phone"
                    data-testid="quick-book-phone"
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    aria-invalid={!!identityErrors.phone}
                    aria-describedby={
                      identityErrors.phone ? "quick-book-phone-error" : undefined
                    }
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setIdentityErrors((prev) => ({ ...prev, phone: undefined }));
                    }}
                    placeholder="+91 9876543210"
                    className={inputClassFor("phone")}
                  />
                  {identityErrors.phone && (
                    <p
                      id="quick-book-phone-error"
                      data-testid="quick-book-phone-error"
                      className={fieldErrorCls}
                    >
                      {identityErrors.phone}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    We'll send your confirmation here. You can sign in later with
                    this number.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-5 mc-anim-slide-up mc-delay-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="qb-gender"
                      className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                    >
                      <User className="h-4 w-4 text-blue-600" />
                      Gender
                    </label>
                    <FancySelect
                      testId="quick-book-gender"
                      ariaLabel="Gender"
                      placeholder="Select…"
                      value={gender}
                      onChange={(v) => {
                        setGender(v as typeof gender);
                        setIdentityErrors((prev) => ({ ...prev, gender: undefined }));
                      }}
                      options={[
                        { value: "MALE", label: "Male" },
                        { value: "FEMALE", label: "Female" },
                        { value: "OTHER", label: "Other" },
                      ]}
                    />
                    {identityErrors.gender && (
                      <p
                        data-testid="quick-book-gender-error"
                        className={fieldErrorCls}
                      >
                        {identityErrors.gender}
                      </p>
                    )}
                  </div>
                  <div className="sm:col-span-2">
                    <label
                      htmlFor="qb-dob-day"
                      className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                    >
                      <Cake className="h-4 w-4 text-blue-600" />
                      Date of birth
                    </label>
                    {/* Friendly, animated day / month / year pickers. */}
                    <div
                      className="grid grid-cols-3 gap-2"
                      data-testid="quick-book-dob"
                    >
                      <FancySelect
                        testId="quick-book-dob-day"
                        ariaLabel="Day of birth"
                        placeholder="Day"
                        value={dobDay}
                        onChange={(v) => {
                          setDobPart("day", v);
                          setIdentityErrors((prev) => ({ ...prev, dob: undefined }));
                        }}
                        options={Array.from({ length: 31 }, (_, i) => ({
                          value: String(i + 1),
                          label: String(i + 1),
                        }))}
                      />
                      <FancySelect
                        testId="quick-book-dob-month"
                        ariaLabel="Month of birth"
                        placeholder="Month"
                        value={dobMonth}
                        onChange={(v) => {
                          setDobPart("month", v);
                          setIdentityErrors((prev) => ({ ...prev, dob: undefined }));
                        }}
                        options={DOB_MONTHS.map((m, i) => ({
                          value: String(i + 1),
                          label: m,
                        }))}
                      />
                      <FancySelect
                        testId="quick-book-dob-year"
                        ariaLabel="Year of birth"
                        placeholder="Year"
                        value={dobYear}
                        onChange={(v) => {
                          setDobPart("year", v);
                          setIdentityErrors((prev) => ({ ...prev, dob: undefined }));
                        }}
                        options={DOB_YEARS.map((y) => ({
                          value: String(y),
                          label: String(y),
                        }))}
                      />
                    </div>
                    {dob && (
                      <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                        {new Date(dob).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })}
                      </p>
                    )}
                    {identityErrors.dob && (
                      <p
                        data-testid="quick-book-dob-error"
                        className={fieldErrorCls}
                      >
                        {identityErrors.dob}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mc-anim-slide-up mc-delay-4">
                  <label
                    htmlFor="qb-email"
                    className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    <Mail className="h-4 w-4 text-blue-600" />
                    Email <span className="text-xs text-gray-400">(optional)</span>
                  </label>
                  <input
                    id="qb-email"
                    data-testid="quick-book-email"
                    type="email"
                    inputMode="email"
                    value={email}
                    aria-invalid={!!identityErrors.email}
                    aria-describedby={
                      identityErrors.email ? "quick-book-email-error" : undefined
                    }
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setIdentityErrors((prev) => ({ ...prev, email: undefined }));
                    }}
                    placeholder="you@example.com"
                    className={inputClassFor("email")}
                  />
                  {identityErrors.email && (
                    <p
                      id="quick-book-email-error"
                      data-testid="quick-book-email-error"
                      className={fieldErrorCls}
                    >
                      {identityErrors.email}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  data-testid="quick-book-to-chat"
                  disabled={busy}
                  onClick={() => startChat()}
                  className={`${primaryBtn} mc-shimmer mc-anim-slide-up mc-delay-5 w-full`}
                >
                  <span className="relative z-10 inline-flex items-center gap-2">
                    Continue
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </button>
              </div>
            )}

            {/* ── Step 2: AI chat ── */}
            {step === "chat" && (
              <div data-testid="quick-book-chat" className="mc-anim-slide-right">
                {emergency ? (
                  <div
                    role="alert"
                    data-testid="quick-book-emergency"
                    className="rounded-2xl border border-red-300 bg-red-50 p-5 text-center dark:border-red-800 dark:bg-red-950/40"
                  >
                    <AlertTriangle className="mx-auto mb-2 h-9 w-9 text-red-600 dark:text-red-400" />
                    <p className="font-semibold text-red-800 dark:text-red-200">
                      This may need urgent care
                    </p>
                    <p className="mt-1 text-sm text-red-700 dark:text-red-300">
                      {emergency} Please call emergency services (112) or visit
                      the nearest emergency room right away.
                    </p>
                  </div>
                ) : (
                  // Two-column: chat card + an AI-suggested doctor/hospital
                  // panel beside it once the assistant has enough info.
                  // `lg:flex-wrap` lets the side panel drop below the chat when
                  // there isn't room for both at full width — so the chat never
                  // collapses to an unreadable sliver.
                  <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap">
                    {/* ── Doctor panel (AI-suggested) ── */}
                    {/* Hospital picker — the AI asks which hospital before
                        suggesting doctors. Shown when ready-for-doctors but no
                        hospital chosen yet. Tapping a chip scopes the
                        suggestions + booking to that tenant. */}
                    {awaitingHospital && (
                      <div
                        data-testid="quick-book-hospitals"
                        className="flex w-full flex-col self-start overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-lg shadow-emerald-500/10 mc-anim-slide-left lg:order-first lg:w-[26rem] lg:shrink-0 dark:border-emerald-900/50 dark:bg-gray-800"
                      >
                        <div className="flex items-center gap-2 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-5 py-4 dark:border-gray-700 dark:from-emerald-950 dark:to-teal-950">
                          <Stethoscope className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                          <p className="text-base font-semibold text-gray-800 dark:text-gray-100">
                            Which hospital would you like to visit?
                          </p>
                        </div>
                        {/* Scrollable list — capped height so a long hospital
                            roster scrolls inside the panel instead of pushing
                            the page. Rows render incrementally (infinite scroll)
                            via onHospitalScroll. */}
                        <div
                          onScroll={onHospitalScroll}
                          data-testid="quick-book-hospitals-scroll"
                          className="flex max-h-[26rem] flex-col gap-3 overflow-y-auto p-4"
                        >
                          {hospitals.slice(0, hospitalVisibleCount).map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              data-testid={`quick-book-hospital-${h.id}`}
                              onClick={() => {
                                setTenantId(h.id);
                                setAwaitingHospital(false);
                                // Pass h.id explicitly — setTenantId hasn't
                                // applied yet this tick, so the suggestion fetch
                                // must use the fresh id or it scopes to default.
                                void loadDoctorSuggestions(undefined, date, h.id);
                              }}
                              className="group flex shrink-0 items-center justify-between rounded-xl border-2 border-gray-200 px-5 py-4 text-left transition hover:border-emerald-500 hover:bg-emerald-50 hover:shadow-md dark:border-gray-700 dark:hover:bg-gray-700"
                            >
                              <span className="flex flex-col">
                                <span className="text-base font-semibold text-gray-900 dark:text-gray-100">
                                  {h.name}
                                </span>
                                {h.code ? (
                                  <span className="text-xs text-gray-500 dark:text-gray-400">
                                    {h.code}
                                  </span>
                                ) : null}
                              </span>
                              <span
                                aria-hidden
                                className="text-lg text-gray-400 transition group-hover:translate-x-0.5 group-hover:text-emerald-600"
                              >
                                →
                              </span>
                            </button>
                          ))}
                          {hospitalVisibleCount < hospitals.length && (
                            <p
                              data-testid="quick-book-hospitals-more"
                              className="py-1 text-center text-xs text-gray-400 dark:text-gray-500"
                            >
                              Scroll for more — showing {hospitalVisibleCount} of{" "}
                              {hospitals.length}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                    {(doctors.length > 0 || doctorsLoading || doctorsSearched) && (
                      <div
                        data-testid="quick-book-doctors"
                        className="flex w-full flex-col overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-lg shadow-emerald-500/10 mc-anim-slide-left lg:order-first lg:h-[38rem] lg:w-[26rem] dark:border-emerald-900/50 dark:bg-gray-800"
                      >
                        <div className="flex items-center gap-2 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50 px-4 py-3 dark:border-gray-700 dark:from-emerald-950 dark:to-teal-950">
                          <Stethoscope className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                            Suggested doctors
                          </p>
                          {doctorsLoading && (
                            <Loader2 className="ml-auto h-4 w-4 animate-spin text-emerald-500" />
                          )}
                        </div>
                        <div className="flex-1 space-y-3 overflow-y-auto p-3">
                          <p className="px-1 text-xs text-gray-500 dark:text-gray-400">
                            Based on what you told the assistant, for{" "}
                            {new Date(date).toLocaleDateString("en-IN", {
                              weekday: "short",
                              day: "numeric",
                              month: "short",
                            })}
                            .
                          </p>
                          {/* Skeleton loader while the AI fetches doctors */}
                          {doctorsLoading && doctors.length === 0 && (
                            <div className="space-y-3">
                              {[0, 1, 2].map((k) => (
                                <div
                                  key={k}
                                  className="relative overflow-hidden rounded-xl border border-gray-200 p-3 mc-shimmer dark:border-gray-700"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex-1 space-y-2">
                                      <div className="mc-skeleton h-3.5 w-3/5 rounded" />
                                      <div className="mc-skeleton h-2.5 w-2/5 rounded" />
                                    </div>
                                    <div className="mc-skeleton h-5 w-10 rounded-full" />
                                  </div>
                                  <div className="mt-3 flex gap-1.5">
                                    <div className="mc-skeleton h-6 w-12 rounded-lg" />
                                    <div className="mc-skeleton h-6 w-12 rounded-lg" />
                                    <div className="mc-skeleton h-6 w-12 rounded-lg" />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {doctors.length === 0 && !doctorsLoading && doctorsSearched && (
                            <div
                              data-testid="quick-book-no-doctors"
                              className="flex flex-col items-center rounded-xl border border-dashed border-gray-300 bg-gray-50/60 px-4 py-8 text-center mc-anim-pop dark:border-gray-700 dark:bg-gray-900/40"
                            >
                              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
                                <CalendarX className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                              </div>
                              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                                No doctors available
                              </p>
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                We couldn't find an open doctor for{" "}
                                <span className="font-medium text-gray-700 dark:text-gray-300">
                                  {new Date(date).toLocaleDateString("en-IN", {
                                    weekday: "long",
                                    day: "numeric",
                                    month: "short",
                                  })}
                                </span>
                                . Try picking another date below, or describe your
                                symptoms in a bit more detail.
                              </p>
                            </div>
                          )}
                          {doctors.map((d, di) => {
                            const picked = selectedDoctor?.doctorId === d.doctorId;
                            return (
                              <div
                                key={d.doctorId}
                                data-testid={`quick-book-doctor-${d.doctorId}`}
                                className={`rounded-xl border p-3 transition-all duration-200 mc-anim-pop mc-delay-${di + 1} hover:shadow-md ${
                                  picked
                                    ? "border-blue-600 bg-blue-50/50 shadow-md shadow-blue-500/10 dark:bg-blue-950/30"
                                    : "border-gray-200 hover:border-blue-300 dark:border-gray-700"
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedDoctor(d);
                                    setSelectedSlot(null);
                                  }}
                                  className="flex w-full items-start justify-between gap-2 text-left"
                                >
                                  <div className="min-w-0">
                                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                      {d.name}
                                    </p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                      {d.specialization ?? "General"}
                                      {d.experienceYears
                                        ? ` · ${d.experienceYears} yrs`
                                        : ""}
                                    </p>
                                  </div>
                                  {d.averageRating ? (
                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                      <Star className="h-3 w-3 fill-current" />
                                      {d.averageRating.toFixed(1)}
                                    </span>
                                  ) : null}
                                </button>
                                {picked && d.appointmentMode === "SLOT" && (
                                  <div className="mt-2" data-testid="quick-book-slots">
                                    <div className="flex flex-wrap gap-1.5">
                                      {d.slots.map((s) => (
                                        <button
                                          key={s}
                                          type="button"
                                          data-testid={`quick-book-slot-${s}`}
                                          onClick={() => setSelectedSlot(s)}
                                          className={`rounded-lg border px-2 py-1 text-xs transition ${
                                            selectedSlot === s
                                              ? "border-blue-600 bg-blue-600 text-white"
                                              : "border-gray-300 text-gray-700 hover:border-blue-400 dark:border-gray-600 dark:text-gray-200"
                                          }`}
                                        >
                                          {s}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {picked && d.appointmentMode === "TOKEN" && (
                                  <div
                                    className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs dark:bg-blue-950/30"
                                    data-testid="quick-book-token"
                                  >
                                    <p className="text-gray-600 dark:text-gray-300">
                                      Token booking for{" "}
                                      <span className="font-semibold">
                                        {fmtDateLabel(date)}
                                      </span>
                                    </p>
                                    {d.nextToken != null && (
                                      <p className="mt-0.5 text-gray-500 dark:text-gray-400">
                                        Your token will be{" "}
                                        <span className="font-semibold text-blue-700 dark:text-blue-300">
                                          #{d.nextToken}
                                        </span>
                                      </p>
                                    )}
                                  </div>
                                )}
                                {picked && d.appointmentMode === "CALLING" && (
                                  <div
                                    className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs dark:bg-emerald-950/30"
                                    data-testid="quick-book-calling"
                                  >
                                    <p className="text-gray-600 dark:text-gray-300">
                                      Booking for{" "}
                                      <span className="font-semibold">
                                        {fmtDateLabel(date)}
                                      </span>
                                    </p>
                                    <p className="mt-0.5 text-gray-500 dark:text-gray-400">
                                      You&apos;ll be seen by arrival order — no fixed
                                      time.
                                    </p>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="border-t border-gray-100 p-3 dark:border-gray-700">
                          <button
                            type="button"
                            data-testid="quick-book-confirm"
                            disabled={
                              busy ||
                              !selectedDoctor ||
                              // SLOT mode needs a picked time; TOKEN/CALLING
                              // book against the date with no slot.
                              (selectedDoctor?.appointmentMode === "SLOT" &&
                                !selectedSlot)
                            }
                            onClick={() => void confirmBooking()}
                            className={`${primaryBtn} mc-shimmer w-full justify-center`}
                          >
                            {busy ? "Booking…" : "Book appointment"}
                            {!busy && <ArrowRight className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* ── Chat card ──
                        `lg:min-w-[22rem]` stops the chat from collapsing to a
                        sliver (one-word-per-line wrap) when the hospital/doctor
                        panel sits beside it on desktop. */}
                    <div className="flex h-[34rem] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg shadow-blue-500/5 lg:h-[38rem] lg:min-w-[22rem] dark:border-gray-700 dark:bg-gray-800">
                      {/* Header */}
                      <div className="flex items-center gap-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-3 dark:border-gray-700 dark:from-blue-950 dark:to-indigo-950">
                        <div className="relative flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 shadow-md shadow-blue-600/30">
                          <Bot className="h-5 w-5 text-white" />
                          <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-white bg-emerald-500 dark:border-gray-800" />
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                            MedCore AI Assistant
                          </p>
                          <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            Online — routing assistant
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setStep("identity")}
                          className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-white/60 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/60"
                        >
                          <ArrowLeft className="h-3.5 w-3.5" />
                          Back
                        </button>
                      </div>

                      {/* Messages (fills available height) */}
                      <div
                        ref={messagesBoxRef}
                        className="flex-1 space-y-3 overflow-y-auto p-4"
                      >
                        {messages.map((m, i) => (
                          <div
                            key={i}
                            className={`flex gap-2 ${
                              m.role === "user"
                                ? "justify-end mc-anim-pop"
                                : "justify-start mc-anim-slide-left"
                            }`}
                          >
                            {m.role === "assistant" && (
                              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm shadow-blue-500/30">
                                <Bot className="h-4 w-4 text-white" />
                              </div>
                            )}
                            <div
                              className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm shadow-sm transition-shadow ${
                                m.role === "user"
                                  ? "rounded-tr-sm bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-blue-600/20"
                                  : "rounded-tl-sm bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-100"
                              }`}
                            >
                              {m.content}
                            </div>
                            {m.role === "user" && (
                              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 shadow-sm shadow-blue-600/30">
                                <User className="h-4 w-4 text-white" />
                              </div>
                            )}
                          </div>
                        ))}
                        {chatBusy && (
                          <div className="flex justify-start gap-2 mc-anim-slide-left">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm shadow-blue-500/30">
                              <Bot className="h-4 w-4 text-white" />
                            </div>
                            <div className="rounded-2xl rounded-tl-sm bg-gray-100 px-4 py-3 dark:bg-gray-700">
                              <div className="flex h-4 items-center gap-1.5">
                                <span className="h-2 w-2 animate-bounce rounded-full bg-blue-400 [animation-delay:0ms]" />
                                <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-400 [animation-delay:150ms]" />
                                <span className="h-2 w-2 animate-bounce rounded-full bg-emerald-400 [animation-delay:300ms]" />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Input bar */}
                      <div className="border-t border-gray-100 p-3 dark:border-gray-700">
                        <div className="flex gap-2">
                          <input
                            data-testid="quick-book-chat-input"
                            type="text"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void sendChat(chatInput);
                            }}
                            placeholder="Describe your symptoms…"
                            disabled={chatBusy}
                            className="flex-1 rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800"
                          />
                          <button
                            type="button"
                            data-testid="quick-book-voice"
                            onClick={() => void toggleVoice()}
                            disabled={voiceState === "transcribing" || chatBusy}
                            title={
                              voiceState === "recording"
                                ? "Stop listening"
                                : "Start voice input"
                            }
                            className={`flex h-9 w-9 items-center justify-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-50 ${
                              voiceState === "recording"
                                ? "bg-red-500 text-white hover:bg-red-600"
                                : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                            }`}
                          >
                            {voiceState === "transcribing" ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : voiceState === "recording" ? (
                              <Square className="h-4 w-4" />
                            ) : (
                              <Mic className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            data-testid="quick-book-chat-send"
                            onClick={() => void sendChat(chatInput)}
                            disabled={chatBusy || !chatInput.trim()}
                            aria-label="Send"
                            className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Send className="h-4 w-4" />
                          </button>
                        </div>

                        {/* Date strip — horizontally scrollable; drives the
                            suggested doctors' availability. */}
                        <div className="mt-3" data-testid="quick-book-dates">
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                              <Calendar className="h-3.5 w-3.5" />
                              Booking for
                            </span>
                            <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                              {new Date(date).toLocaleDateString("en-IN", {
                                weekday: "long",
                                day: "numeric",
                                month: "short",
                              })}
                            </span>
                          </div>
                          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
                            {days.map((d) => {
                              const dt = new Date(d.iso);
                              return (
                                <button
                                  key={d.iso}
                                  type="button"
                                  onClick={() => setDate(d.iso)}
                                  data-testid={`quick-book-date-${d.iso}`}
                                  className={`flex shrink-0 flex-col items-center rounded-lg border px-2.5 py-1.5 text-xs transition-all duration-200 hover:-translate-y-0.5 ${
                                    date === d.iso
                                      ? "border-blue-600 bg-blue-50 font-semibold text-blue-700 shadow-sm shadow-blue-500/20 dark:bg-blue-950/50 dark:text-blue-300"
                                      : "border-gray-200 text-gray-600 hover:border-blue-300 dark:border-gray-700 dark:text-gray-300"
                                  }`}
                                >
                                  <span className="text-[10px] uppercase opacity-70">
                                    {d.weekday}
                                  </span>
                                  <span className="text-sm font-bold leading-none">
                                    {d.day}
                                  </span>
                                  <span className="text-[9px] opacity-60">
                                    {dt.toLocaleDateString("en-IN", { month: "short" })}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        {doctors.length === 0 && !doctorsLoading && (
                          <p className="mt-2 text-center text-xs text-gray-400 dark:text-gray-500">
                            {hasUserTurn
                              ? "Answer the assistant's questions — it'll suggest doctors once it understands your problem."
                              : "Tell the assistant your symptoms — it'll suggest doctors here."}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── OTP verification → dashboard ── */}
            {step === "otp" && (
              <div className="space-y-5 mc-anim-slide-up" data-testid="quick-book-otp">
                <div className="text-center">
                  <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                    <ShieldCheck className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                    Verify your number
                  </h2>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    Your appointment is booked, and your confirmation is on its
                    way via WhatsApp. We also sent a 6-digit verification code by
                    SMS to{" "}
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {phone.trim()}
                    </span>{" "}
                    — enter it to open your dashboard.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="qb-otp"
                    className="mb-1.5 block text-sm font-medium text-gray-800 dark:text-gray-200"
                  >
                    6-digit code
                  </label>
                  <input
                    id="qb-otp"
                    data-testid="quick-book-otp-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otp}
                    onChange={(e) =>
                      setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="••••••"
                    className={`${inputCls} text-center text-lg tracking-[0.4em]`}
                  />
                  {otpError ? (
                    <p
                      role="alert"
                      data-testid="quick-book-otp-error"
                      className="mt-2 text-sm text-red-600 dark:text-red-400"
                    >
                      {otpError}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  data-testid="quick-book-otp-verify"
                  disabled={busy}
                  onClick={() => void verifyOtp()}
                  className={`${primaryBtn} w-full justify-center`}
                >
                  {busy ? "Verifying…" : "Verify & open dashboard"}
                </button>
                <div className="flex items-center justify-between text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      resetPhoneAuthState();
                      setOtp("");
                      void requestOtp();
                    }}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep("done")}
                    className="text-gray-500 hover:underline dark:text-gray-400"
                  >
                    Skip for now
                  </button>
                </div>
              </div>
            )}

            {/* ── Done ── */}
            {step === "done" && confirmation && (
              <div className="text-center mc-anim-fade-up" data-testid="quick-book-done">
                <div className="relative mx-auto mb-4 flex h-20 w-20 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-30" />
                  <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 shadow-lg shadow-emerald-500/40 mc-anim-pop">
                    <CheckCircle2 className="h-9 w-9 text-white" />
                  </span>
                </div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                  You're booked!
                </h2>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                  Your appointment with{" "}
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {confirmation.doctorName}
                  </span>{" "}
                  on{" "}
                  {new Date(confirmation.date).toLocaleDateString("en-IN", {
                    weekday: "long",
                    day: "numeric",
                    month: "short",
                  })}
                  {confirmation.slotStart ? ` at ${confirmation.slotStart}` : ""} is
                  confirmed.
                </p>
                {confirmation.displayToken && (
                  <div className="mt-6 flex justify-center">
                    <div className="relative mc-anim-pop">
                      {/* Pulsing glow ring */}
                      <div className="absolute -inset-3 rounded-3xl bg-gradient-to-r from-blue-500/30 via-indigo-500/30 to-emerald-500/30 blur-xl mc-anim-glow" />
                      <div className="relative flex flex-col items-center rounded-3xl border border-white/40 bg-gradient-to-br from-blue-600 via-indigo-600 to-emerald-500 px-10 py-5 shadow-2xl shadow-blue-600/30 dark:border-white/10">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/80">
                          Your token
                        </span>
                        <span className="mc-anim-token bg-gradient-to-b from-white to-blue-100 bg-clip-text text-6xl font-black leading-none text-transparent drop-shadow-sm">
                          {confirmation.displayToken}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                  We've sent the details to your WhatsApp. Sign in anytime with your
                  phone number to view appointments and reports.
                </p>
                <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <Link href="/patient/login" className={primaryBtn}>
                    Sign in with my number
                  </Link>
                  <Link href="/" className={ghostBtn}>
                    Back to home
                  </Link>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
        {/* Invisible reCAPTCHA mount — ALWAYS in the DOM (not gated on the OTP
            step) so ensureRecaptcha("qb-recaptcha") never runs before its
            container exists. Firebase attaches the invisible widget here. */}
        <div id="qb-recaptcha" />
      </Container>
    </section>
  );
}
