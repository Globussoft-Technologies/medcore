// Lightweight typography wrappers for the /legal/* pages. Tailwind's
// @tailwindcss/typography is not installed in this workspace, so we
// hand-roll a small set of consistent heading / paragraph / list styles.

export function LegalH1({ children }: { children: React.ReactNode }) {
  return (
    <h1 className="mb-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
      {children}
    </h1>
  );
}

export function LegalH2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 mt-10 text-xl font-semibold text-gray-900 dark:text-gray-100">
      {children}
    </h2>
  );
}

export function LegalP({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
      {children}
    </p>
  );
}

export function LegalUL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mb-4 list-disc space-y-1.5 pl-6 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
      {children}
    </ul>
  );
}

export function LegalEffective({ date }: { date: string }) {
  return (
    <p className="mb-8 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-500">
      Effective {date}
    </p>
  );
}
