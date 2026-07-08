"use client";

// Dependency-free, CSP-safe chart primitives for the department reports.
// The codebase deliberately hand-rolls charts as inline SVG / divs (see
// dashboard/analytics/page.tsx) rather than pulling a charting library, so
// these mirror that approach: a horizontal ranked bar list and a simple
// vertical time-series column chart. Both are theme-aware and responsive.

export interface RankedItem {
  label: string;
  value: number;
}

// Horizontal ranked bars (top medicines / lab tests / diagnoses / doctors).
export function RankedBars({
  items,
  color = "#6366f1",
  formatValue = (n: number) => n.toLocaleString("en-IN"),
  emptyLabel = "No data in this range",
}: {
  items: RankedItem[];
  color?: string;
  formatValue?: (n: number) => string;
  emptyLabel?: string;
}) {
  const rows = items ?? [];
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">
        {emptyLabel}
      </p>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const pct = (r.value / max) * 100;
        return (
          <div key={r.label}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span
                className="mr-2 truncate font-medium text-gray-700 dark:text-gray-200"
                title={r.label}
              >
                {r.label}
              </span>
              <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
                {formatValue(r.value)}
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, backgroundColor: color }}
                title={`${r.label}: ${formatValue(r.value)}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface TimePoint {
  day: string; // YYYY-MM-DD
  value: number;
  overlay?: number; // optional secondary value (e.g. completed within total)
}

// Vertical column time-series. `overlay` (if present) is drawn as a darker
// inner bar — used to show "completed" inside "appointments".
export function TimeSeriesBars({
  points,
  color = "#6366f1",
  overlayColor = "#4338ca",
  height = 180,
  formatValue = (n: number) => n.toLocaleString("en-IN"),
}: {
  points: TimePoint[];
  color?: string;
  overlayColor?: string;
  height?: number;
  formatValue?: (n: number) => string;
}) {
  const pts = points ?? [];
  if (pts.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">
        No data in this range
      </p>
    );
  }
  const max = Math.max(1, ...pts.map((p) => p.value));
  // Show a readable subset of x-axis labels (first, last, and evenly spaced).
  const labelEvery = Math.max(1, Math.ceil(pts.length / 8));

  return (
    <div>
      <div
        className="flex items-end gap-[2px]"
        style={{ height }}
        role="img"
        aria-label="Time series bar chart"
      >
        {pts.map((p, i) => {
          const h = (p.value / max) * 100;
          const oh = p.overlay != null ? (p.overlay / max) * 100 : 0;
          return (
            <div
              key={p.day + i}
              className="group relative flex flex-1 items-end"
              style={{ height: "100%" }}
              title={`${p.day}: ${formatValue(p.value)}${
                p.overlay != null ? ` (${formatValue(p.overlay)} completed)` : ""
              }`}
            >
              {/* total bar */}
              <div
                className="w-full rounded-t transition-all"
                style={{ height: `${h}%`, backgroundColor: color, minHeight: p.value > 0 ? 2 : 0 }}
              >
                {/* completed overlay pinned to the bottom of the total bar */}
                {p.overlay != null && p.overlay > 0 ? (
                  <div
                    className="absolute bottom-0 w-full rounded-t"
                    style={{ height: `${oh}%`, backgroundColor: overlayColor }}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* x-axis labels */}
      <div className="mt-1 flex gap-[2px]">
        {pts.map((p, i) => (
          <div
            key={p.day + "-lbl-" + i}
            className="flex-1 overflow-hidden text-center text-[9px] leading-tight text-gray-400 dark:text-gray-500"
          >
            {i % labelEvery === 0 ? p.day.slice(5) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
