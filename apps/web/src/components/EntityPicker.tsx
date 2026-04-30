"use client";

/**
 * EntityPicker — generic, debounced search-and-pick component.
 *
 * Replaces raw "paste a UUID" text inputs across the dashboard (Issue #84).
 * Pattern lifted from the patient picker in
 * `apps/web/src/app/dashboard/appointments/page.tsx` and made reusable so
 * one component covers Certifications (users), AI Letters
 * (scribe sessions / admissions), Adherence (prescriptions), Insurance
 * (invoices / patients), Scheduled Reports, etc.
 *
 * Contract:
 *   - `endpoint` is the API path WITHOUT the `q` query param. We append
 *     `?<searchParam>=…&limit=…` ourselves.
 *   - `labelField` and (optional) `subtitleField` may be a flat key (e.g.
 *     "name") or a dotted path ("user.name", "patient.user.name") so the
 *     component can render rows that come back from list endpoints with
 *     nested includes.
 *   - `onChange(id)` emits the chosen entity's id (string) — the parent
 *     keeps the same field name for the API payload, so swapping the input
 *     for an `<EntityPicker>` is a drop-in change.
 *   - The component is uncontrolled-ish: it remembers the chosen entity's
 *     display label so a "Change" button can clear back to search mode.
 *
 * Standards (per repo CLAUDE.md):
 *   - In-DOM dropdown — no native browser dialog.
 *   - data-testid hooks on every interactive element so Playwright /
 *     screenshots can drive the picker without inspecting the DOM tree.
 *   - No `window.alert` / `prompt` / `confirm`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read a possibly-nested property from `obj` ("a.b.c"). Returns "" on miss. */
function readPath(obj: unknown, path: string): string {
  if (!obj || typeof obj !== "object") return "";
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return "";
    }
  }
  if (cur == null) return "";
  return String(cur);
}

// ISO-8601 timestamps shouldn't be rendered raw in the dropdown — they're
// noise for the user (Issue #243 called this out for adherence's
// `createdAt` hint). Detect a YYYY-MM-DDTHH:MM[:SS[.ms]]Z|±HH:MM string and
// format it as a short locale date. Anything else passes through unchanged.
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function prettyHint(raw: string): string {
  if (!raw) return raw;
  if (!ISO_LIKE.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EntityPickerProps {
  /** API path (no leading "/api/v1"). Example: "/patients", "/auth/users".
   *  We append `?<searchParam>=…&limit=…` automatically. */
  endpoint: string;
  /** Search query parameter name. Defaults to "search" — most MedCore list
   *  endpoints use that name, but a few use "q" / "query". */
  searchParam?: string;
  /** Property path to render as the row's primary line. */
  labelField: string;
  /** Optional secondary line (e.g. "user.email", "diagnosis"). */
  subtitleField?: string;
  /** Optional 3rd line, rendered in monospace — useful for codes / dates. */
  hintField?: string;
  /** Currently selected id (controlled by parent — empty string = none). */
  value: string;
  /** Called with the chosen id. Pass "" to clear. */
  onChange: (id: string, entity: Record<string, unknown> | null) => void;
  /** Placeholder for the search input. */
  searchPlaceholder?: string;
  /** Stable test-id prefix. We emit `<prefix>-input`, `<prefix>-option`,
   *  `<prefix>-clear`, etc. */
  testIdPrefix?: string;
  /** Disable the picker (e.g. while parent is submitting). */
  disabled?: boolean;
  /** Show a red asterisk after `searchPlaceholder` ARIA label. The HTML
   *  required attr is left off because the picker is not a native input —
   *  the parent should validate `value` before submit. */
  required?: boolean;
  /** Optional fixed display label when the parent already knows what was
   *  picked (e.g. on a "edit row" view). Skips the initial fetch-by-id. */
  initialLabel?: string;
  /** Limit of matches to fetch. */
  limit?: number;
  /** Minimum characters before triggering a fetch. Defaults to 2; pass 0
   *  to fetch on focus + on every keystroke (use when the endpoint URL is
   *  already pre-filtered, e.g. patient + today + active statuses on the
   *  prescription page — Issue #194). */
  minQueryLength?: number;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface ApiEnvelope<T> {
  data: T[];
}

export function EntityPicker({
  endpoint,
  searchParam = "search",
  labelField,
  subtitleField,
  hintField,
  value,
  onChange,
  searchPlaceholder = "Search...",
  testIdPrefix = "entity-picker",
  disabled,
  required,
  initialLabel,
  limit = 10,
  minQueryLength = 2,
}: EntityPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const [chosenLabel, setChosenLabel] = useState<string>(initialLabel ?? "");
  const lastReqId = useRef(0);

  // If the parent passes an `initialLabel` after-the-fact (e.g. async load),
  // mirror it.
  useEffect(() => {
    if (initialLabel !== undefined) setChosenLabel(initialLabel);
  }, [initialLabel]);

  // Whenever `value` is cleared by the parent, drop the displayed label so
  // the search input is shown again.
  useEffect(() => {
    if (!value) setChosenLabel("");
  }, [value]);

  // Debounced search — 250ms, identical to the appointments patient picker.
  useEffect(() => {
    if (value) return; // already chosen
    // Issue #194: when `minQueryLength === 0`, only fetch once the
    // dropdown is open so we don't fire an unnecessary list query on
    // mount. With `minQueryLength > 0`, the query string is the gate.
    if (minQueryLength === 0 && !open) return;
    const q = query.trim();
    if (minQueryLength > 0 && q.length < minQueryLength) {
      setResults([]);
      return;
    }
    const reqId = ++lastReqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        params.set(searchParam, q);
        params.set("limit", String(limit));
        const res = await api.get<ApiEnvelope<Record<string, unknown>>>(
          `${endpoint}?${params.toString()}`
        );
        if (reqId !== lastReqId.current) return; // raced
        setResults(Array.isArray(res.data) ? res.data : []);
      } catch {
        if (reqId === lastReqId.current) setResults([]);
      } finally {
        if (reqId === lastReqId.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, value, endpoint, searchParam, limit, minQueryLength, open]);

  const showDropdown = useMemo(
    () => open && !value && query.trim().length >= minQueryLength,
    [open, value, query, minQueryLength]
  );

  // ── Chosen state — render a chip + Change button ─────────────────────────
  if (value && chosenLabel) {
    return (
      <div
        className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/40"
        data-testid={`${testIdPrefix}-chosen`}
      >
        <span
          className="text-sm font-medium text-blue-900 dark:text-blue-200"
          data-testid={`${testIdPrefix}-chosen-label`}
        >
          {chosenLabel}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange("", null);
            setChosenLabel("");
            setQuery("");
            setResults([]);
          }}
          disabled={disabled}
          aria-label="Change selection"
          data-testid={`${testIdPrefix}-clear`}
          className="flex items-center gap-1 rounded p-1 text-xs text-blue-700 hover:bg-blue-100 hover:text-blue-900 disabled:opacity-50 dark:hover:bg-blue-900/60"
        >
          <X className="h-3.5 w-3.5" />
          Change
        </button>
      </div>
    );
  }

  // ── Search state ─────────────────────────────────────────────────────────
  return (
    <div className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          placeholder={searchPlaceholder}
          aria-required={required ? "true" : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // The 150ms blur delay matches the appointments picker — gives
          // mousedown on a list item time to land before close.
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          disabled={disabled}
          data-testid={`${testIdPrefix}-input`}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 pl-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 dark:border-gray-700 dark:bg-gray-800"
        />
      </div>

      {showDropdown && (
        <ul
          role="listbox"
          data-testid={`${testIdPrefix}-dropdown`}
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {loading && (
            <li
              className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500"
              data-testid={`${testIdPrefix}-loading`}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching...
            </li>
          )}
          {!loading && results.length === 0 && (
            <li
              className="px-3 py-2 text-xs text-gray-500"
              data-testid={`${testIdPrefix}-empty`}
            >
              No matches
            </li>
          )}
          {!loading &&
            results.map((row) => {
              const id = readPath(row, "id");
              if (!id) return null;
              const label = readPath(row, labelField) || id.slice(0, 8);
              const subtitle = subtitleField
                ? readPath(row, subtitleField)
                : "";
              const hint = hintField ? prettyHint(readPath(row, hintField)) : "";
              return (
                <li
                  key={id}
                  role="option"
                  aria-selected="false"
                  data-testid={`${testIdPrefix}-option`}
                  data-entity-id={id}
                  onMouseDown={(e) => {
                    // Prevent the input from blurring (which would close
                    // the dropdown before the click registered).
                    e.preventDefault();
                    onChange(id, row);
                    setChosenLabel(label);
                    setQuery("");
                    setResults([]);
                    setOpen(false);
                  }}
                  className="cursor-pointer px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/30"
                >
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {label}
                  </div>
                  {subtitle && (
                    <div className="text-xs text-gray-500">{subtitle}</div>
                  )}
                  {hint && (
                    <div className="font-mono text-[11px] text-gray-400">
                      {hint}
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

export default EntityPicker;
