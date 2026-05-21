// Minimal skeleton for the super-admin shell (gap #6 piece 1 of 4).
export default function SuperAdminLoading() {
  return (
    <div
      data-testid="super-admin-loading-skeleton"
      className="space-y-4 py-6"
      aria-busy="true"
    >
      <div className="h-7 w-2/3 animate-pulse rounded bg-slate-200" />
      <div className="h-4 w-full animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="h-32 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-32 animate-pulse rounded-xl bg-slate-200" />
      </div>
    </div>
  );
}
