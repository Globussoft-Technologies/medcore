"use client";

// Per-user reorderable sidebar (DB-persisted).
//
// Dashboard + Admin Console (and any href passed in `pinnedHrefs`) are
// PINNED — always rendered first, never draggable. Every other nav item can
// be dragged into the user's preferred order. The chosen order is saved to
// `GET|PUT /users/me/sidebar-preferences` (stored in the existing
// user_dashboard_preferences row, so no migration) and therefore survives a
// refresh and follows the user across devices. A "Reset to default" control
// clears the customisation and reverts to the default order.
//
// Robustness: the stored order is just a list of hrefs. Items that no longer
// exist (feature-gated off / route removed) are ignored, and newly-added nav
// items not present in the saved order are appended in their default position
// — so the saved list never has to be exhaustive or kept in lock-step with
// the code.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  GripVertical,
  Pin,
  RotateCcw,
  Check,
  SlidersHorizontal,
  ArrowUpDown,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";

export interface SidebarNavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

interface SidebarNavProps {
  /** Role-filtered nav items, in their DEFAULT order. */
  items: SidebarNavItem[];
  /** Hrefs that are pinned (rendered first, not reorderable). */
  pinnedHrefs: string[];
  /** Current route — drives the active highlight. */
  pathname: string;
  /** i18n label translator (falls back to the raw label). */
  tNav: (label: string) => string;
  /** Optional per-href tooltip text. */
  tips?: Record<string, string>;
}

/**
 * Merge a saved href order with the set of currently-available hrefs:
 * kept-in-saved-order first, then any new hrefs appended in default order,
 * with stale hrefs dropped.
 */
function reconcile(savedOrder: string[], currentHrefs: string[]): string[] {
  const present = new Set(currentHrefs);
  const kept = savedOrder.filter((h) => present.has(h));
  const keptSet = new Set(kept);
  const appended = currentHrefs.filter((h) => !keptSet.has(h));
  return [...kept, ...appended];
}

// A 1×1 transparent image used as the drag ghost so the browser doesn't show
// a floating snapshot of the dragged row — the live in-list reordering is the
// feedback we want, not a noisy bar following the cursor. Created lazily +
// memoised (client-only).
let EMPTY_DRAG_IMAGE: HTMLImageElement | null = null;
function getEmptyDragImage(): HTMLImageElement | null {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  if (!EMPTY_DRAG_IMAGE) {
    const img = new Image();
    img.src =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    EMPTY_DRAG_IMAGE = img;
  }
  return EMPTY_DRAG_IMAGE;
}

export function SidebarNav({
  items,
  pinnedHrefs,
  pathname,
  tNav,
  tips,
}: SidebarNavProps) {
  const router = useRouter();

  const pinnedSet = useMemo(() => new Set(pinnedHrefs), [pinnedHrefs]);
  const itemByHref = useMemo(() => {
    const m = new Map<string, SidebarNavItem>();
    for (const it of items) m.set(it.href, it);
    return m;
  }, [items]);

  const pinnedItems = useMemo(
    () => items.filter((it) => pinnedSet.has(it.href)),
    [items, pinnedSet]
  );
  const reorderableHrefs = useMemo(
    () => items.filter((it) => !pinnedSet.has(it.href)).map((it) => it.href),
    [items, pinnedSet]
  );

  // The reorderable hrefs in the user's chosen display order.
  const [order, setOrder] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [dragHref, setDragHref] = useState<string | null>(null);

  // Latest reorderable hrefs for the one-shot fetch effect (avoids re-running
  // the fetch when feature flags hydrate and change the item list).
  const reorderableRef = useRef(reorderableHrefs);
  reorderableRef.current = reorderableHrefs;

  // Root element — used to find the scrollable <nav> ancestor for drag
  // edge-auto-scroll.
  const rootRef = useRef<HTMLDivElement>(null);

  // Edge auto-scroll while dragging: when the pointer nears the top/bottom of
  // the scrollable menu, scroll it smoothly so items beyond the fold are
  // reachable. Speed ramps up the closer the pointer is to the edge.
  useEffect(() => {
    if (!dragHref) return;
    const container = rootRef.current?.parentElement;
    if (!container || typeof requestAnimationFrame !== "function") return;

    const EDGE = 64; // px from each edge that triggers scrolling
    const MAX_SPEED = 14; // px per frame at the very edge
    let speed = 0;
    let raf = 0;

    const onDragOver = (e: DragEvent) => {
      const rect = container.getBoundingClientRect();
      const y = e.clientY;
      if (y < rect.top + EDGE) {
        speed = -MAX_SPEED * Math.min(1, (rect.top + EDGE - y) / EDGE);
      } else if (y > rect.bottom - EDGE) {
        speed = MAX_SPEED * Math.min(1, (y - (rect.bottom - EDGE)) / EDGE);
      } else {
        speed = 0;
      }
    };

    const step = () => {
      if (speed !== 0) container.scrollTop += speed;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    container.addEventListener("dragover", onDragOver);

    return () => {
      container.removeEventListener("dragover", onDragOver);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [dragHref]);

  // Load the saved order once.
  useEffect(() => {
    let alive = true;
    api
      .get<{ data: { order: string[] } }>("/users/me/sidebar-preferences")
      .then((r) => {
        if (!alive) return;
        const saved = Array.isArray(r.data?.order) ? r.data.order : [];
        setOrder(reconcile(saved, reorderableRef.current));
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setOrder(reconcile([], reorderableRef.current));
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Keep the order reconciled when the available items change (role / flags).
  useEffect(() => {
    if (!loaded) return;
    setOrder((prev) => reconcile(prev, reorderableHrefs));
  }, [reorderableHrefs, loaded]);

  const persist = useCallback((next: string[]) => {
    api
      .put("/users/me/sidebar-preferences", { order: next })
      .catch(() => toast.error("Couldn't save sidebar order"));
  }, []);

  const move = useCallback((from: string, to: string) => {
    if (from === to) return;
    setOrder((prev) => {
      const fromIdx = prev.indexOf(from);
      const toIdx = prev.indexOf(to);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, from);
      return next;
    });
  }, []);

  const confirm = useConfirm();
  const resetToDefault = useCallback(async () => {
    const ok = await confirm({
      title: "Reset sidebar order?",
      message:
        "This restores the default menu order. Your custom arrangement will be removed.",
      confirmLabel: "Reset",
    });
    // Either choice leaves reorder mode (the "Reorder menu" button returns) —
    // no need to click "Done" afterwards. Cancel simply skips the reset.
    setReordering(false);
    if (!ok) return;
    const def = reconcile([], reorderableHrefs);
    setOrder(def);
    persist([]); // empty = "no customisation, use default"
  }, [confirm, reorderableHrefs, persist]);

  // Before the saved order has loaded (or if it's empty), fall back to the
  // default order so the menu always renders its items immediately — never a
  // near-empty sidebar while the preference request is in flight.
  const orderedReorderable = useMemo(() => {
    const effective = order.length > 0 ? order : reorderableHrefs;
    return effective
      .map((h) => itemByHref.get(h))
      .filter(Boolean) as SidebarNavItem[];
  }, [order, reorderableHrefs, itemByHref]);

  // Click behaviour for normal (non-reorder) navigation — mirrors the
  // defensive Link+router.push pairing used elsewhere in the layout so an
  // interrupted client transition still navigates.
  const handleNavClick = useCallback(
    (e: React.MouseEvent, href: string) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      if (pathname !== href) {
        queueMicrotask(() => router.push(href));
      }
    },
    [pathname, router]
  );

  function renderLink(item: SidebarNavItem) {
    const { href, label, icon: Icon } = item;
    const isActive = pathname === href;
    return (
      <Link
        key={href}
        href={href}
        onClick={(e) => handleNavClick(e, href)}
        aria-current={isActive ? "page" : undefined}
        title={tips?.[href]}
        className={
          "mb-1 flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-sidebar " +
          (isActive
            ? "bg-primary font-medium text-white"
            : "text-slate-700 hover:bg-sidebar-hover hover:text-slate-900 dark:text-gray-300 dark:hover:text-white")
        }
      >
        <Icon size={18} aria-hidden="true" />
        {tNav(label)}
      </Link>
    );
  }

  function renderDraggable(item: SidebarNavItem) {
    const { href, label, icon: Icon } = item;
    const isDragging = dragHref === href;
    return (
      <div
        key={href}
        draggable
        data-testid={`sidebar-reorder-item-${href}`}
        onDragStart={(e) => {
          setDragHref(href);
          e.dataTransfer.effectAllowed = "move";
          // Hide the native drag ghost (the floating row snapshot).
          if (typeof e.dataTransfer.setDragImage === "function") {
            const ghost = getEmptyDragImage();
            if (ghost) e.dataTransfer.setDragImage(ghost, 0, 0);
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dragHref && dragHref !== href) move(dragHref, href);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragHref(null);
          setOrder((cur) => {
            persist(cur);
            return cur;
          });
        }}
        onDragEnd={() => {
          if (dragHref) {
            setDragHref(null);
            setOrder((cur) => {
              persist(cur);
              return cur;
            });
          }
        }}
        className={
          "mb-1 flex min-h-[44px] cursor-grab items-center gap-2 rounded-lg px-2 py-2.5 text-sm select-none " +
          (isDragging
            ? "opacity-50 ring-2 ring-primary"
            : "text-slate-700 hover:bg-sidebar-hover dark:text-gray-300")
        }
      >
        <GripVertical
          size={16}
          aria-hidden="true"
          className="shrink-0 text-gray-400 dark:text-gray-500"
        />
        <Icon size={18} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{tNav(label)}</span>
      </div>
    );
  }

  function renderPinnedDuringReorder(item: SidebarNavItem) {
    const { href, label, icon: Icon } = item;
    return (
      <div
        key={href}
        data-testid={`sidebar-pinned-item-${href}`}
        className="mb-1 flex min-h-[44px] items-center gap-2 rounded-lg px-2 py-2.5 text-sm text-slate-500 dark:text-gray-400"
        title="Pinned — can't be moved"
      >
        <Pin size={14} aria-hidden="true" className="shrink-0 text-gray-400" />
        <Icon size={18} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{tNav(label)}</span>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      {reordering ? (
        <>
          {/* Clear affordance so the user understands they're in reorder
              mode and how to act (drag the handled rows). */}
          <div
            data-testid="sidebar-reorder-hint"
            className="mb-2 flex items-center gap-2 rounded-lg border border-dashed border-primary/50 bg-primary/5 px-3 py-2 text-xs font-medium text-primary dark:border-blue-400/40 dark:text-blue-300"
          >
            <ArrowUpDown size={14} aria-hidden="true" className="shrink-0" />
            Drag items to reorder
          </div>
          {pinnedItems.map(renderPinnedDuringReorder)}
          {orderedReorderable.map(renderDraggable)}
        </>
      ) : (
        <>
          {pinnedItems.map(renderLink)}
          {orderedReorderable.map(renderLink)}
        </>
      )}

      {/* Reorder controls — placed at the foot of the menu and styled like
          the "Take tour" button so they read as a deliberate menu action
          rather than floating chrome above the first item. */}
      {reordering ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void resetToDefault()}
            data-testid="sidebar-reset-default"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs text-slate-600 hover:bg-sidebar-hover hover:text-slate-900 dark:border-white/10 dark:text-gray-300 dark:hover:text-white"
          >
            <RotateCcw size={13} aria-hidden="true" /> Default
          </button>
          <button
            type="button"
            onClick={() => setReordering(false)}
            data-testid="sidebar-reorder-done"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/20 dark:text-blue-300"
          >
            <Check size={13} aria-hidden="true" /> Done
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setReordering(true)}
          data-testid="sidebar-reorder-toggle"
          title="Reorder menu"
          aria-label="Reorder menu"
          className="mt-2 flex w-full items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-xs text-slate-600 hover:bg-sidebar-hover hover:text-slate-900 dark:border-white/10 dark:text-gray-300 dark:hover:text-white"
        >
          <SlidersHorizontal size={14} aria-hidden="true" /> Reorder menu
        </button>
      )}
    </div>
  );
}
