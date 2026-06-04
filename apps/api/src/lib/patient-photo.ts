// Resolve a short-lived signed URL for a patient's profile photo.
//
// Patient.photoUrl stores the BARE storage key returned by POST /uploads
// (e.g. "ehr/uuid-name.jpg"), mirroring PatientDocument.filePath and
// RadiologyStudy.images[].key. To display the avatar the read endpoints
// attach `photoSignedUrl` — a time-limited signed download URL — exactly
// like ai-radiology.ts attaches signedUrl to each image.
//
// Defensive: returns null on empty/missing keys and swallows signing
// errors (a broken avatar must never tank a patient chart load).

import { getSignedDownloadUrl } from "../services/storage";

// Short TTL — avatars are re-fetched on each chart/list load. Matches the
// radiology image TTL (300s) rather than the 900s document default.
const PHOTO_URL_TTL_SECONDS = 300;

/**
 * Given a stored photo key, return a signed URL for display (or null).
 *
 * Back-compat: if the stored value is already a full http(s) URL (legacy
 * rows or an external avatar), it's returned as-is — no signing needed.
 */
export async function resolvePatientPhotoUrl(
  photoUrl: string | null | undefined,
): Promise<string | null> {
  if (!photoUrl) return null;
  // Inline data URLs (self-registration photos) + full http(s) URLs are
  // already displayable as-is — no signing needed.
  if (/^data:image\//i.test(photoUrl)) return photoUrl;
  if (/^https?:\/\//i.test(photoUrl)) return photoUrl;
  try {
    return await getSignedDownloadUrl(photoUrl, PHOTO_URL_TTL_SECONDS);
  } catch {
    return null;
  }
}

/**
 * Resolve the first available photo from several candidate columns.
 *
 * A patient's photo can live on EITHER `Patient.photoUrl` (set at
 * self-registration / by the patient-edit modal) OR the linked
 * `User.photoUrl` (set on the Settings → Profile page). To make the photo
 * show consistently on every surface (patient detail, list, ID card),
 * resolve whichever is set — Patient first, then User.
 */
export async function resolveFirstPhotoUrl(
  ...candidates: (string | null | undefined)[]
): Promise<string | null> {
  for (const c of candidates) {
    if (c) return resolvePatientPhotoUrl(c);
  }
  return null;
}
