import { runAudioRetentionCleanup } from "./audio-retention";

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/**
 * Registers a daily interval to run the audio retention cleanup.
 * Call startRetentionScheduler() once at app startup.
 */
export function startRetentionScheduler(): void {
  setInterval(async () => {
    try {
      const result = await runAudioRetentionCleanup();
      console.log(
        `[Retention] Purged ${result.purged} audio files, ${result.errors} errors`
      );
    } catch (err) {
      console.error("[Retention] Audio retention cleanup failed:", err);
    }
  }, TWENTY_FOUR_HOURS);
}
