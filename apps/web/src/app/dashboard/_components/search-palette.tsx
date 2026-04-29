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

const RECENT_KEY = "medcore:recent-search";

function loadRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(q: string) {
  if (typeof window === "undefined" || !q) return;
  const cur = loadRecent();
  const next = [q, ...cur.filter((x) => x !== q)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
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
  const placeholder =
    role === "PATIENT"
      ? "Search appointments, prescriptions, bills…"
      : "Search patients, appointments, invoices, prescriptions...";

  useEffect(() => {
    if (open) {
      setRecent(loadRecent());
      setQ("");
      setResults([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

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
    saveRecent(q.trim());
    onClose();
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
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  }

  if (!open) return null;

  // Group results by type
  const groups: Array<{ type: string; items: SearchHit[] }> = [];
  for (const r of results) {
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
        className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search size={18} className="text-gray-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
          />
          <kbd className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
            ESC
          </kbd>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {/* Recent searches (when empty) */}
          {!q && recent.length > 0 && (
            <div className="p-3">
              <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                Recent
              </p>
              {recent.map((r, i) => (
                <button
                  key={i}
                  onClick={() => setQ(r)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
                >
                  <Clock size={14} className="text-gray-400" />
                  {r}
                </button>
              ))}
            </div>
          )}

          {q && loading && (
            <div className="p-6 text-center text-xs text-gray-400">
              Searching...
            </div>
          )}

          {q && !loading && results.length === 0 && q.length >= 2 && (
            <div className="p-6 text-center text-xs text-gray-400">
              No results for &quot;{q}&quot;
            </div>
          )}

          {q && q.length < 2 && (
            <div className="p-6 text-center text-xs text-gray-400">
              Type at least 2 characters to search
            </div>
          )}

          {!loading && groups.length > 0 && (
            <div className="py-1">
              {groups.map((g) => {
                const Icon = typeIcon[g.type] || Tag;
                return (
                  <div key={g.type} className="mb-1">
                    <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
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
                            isActive ? "bg-blue-50" : "hover:bg-gray-50"
                          }`}
                        >
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                              isActive
                                ? "bg-primary text-white"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            <Icon size={15} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-gray-800">
                              {hit.title}
                            </p>
                            <p className="truncate text-xs text-gray-500">
                              {hit.subtitle}
                            </p>
                          </div>
                          {hit.meta && (
                            <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
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

        <div className="flex items-center justify-between border-t bg-gray-50 px-4 py-2 text-[11px] text-gray-500">
          <div className="flex gap-3">
            <span>
              <kbd className="rounded bg-white px-1 py-0.5 shadow-sm">↑↓</kbd>{" "}
              navigate
            </span>
            <span>
              <kbd className="rounded bg-white px-1 py-0.5 shadow-sm">↵</kbd>{" "}
              open
            </span>
          </div>
          <span>
            <kbd className="rounded bg-white px-1 py-0.5 shadow-sm">Ctrl+K</kbd>{" "}
            anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
