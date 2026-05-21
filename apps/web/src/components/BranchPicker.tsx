"use client";

/**
 * Pearl ERP Stage 1 gap item #2 — piece 3 of 3.
 *
 * Topbar branch picker. Renders a `<select>` mirroring the existing
 * LanguageDropdown convention (native control = accessible by default,
 * zero JS popover infra to debug). Reads/writes through the dedicated
 * `useBranchStore`; the api-client interceptor picks up the change on
 * the next outbound request.
 *
 * Only rendered when `availableBranches.length > 1` — a tenant with a
 * single branch has nothing to choose and the topbar stays uncluttered.
 */

import { Building } from "lucide-react";
import { useBranchStore } from "@/lib/branch-store";

export function BranchPicker({
  className,
  instanceId = "mc-branch",
}: {
  className?: string;
  instanceId?: string;
}) {
  const currentBranchId = useBranchStore((s) => s.currentBranchId);
  const availableBranches = useBranchStore((s) => s.availableBranches);
  const setCurrentBranchId = useBranchStore((s) => s.setCurrentBranchId);

  // Single-branch tenants get nothing — no UI noise.
  if (availableBranches.length <= 1) return null;

  function handleChange(next: string) {
    setCurrentBranchId(next || null);
  }

  return (
    <div
      className={`inline-flex items-center gap-1 ${className ?? ""}`}
      data-testid="branch-picker"
    >
      <Building
        size={14}
        className="text-gray-500 dark:text-gray-300"
        aria-hidden="true"
      />
      <label htmlFor={instanceId} className="sr-only">
        Select branch
      </label>
      <select
        id={instanceId}
        data-testid="branch-picker-select"
        value={currentBranchId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        aria-label="Select branch"
        className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:focus-visible:ring-offset-gray-900"
      >
        {availableBranches.map((b) => (
          <option
            key={b.id}
            value={b.id}
            data-testid={`branch-option-${b.id}`}
          >
            {b.code ? `${b.code} — ${b.name}` : b.name}
          </option>
        ))}
      </select>
    </div>
  );
}
