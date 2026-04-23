import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);
// Audio transcription is a clinician-only feature — patients must not be able
// to spend the Sarvam ASR quota by POSTing audio to this endpoint.
router.use(authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE));

// POST /api/v1/ai/transcribe
// Body: { audioBase64: string, language?: string }
// Accepts a base64-encoded audio blob and forwards it to the Sarvam ASR API.
router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { audioBase64, language = "en-IN" } = req.body as {
        audioBase64?: string;
        language?: string;
      };

      if (!audioBase64 || typeof audioBase64 !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          error: "audioBase64 field is required",
        });
        return;
      }

      const apiKey = process.env.SARVAM_API_KEY;
      if (!apiKey) {
        res.status(500).json({
          success: false,
          data: null,
          error: "SARVAM_API_KEY is not configured",
        });
        return;
      }

      // Decode base64 → Buffer → Blob for FormData
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const audioBlob = new Blob([audioBuffer], { type: "audio/webm" });

      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");
      formData.append("model", "saaras:v3");
      formData.append("language_code", language);

      const sarvamRes = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: {
          "api-subscription-key": apiKey,
        },
        body: formData,
      });

      if (!sarvamRes.ok) {
        let errMsg = `Sarvam ASR error: ${sarvamRes.status}`;
        try {
          const errBody = (await sarvamRes.json()) as { message?: string; error?: string };
          errMsg = errBody.message || errBody.error || errMsg;
        } catch {
          // body not JSON, keep default
        }
        res.status(502).json({ success: false, data: null, error: errMsg });
        return;
      }

      const result = (await sarvamRes.json()) as {
        transcript?: string;
        language_code?: string;
      };

      res.json({
        success: true,
        data: {
          transcript: result.transcript ?? "",
          languageCode: result.language_code ?? language,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiTranscribeRouter };
