/**
 * Issue #348 — bed counts were inconsistent across the Wards, Admissions and
 * Dashboard pages because each computed totals slightly differently:
 *
 *   • Wards page:        prefer w.availableBeds, else recompute from beds[]
 *   • Admissions page:   only use beds[] (ignored availableBeds entirely)
 *   • Dashboard:         total = beds.length || totalBeds, occupied only
 *                        from beds[] (no fallback)
 *
 * When `/wards` returns the modern shape `{ totalBeds, availableBeds, ..., beds }`
 * all three branches happen to agree. But on payloads where `beds` is omitted
 * (e.g. cached responses, e2e fixtures, tenant-scoped reads where the include
 * is dropped) the three formulas produced different numbers.
 *
 * `summarizeBeds` collapses every fallback into one formula, and
 * `getBedSummary` produces the same `{ total, available, occupied, cleaning,
 * maintenance }` shape from the `/wards` response so every page uses the
 * exact same numbers.
 */

interface BedLike {
  status?: string | null;
}

interface WardLike {
  beds?: BedLike[] | null;
  totalBeds?: number | null;
  availableBeds?: number | null;
  occupiedBeds?: number | null;
  cleaningBeds?: number | null;
  maintenanceBeds?: number | null;
}

export interface BedSummary {
  total: number;
  available: number;
  occupied: number;
  cleaning: number;
  maintenance: number;
}

const ZERO: BedSummary = {
  total: 0,
  available: 0,
  occupied: 0,
  cleaning: 0,
  maintenance: 0,
};

export function summarizeBeds(ward: WardLike | null | undefined): BedSummary {
  if (!ward) return { ...ZERO };
  const beds = Array.isArray(ward.beds) ? ward.beds : [];
  const fromBeds = beds.length > 0;
  const count = (s: string) =>
    beds.filter((b) => b?.status === s).length;
  return {
    total: fromBeds ? beds.length : Number(ward.totalBeds ?? 0),
    available: fromBeds ? count("AVAILABLE") : Number(ward.availableBeds ?? 0),
    occupied: fromBeds ? count("OCCUPIED") : Number(ward.occupiedBeds ?? 0),
    cleaning: fromBeds ? count("CLEANING") : Number(ward.cleaningBeds ?? 0),
    maintenance: fromBeds
      ? count("MAINTENANCE")
      : Number(ward.maintenanceBeds ?? 0),
  };
}

export function getBedSummary(
  wards: WardLike[] | null | undefined
): BedSummary {
  const list = Array.isArray(wards) ? wards : [];
  return list.reduce<BedSummary>((acc, w) => {
    const s = summarizeBeds(w);
    return {
      total: acc.total + s.total,
      available: acc.available + s.available,
      occupied: acc.occupied + s.occupied,
      cleaning: acc.cleaning + s.cleaning,
      maintenance: acc.maintenance + s.maintenance,
    };
  }, { ...ZERO });
}

/**
 * Issue #507 — the wards page progress bar laid out three flex children
 * with `width: %` styles, but flex children inherit `flex-shrink: 1` which
 * caused them to be shrunk away from their declared widths (so a ward with
 * 3 occ / 7 avail rendered roughly 50/50 instead of 30/70). Worse, the
 * MAINTENANCE category was missing entirely, so when any bed was under
 * maintenance the segments no longer summed to 100%.
 *
 * `bedBarSegments` returns the per-status width strings the bar should
 * render. It guarantees:
 *   • each width is a number in [0, 100]
 *   • widths sum to 100% when total > 0 (last segment absorbs rounding)
 *   • when total === 0 every width is "0%" (no division by zero)
 *   • when occupied >= total the bar is fully red (capped — a stale
 *     summary that reports occupied > total must not overflow the bar)
 */
export interface BedBarSegments {
  occupied: string;
  cleaning: string;
  maintenance: string;
  available: string;
}

export function bedBarSegments(summary: BedSummary): BedBarSegments {
  const total = Math.max(0, summary.total);
  if (total === 0) {
    return { occupied: "0%", cleaning: "0%", maintenance: "0%", available: "0%" };
  }
  // Allocate occupied → cleaning → maintenance in priority order, never
  // exceeding total. Whatever's left becomes available so the four
  // segments always sum to exactly 100%.
  const clamp = (n: number) => Math.max(0, n);
  let remaining = total;
  const take = (raw: number) => {
    const n = Math.min(remaining, clamp(raw));
    remaining -= n;
    return n;
  };
  const occ = take(summary.occupied);
  const cln = take(summary.cleaning);
  const mnt = take(summary.maintenance);
  const avl = remaining;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return {
    occupied: pct(occ),
    cleaning: pct(cln),
    maintenance: pct(mnt),
    available: pct(avl),
  };
}
