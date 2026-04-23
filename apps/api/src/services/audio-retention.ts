import { prisma } from "@medcore/db";
import { deleteFile } from "./storage";

/**
 * Purge expired audio files for scribe sessions.
 *
 * Call this daily (e.g., from a cron or startup interval).
 *
 * Logic:
 *  1. Find all COMPLETED or CONSENT_WITHDRAWN AIScribeSessions where
 *     audioRetainUntil is not null AND audioRetainUntil < now().
 *  2. For each session, attempt to delete the audio file at key
 *     `audio/scribe/<sessionId>.webm` (may not exist — handled gracefully).
 *  3. Update the session to set audioRetainUntil = null (marks as purged).
 *  4. Return { purged, errors } counts.
 */
export async function runAudioRetentionCleanup(): Promise<{
  purged: number;
  errors: number;
}> {
  const now = new Date();

  const sessions = await prisma.aIScribeSession.findMany({
    where: {
      status: { in: ["COMPLETED", "CONSENT_WITHDRAWN"] },
      audioRetainUntil: {
        not: null,
        lt: now,
      },
    },
    select: { id: true },
  });

  let purged = 0;
  let errors = 0;

  for (const session of sessions) {
    const audioKey = `audio/scribe/${session.id}.webm`;

    try {
      await deleteFile(audioKey);
    } catch {
      // File may not exist — treat as non-fatal and continue with DB cleanup
    }

    try {
      await prisma.aIScribeSession.update({
        where: { id: session.id },
        data: { audioRetainUntil: null },
      });
      purged++;
    } catch (err) {
      console.error(
        `[AudioRetention] Failed to clear audioRetainUntil for session ${session.id}:`,
        err
      );
      errors++;
    }
  }

  return { purged, errors };
}
