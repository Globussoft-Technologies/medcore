"use client";

// Shared list-pagination footer. Matches the Patients-page (DataTable) style:
// a "Rows:" per-page selector on the left and "Page X of Y" with prev/next
// chevrons on the right. Used by every list/table page so pagination looks and
// behaves identically across the dashboard. Controlled component — the page
// owns `page` + `pageSize` state and slices its own data.

import { ChevronLeft, ChevronRight } from "lucide-react";

interface TablePaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages (>= 1). */
  totalPages: number;
  /** Current rows-per-page value. */
  pageSize: number;
  /** Total item count, for the "1–25 of N" range hint (optional). */
  totalItems?: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
}

export function TablePagination({
  page,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}: TablePaginationProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
      <div className="flex items-center gap-2">
        <span>Rows:</span>
        <select
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="min-h-[36px] rounded border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {typeof totalItems === "number" && (
          <span className="hidden text-gray-500 sm:inline dark:text-gray-400">
            {totalItems === 0 ? 0 : (page - 1) * pageSize + 1}–
            {Math.min(page * pageSize, totalItems)} of {totalItems}
          </span>
        )}
        <span>
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label="Previous page"
          className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded border border-gray-300 p-1 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:hover:bg-gray-700"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label="Next page"
          className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded border border-gray-300 p-1 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:hover:bg-gray-700"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export default TablePagination;
