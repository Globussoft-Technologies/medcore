import "../globals.css";

export const metadata = {
  title: "MedCore - Token Display",
  description: "Waiting area token display board",
};

export default function DisplayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-white antialiased">
        {children}
      </body>
    </html>
  );
}
