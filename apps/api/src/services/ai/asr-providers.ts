// ASR provider abstraction — Sarvam-only.
//
// Historical note: this module used to support AssemblyAI and Deepgram clients
// for acoustic diarization. Both providers process audio in US-region
// data-centres which violates PRD §3.8 / §4.8 ("India-region deployment for
// all PII and PHI"). They were removed on 2026-04-25; if MedCore ever expands
// outside India, re-introduce them under a `DEPLOYMENT_REGION` gate so an
// India deployment cannot accidentally route audio to a non-India provider.
//
// Sarvam is fast, India-region, and DPDP-compliant but does NOT return
// per-speaker labels — the scribe UI uses a client-side "who is currently
// talking" toggle (issue #S4) to compensate. The provider abstraction is kept
// intact (single-element factory + fallback) so re-introducing additional
// India-region providers later is a small change.

import { logAICall } from "./sarvam-logging";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ASRProvider = "sarvam";

/** Canonical clinical speaker roles used throughout the scribe. */
export type SpeakerRole = "DOCTOR" | "PATIENT" | "ATTENDANT";

export interface ASRSegment {
  text: string;
  startMs: number;
  endMs: number;
  /**
   * When the backend provides acoustic diarization, this is mapped to one of
   * DOCTOR / PATIENT / ATTENDANT (see {@link mapSpeakerLabels}). Sarvam does
   * not support diarization so this is left undefined for now; the field is
   * kept so the scribe UI can render diarized output if a future India-region
   * provider supplies it.
   */
  speaker?: SpeakerRole | string;
  confidence?: number;
}

export interface ASRResult {
  transcript: string;
  segments: ASRSegment[];
  language?: string;
  provider: ASRProvider;
}

export interface ASRTranscribeOptions {
  /** BCP-47 / ISO tag, e.g. `"en-IN"`, `"hi-IN"`. Forwarded to the provider. */
  language?: string;
  /**
   * When true, request acoustic speaker labels from the provider. Currently
   * a no-op (Sarvam doesn't support it); kept on the options object so the
   * route layer doesn't need to special-case it.
   */
  diarize?: boolean;
  /**
   * Hint used by {@link mapSpeakerLabels} when a future provider returns
   * diarized output: when true, the first speaker becomes DOCTOR. No-op for
   * Sarvam.
   */
  doctorFirst?: boolean;
  /**
   * PRD §4.5.2 — Medical-vocabulary tuning. No-op for Sarvam (its public
   * `/speech-to-text` endpoint exposes no `word_boost` / custom-LM hook as
   * of 2026-04). Kept on the options object so callers can use a uniform
   * shape; re-wire when Sarvam ships a vocabulary hook.
   */
  medicalVocabulary?: boolean;
}

export interface ASRClient {
  readonly provider: ASRProvider;
  transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult>;
}

// ── Speaker mapping helper ────────────────────────────────────────────────────

/**
 * Map generic `A|B|C|…` speaker labels onto MedCore's canonical
 * DOCTOR / PATIENT / ATTENDANT roles by order of first appearance. No
 * provider currently emits diarized labels, but the helper is kept so that
 * re-introducing diarization later is a single-class change.
 *
 *   - 1st distinct speaker → DOCTOR
 *   - 2nd distinct speaker → PATIENT
 *   - 3rd distinct speaker → ATTENDANT
 *   - 4th+ distinct speaker → left as raw provider label
 */
export function mapSpeakerLabels<T extends { speaker?: string }>(
  segments: T[],
  _opts: { doctorFirst?: boolean } = {},
): T[] {
  const roleOrder: SpeakerRole[] = ["DOCTOR", "PATIENT", "ATTENDANT"];
  const labelToRole = new Map<string, SpeakerRole | string>();
  let roleIdx = 0;
  return segments.map((seg) => {
    if (!seg.speaker) return seg;
    if (!labelToRole.has(seg.speaker)) {
      const mapped = roleIdx < roleOrder.length ? roleOrder[roleIdx] : seg.speaker;
      labelToRole.set(seg.speaker, mapped);
      roleIdx += 1;
    }
    return { ...seg, speaker: labelToRole.get(seg.speaker) };
  });
}

// ── Sarvam ────────────────────────────────────────────────────────────────────

const SARVAM_ENDPOINT = "https://api.sarvam.ai/speech-to-text";

class SarvamASRClient implements ASRClient {
  readonly provider: ASRProvider = "sarvam";

  async transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult> {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) {
      throw new Error("SARVAM_API_KEY is not configured");
    }

    const t0 = Date.now();
    const language = opts.language ?? "en-IN";
    const audioBlob = new Blob([new Uint8Array(audio)], { type: "audio/webm" });

    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "saaras:v3");
    formData.append("language_code", language);

    let res: Response;
    try {
      res = await fetch(SARVAM_ENDPOINT, {
        method: "POST",
        headers: { "api-subscription-key": apiKey },
        body: formData,
      });
    } catch (err) {
      logAICall({
        feature: "asr-sarvam",
        model: "saaras:v3",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!res.ok) {
      let errMsg = `Sarvam ASR error: ${res.status}`;
      try {
        const errBody = (await res.json()) as { message?: string; error?: string };
        errMsg = errBody.message || errBody.error || errMsg;
      } catch {
        /* body not JSON */
      }
      logAICall({
        feature: "asr-sarvam",
        model: "saaras:v3",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - t0,
        error: errMsg,
      });
      throw new Error(errMsg);
    }

    const body = (await res.json()) as { transcript?: string; language_code?: string };
    const transcript = body.transcript ?? "";

    logAICall({
      feature: "asr-sarvam",
      model: "saaras:v3",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
    });

    return {
      transcript,
      segments: transcript
        ? [{ text: transcript, startMs: 0, endMs: 0, speaker: undefined }]
        : [],
      language: body.language_code ?? language,
      provider: "sarvam",
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Resolve an ASR client. Reads `ASR_PROVIDER` env var when `provider` is
 * omitted; falls through to `"sarvam"` when unset. Any value other than
 * `"sarvam"` is rejected with a clear error so a stale env var from before
 * the AssemblyAI/Deepgram removal fails fast rather than silently picking a
 * non-India provider that no longer exists.
 */
export function getASRClient(provider?: ASRProvider): ASRClient {
  const resolved =
    provider ??
    (process.env.ASR_PROVIDER as string | undefined) ??
    "sarvam";

  if (resolved !== "sarvam") {
    throw new Error(
      `Unknown ASR_PROVIDER "${resolved}". Only "sarvam" is supported (AssemblyAI and Deepgram were removed on 2026-04-25 due to non-India data residency).`,
    );
  }
  return new SarvamASRClient();
}

// ── Fallback ──────────────────────────────────────────────────────────────────

export interface ASRFallbackOptions {
  /** Ordered list of providers to try. First success wins. */
  providers: ASRProvider[];
  /** Feature label forwarded to `logAICall` when a provider fails. */
  feature: "asr-sarvam";
}

/**
 * Try each ASR provider in order; return on first success. With Sarvam as the
 * only provider this collapses to a single attempt with the existing logging
 * shape preserved, so callers (e.g. the scribe transcript route) don't need
 * to change. Re-introduce additional India-region providers by extending
 * {@link ASRProvider} and the factory.
 */
export async function callWithASRFallback(
  audio: Buffer,
  opts: ASRTranscribeOptions,
  fallback: ASRFallbackOptions,
): Promise<ASRResult> {
  const { providers, feature } = fallback;
  if (providers.length === 0) {
    throw new Error("callWithASRFallback: providers array must not be empty");
  }

  let lastError: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const isLast = i === providers.length - 1;
    try {
      const client = getASRClient(provider);
      const result = await client.transcribe(audio, opts);
      if (!result || typeof result.transcript !== "string" || !Array.isArray(result.segments)) {
        throw new Error(
          `ASR provider ${provider} returned a malformed response (missing transcript or segments).`,
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      logAICall({
        feature,
        model: provider,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        failover: true,
        error: err instanceof Error ? err.message : String(err),
      });
      if (isLast) {
        throw err;
      }
    }
  }
  throw lastError ?? new Error("callWithASRFallback: exhausted providers");
}
