"use client";

// Reusable patient avatar — renders the profile photo when available,
// otherwise a deterministic colored initials badge. Used across the
// patient detail header, the patient list, cards, and the queue so every
// surface shows the same face/fallback.
//
// The photo comes from the read endpoints' `photoSignedUrl` (a short-lived
// signed URL resolved from Patient.photoUrl's bare storage key — see
// apps/api/src/lib/patient-photo.ts). On image error (expired/missing) the
// component degrades to initials rather than a broken-image icon.

import { useState } from "react";

interface PatientAvatarProps {
  /** Signed URL for display (photoSignedUrl from the API). */
  photoUrl?: string | null;
  /** Patient's full name — used for initials + alt text. */
  name?: string | null;
  /** Pixel size of the square avatar. Default 40. */
  size?: number;
  className?: string;
}

// Derive up to two initials from a name ("John Doe" → "JD", "Amit" → "A").
function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().replace(/^Dr\.?\s+/i, "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable color per name so the same patient always gets the same badge hue.
const BADGE_COLORS = [
  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200",
];

function colorFor(name: string | null | undefined): string {
  const key = name ?? "";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length];
}

export function PatientAvatar({
  photoUrl,
  name,
  size = 40,
  className = "",
}: PatientAvatarProps) {
  // Track image-load failure so an expired/missing signed URL falls back
  // to initials instead of showing a broken image.
  const [errored, setErrored] = useState(false);
  const showPhoto = !!photoUrl && !errored;

  const dimension = { width: size, height: size };

  if (showPhoto) {
    return (
      <img
        src={photoUrl as string}
        alt={name ? `${name}'s photo` : "Patient photo"}
        data-testid="patient-avatar-photo"
        onError={() => setErrored(true)}
        style={dimension}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div
      data-testid="patient-avatar-initials"
      aria-label={name ? `${name} (no photo)` : "No photo"}
      style={{ ...dimension, fontSize: Math.max(11, Math.round(size * 0.38)) }}
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${colorFor(name)} ${className}`}
    >
      {initialsOf(name)}
    </div>
  );
}
