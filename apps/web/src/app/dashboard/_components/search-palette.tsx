"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  Search,
  User,
  Calendar,
  FileText,
  CreditCard,
  BedDouble,
  Scissors,
  FlaskConical,
  Tag,
  X,
  Clock,
} from "lucide-react";

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
}

const typeIcon: Record<string, React.ElementType> = {
  patient: User,
  appointment: Calendar,
  prescription: FileText,
  invoice: CreditCard,
  admission: BedDouble,
  surgery: Scissors,
  lab: FlaskConical,
  label: Tag,
};

const typeLabel: Record<string, string> = {
  patient: "Patients",
  appointment: "Appointments",
  prescription: "Prescriptions",
  invoice: "Invoices",
  admission: "Admissions",
  surgery: "Surgeries",
  lab: "Lab Orders",
  label: "Modules",
};

// Issue #877: the previous implementation stored recent searches under a
// single global key, "medcore:recent-search". When one user (e.g. an admin
// searching for "Fatima") logged out and a different user (e.g. a patient)
// logged in on the same browser, the patient saw the admin's search
// history in the Ctrl+K palette. That's a cross-user privacy leak — names,
// MR numbers and phone numbers leak across roles.
//
// Fix: key the recent-search list by user id. Each user only ever reads
// and writes their own slot. The legacy global key is wiped on first read
// after this code ships so any pre-existing leak self-heals (we don't
// need a server-side migration).
const LEGACY_RECENT_KEY = "medcore:recent-search";

function recentKeyFor(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `medcore:recent-search:${userId}`;
}

function loadRecent(userId: string | null | undefined): string[] {
  if (typeof window === "undefined") return [];
  // One-time legacy-key cleanup. Runs at most once per user-id slot we
  // touch; cheap (a single localStorage.removeItem) and idempotent.
  try {
    localStorage.removeItem(LEGACY_RECENT_KEY);
  } catch {
    // ignore — localStorage can be disabled (incognito quota, etc.)
  }
  const key = recentKeyFor(userId);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(userId: string | null | undefined, q: string) {
  if (typeof window === "undefined" || !q) return;
  const key = recentKeyFor(userId);
  if (!key) return; // refuse to write when we don't know whose history this is
  const cur = loadRecent(userId);
  const next = [q, ...cur.filter((x) => x !== q)].slice(0, 8);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore — localStorage can be full or disabled
  }
}

export function SearchPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  // Issue #406: the global search placeholder used to read
  // "Search patients, appointments, invoices, prescriptions..." for every
  // role — including PATIENT, who has no business searching the patient
  // roster. Tailor the hint copy to what the role can actually find.
  const role = useAuthStore((s) => s.user?.role);
  // Issue #877: recent-search history is per-user. Capture the id here so
  // loadRecent / saveRecent can scope reads + writes to the current user
  // and never leak history across logins on a shared browser.
  const userId = useAuthStore((s) => s.user?.id);
  const placeholder =
    role === "PATIENT"
      ? "Search appointments, prescriptions, bills…"
      : "Search patients, appointments, invoices, prescriptions...";

  useEffect(() => {
    if (open) {
      setRecent(loadRecent(userId));
      setQ("");
      setResults([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open, userId]);

  useEffect(() => {
    if (!open) return;
    if (!q || q.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await api.get<{ data: SearchHit[] }>(
          `/search?q=${encodeURIComponent(q.trim())}`
        );
        if (!cancelled) {
          setResults(res.data || []);
          setActive(0);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, open]);

  function go(hit: SearchHit) {
    saveRecent(userId, q.trim());
    onClose();
    if (!hit.href || hit.href === "null" || hit.href === "/dashboard/null") {
      // Issue #582 #2: a malformed search hit with no href used to silently
      // navigate to /dashboard/null and 404 the user out of their session.
      // Defensively bail rather than push a known-bad URL.
      return;
    }
    router.push(hit.href);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      // Issue #582 #2: Enter on an empty query / no results must be a
      // no-op, not "go to undefined href". Guard explicitly so a future
      // refactor can't introduce a regression where `go(undefined)`
      // silently routes to /dashboard/null.
      if (results.length === 0 || !results[active]) return;
      e.preventDefault();
      go(results[active]);
    }
  }

  if (!open) return null;

  // Group results by type
  // Issue #582 #4: same hit was rendered multiple times when a single
  // result row matched both the title and a sub-field (because the API
  // emits separate rows for partial-match types). De-dupe by `type+id`
  // before bucketing so the user sees each entity exactly once.
  const seen = new Set<string>();
  const groups: Array<{ type: string; items: SearchHit[] }> = [];
  for (const r of results) {
    const dedupeKey = `${r.type}::${r.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    let g = groups.find((x) => x.type === r.type);
    if (!g) {
      g = { type: r.type, items: [] };
      groups.push(g);
    }
    g.items.push(r);
  }

  let idx = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl bg-white text-gray-900 shadow-xl dark:bg-gray-900 dark:text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-white/10">
          <Search size={18} className="text-gray-400" />
          {/* Issue #655: typed text was invisible on dark theme — input had no
              explicit text color so it inherited the page's dark-mode fg-muted
              token. Force fg-default in both themes plus a visible caret. */}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-gray-900 caret-primary outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          {/* Issue #810: ESC kbd and close button used hardcoded light tokens —
              against the now-dark palette container they read as muddy white
              chips. Pair both with dark surface + foreground variants. */}
          <kbd className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/10 dark:text-gray-300">
            ESC
          </kbd>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {/* Issue #810: every row/state below used hardcoded light-mode
              hover/bg/text tokens — against the now-dark palette container
              the entire result list flashed white-on-dark on Ctrl+K. Each
              state now carries a paired `dark:` variant so the palette
              respects theme tokens end-to-end. */}
          {/* Recent searches (when empty) */}
          {!q && recent.length > 0 && (
            <div className="p-3">
              <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Recent
              </p>
              {recent.map((r, i) => (
                <button
                  key={i}
                  onClick={() => setQ(r)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10"
                >
                  <Clock size={14} className="text-gray-400 dark:text-gray-500" />
                  {r}
                </button>
              ))}
            </div>
          )}

          {q && loading && (
            <div className="p-6 text-center text-xs text-gray-400 dark:text-gray-500">
              Searching...
            </div>
          )}

          {q && !loading && results.length === 0 && q.length >= 2 && (
            <div className="p-6 text-center text-xs text-gray-400 dark:text-gray-500">
              No results for &quot;{q}&quot;
            </div>
          )}

          {q && q.length < 2 && (
            <div className="p-6 text-center text-xs text-gray-400 dark:text-gray-500">
              Type at least 2 characters to search
            </div>
          )}

          {!loading && groups.length > 0 && (
            <div className="py-1">
              {groups.map((g) => {
                const Icon = typeIcon[g.type] || Tag;
                return (
                  <div key={g.type} className="mb-1">
                    <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                      {typeLabel[g.type] || g.type}
                    </p>
                    {g.items.map((hit) => {
                      idx++;
                      const isActive = idx === active;
                      return (
                        <button
                          key={`${hit.type}-${hit.id}`}
                          onClick={() => go(hit)}
                          onMouseEnter={() => setActive(idx)}
                          className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition ${
                            isActive
                              ? "bg-blue-50 dark:bg-primary/20"
                              : "hover:bg-gray-50 dark:hover:bg-white/5"
                          }`}
                        >
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                              isActive
                                ? "bg-primary text-white"
                                : "bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300"
                            }`}
                          >
                            <Icon size={15} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-gray-800 dark:text-gray-100">
                              {hit.title}
                            </p>
                            <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                              {hit.subtitle}
                            </p>
                          </div>
                          {hit.meta && (
                            <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-white/10 dark:text-gray-300">
                              {hit.meta}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-4 py-2 text-[11px] text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400">
          <div className="flex gap-3">
            <span>
              <kbd className="rounded bg-white px-1 py-0.5 shadow-sm dark:bg-white/10 dark:text-gray-200 dark:shadow-none">↑↓</kbd>{" "}
              navigate
            </span>
            <span>
              <kbd className="rounded bg-white px-1 py-0.5 shadow-sm dark:bg-white/10 dark:text-gray-200 dark:shadow-none">↵</kbd>{" "}
              open
            </span>
          </div>
          <span>
            <kbd className="rounded bg-white px-1 py-0.5 shadow-sm dark:bg-white/10 dark:text-gray-200 dark:shadow-none">Ctrl+K</kbd>{" "}
            anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
