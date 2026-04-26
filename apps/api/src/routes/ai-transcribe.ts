import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import {
  getASRClient,
  callWithASRFallback,
  type ASRProvider,
} from "../services/ai/asr-providers";

const router = Router();
router.use(authenticate);
// Audio transcription is a clinician-only feature — patients must not be able
// to spend the Sarvam ASR quota by POSTing audio to this endpoint.
router.use(authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE));
// security(2026-04-23): tighter per-IP limit for this LLM/ASR path so a
// compromised clinician token cannot burn the Sarvam quota (global limit is
// 600/min — way too loose for a paid speech API).
if (process.env.NODE_ENV !== "test") {
  router.use(rateLimit(30, 60_000));
}

// security(2026-04-23): hard cap on decoded audio size. Without this an
// attacker could POST a multi-MB base64 blob (the global express.json limit
// is 100 KB by default, but Buffer.from still happily decodes whatever gets
// through a larger body-parser in the future). 8 MB ≈ 5 min @ 96 kbps webm.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const SUPPORTED_PROVIDERS: ASRProvider[] = ["sarvam"];

// POST /api/v1/ai/transcribe
// Body: { audioBase64: string, language?: string, provider?: "sarvam", diarize?: boolean }
//
// Back-compat: legacy callers that just read `data.transcript` keep working
// because we still populate that field at the top level. New callers can also
// read `data.segments`, `data.provider`, etc. from the full ASRResult envelope.
// AssemblyAI / Deepgram support was removed on 2026-04-25 due to non-India
// data residency (PRD §3.8 / §4.8).
router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        audioBase64,
        language = "en-IN",
        provider: requestedProvider,
        diarize,
      } = req.body as {
        audioBase64?: string;
        language?: string;
        provider?: string;
        diarize?: boolean;
      };

      if (!audioBase64 || typeof audioBase64 !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          error: "audioBase64 field is required",
        });
        return;
      }

      // Validate provider override up-front so a bad client gets a clear 400
      // rather than a 500 from getASRClient.
      if (
        requestedProvider !== undefined &&
        !SUPPORTED_PROVIDERS.includes(requestedProvider as ASRProvider)
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
        });
        return;
      }

      const audioBuffer = Buffer.from(audioBase64, "base64");
      // security(2026-04-23): reject oversized blobs before forwarding so one
      // client can't pin the worker on a single huge upload.
      if (audioBuffer.length === 0 || audioBuffer.length > MAX_AUDIO_BYTES) {
        res.status(413).json({
          success: false,
          data: null,
          error: `audio must be between 1 byte and ${MAX_AUDIO_BYTES} bytes`,
        });
        return;
      }

      // Sarvam is the only supported provider since the AssemblyAI/Deepgram
      // removal on 2026-04-25; the body `provider` override + env are kept so
      // future India-region providers can be plugged in without changing
      // callers, but right now they all collapse to "sarvam".
      const providers: ASRProvider[] = ["sarvam"];

      try {
        const result = await callWithASRFallback(
          audioBuffer,
          { language, diarize, doctorFirst: true },
          {
            providers,
            feature: "asr-sarvam",
          }
        );

        res.json({
          success: true,
          data: {
            // Back-compat: the old shape returned `transcript` + `languageCode`.
            transcript: result.transcript,
            languageCode: result.language ?? language,
            // New fields for diarization-aware callers.
            segments: result.segments,
            provider: result.provider,
            language: result.language ?? language,
          },
          error: null,
        });
      } catch (err) {
        // Surface provider errors as 502 to keep parity with the old Sarvam
        // error path (was also 502 when Sarvam returned non-2xx).
        const message = err instanceof Error ? err.message : String(err);
        // Missing API key is misconfiguration (500), everything else is a
        // transient upstream failure (502).
        const status =
          /is not configured|not yet implemented/i.test(message) ? 500 : 502;
        res.status(status).json({ success: false, data: null, error: message });
      }
    } catch (err) {
      next(err);
    }
  }
);

// Expose the supported-provider list for the frontend so the scribe start
// screen can grey out providers that aren't configured server-side. Read-only,
// doctor/admin auth already applied above.
router.get("/providers", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      providers: SUPPORTED_PROVIDERS,
      default: "sarvam" as ASRProvider,
    },
    error: null,
  });
});

// Re-export getASRClient so legacy imports that reach into this route module
// for ad-hoc transcription don't need to care about the file reshuffle.
export { getASRClient };

export { router as aiTranscribeRouter };
