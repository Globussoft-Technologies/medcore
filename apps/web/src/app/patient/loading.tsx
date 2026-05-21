// Minimal skeleton for the patient PWA shell (gap #5 piece 1 of 4).
export default function PatientLoading() {
  return (
    <div
      data-testid="patient-loading-skeleton"
      className="space-y-4 py-6"
      aria-busy="true"
    >
      <div className="h-7 w-2/3 animate-pulse rounded bg-slate-200" />
      <div className="h-4 w-full animate-pulse rounded bg-slate-200" />
      <div className="h-4 w-5/6 animate-pulse rounded bg-slate-200" />
      <div className="h-11 w-40 animate-pulse rounded bg-slate-200" />
    </div>
  );
}
