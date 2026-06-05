export const metadata = {
  title: "MedCore - Token Display",
  description: "Waiting area token display board",
};

// NOTE: do NOT render <html>/<body> here. The root app/layout.tsx already
// renders them; a nested layout rendering its own caused a hydration mismatch
// (two conflicting <body> class sets). The board's dark theme lives on the
// page's own root container (bg-slate-950 text-white) instead.
export default function DisplayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
