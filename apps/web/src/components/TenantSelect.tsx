// Reusable tenant picker for super-admin surfaces (patients/admissions/doctors
// filter + register/add forms, and any future per-tenant control). A custom
// dropdown rather than a native <select> so we can (a) cap the options list to
// a fixed-height inner scroller for long tenant lists and (b) colour-highlight
// the platform's "default" tenant (subdomain="default") + tag it so it stands
// out.
//
// The options panel renders in a PORTAL with fixed positioning (auto-flips up
// when there's no room below) so it is never clipped by a scrollable ancestor
// — e.g. the Add Doctor modal, where an absolutely-positioned panel was cut
// off at the modal's bottom edge. Closes on outside-click / Escape; repositions
// on scroll/resize. Super-admin-only by convention — the caller decides whether
// to render it.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export interface TenantOption {
  id: string;
  name: string;
  subdomain: string;
}

interface TenantSelectProps {
  tenants: TenantOption[];
  /** Selected tenant id; "" means the all/none option. */
  value: string;
  onChange: (id: string) => void;
  /** When set, prepends an option mapped to "" (e.g. "All tenants"). */
  allLabel?: string;
  /** Trigger text when nothing is selected and there is no allLabel. */
  placeholder?: string;
  error?: boolean;
  /** Wrapper classes (width etc.). */
  className?: string;
  testId?: string;
}

interface MenuPos {
  left: number;
  width: number;
  /** Pixels from viewport top when opening downward. */
  top?: number;
  /** Pixels from viewport bottom when opening upward. */
  bottom?: number;
  maxHeight: number;
}

const PANEL_MAX = 240; // matches max-h-60 (15rem)

export function TenantSelect({
  tenants,
  value,
  onChange,
  allLabel,
  placeholder = "Select tenant…",
  error,
  className = "",
  testId,
}: TenantSelectProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // Flip up only when there's clearly more room above than below.
    const openUp = spaceBelow < PANEL_MAX && spaceAbove > spaceBelow;
    setPos({
      left: r.left,
      width: r.width,
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
      maxHeight: Math.min(PANEL_MAX, (openUp ? spaceAbove : spaceBelow) - 8),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    reposition();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (
        !triggerRef.current?.contains(t) &&
        !panelRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // capture=true so scrolling inside a modal (not just window) repositions.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, reposition]);

  // Defensive: callers populate `tenants` from an async fetch, so on an error
  // (or before the first load) it can briefly be undefined / non-array. Guard
  // so the whole page doesn't crash with "tenants.find is not a function" —
  // the picker just renders empty until data arrives.
  const list = Array.isArray(tenants) ? tenants : [];
  const selected = list.find((t) => t.id === value);
  const selectedIsDefault = selected?.subdomain === "default";
  const triggerLabel = selected?.name ?? allLabel ?? placeholder;

  const options: TenantOption[] = [
    ...(allLabel ? [{ id: "", name: allLabel, subdomain: "" }] : []),
    ...list,
  ];

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-white py-2.5 px-3 text-sm dark:bg-gray-800 ${
          error
            ? "border-red-400 dark:border-red-500"
            : "border-gray-200 dark:border-gray-700"
        } ${
          selectedIsDefault
            ? "font-medium text-amber-700 dark:text-amber-400"
            : "text-gray-900 dark:text-gray-100"
        }`}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={panelRef}
            role="listbox"
            style={{
              position: "fixed",
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
            }}
            className="z-[1000] overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
          >
            {options.map((tn) => {
              const isDefault = tn.subdomain === "default";
              const isSelected = value === tn.id;
              return (
                <li key={tn.id || "__all__"}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(tn.id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 ${
                      isSelected ? "font-medium" : ""
                    } ${
                      isDefault
                        ? "text-amber-700 dark:text-amber-400"
                        : isSelected
                          ? "text-primary"
                          : "text-gray-700 dark:text-gray-200"
                    }`}
                  >
                    <span className="truncate">{tn.name}</span>
                    {isDefault && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                        Default
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
