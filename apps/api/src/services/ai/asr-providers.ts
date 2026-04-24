// Acoustic-diarization ASR provider abstraction.
//
// The scribe historically called Sarvam's `/speech-to-text` endpoint directly
// from `apps/api/src/routes/ai-transcribe.ts`. Sarvam is fast, cheap, and
// DPDP-compliant but does NOT return per-speaker labels — the scribe UI used
// a client-side "who is currently talking" toggle (issue #S4) as a workaround.
//
// This module introduces a minimal provider abstraction so operators can flip
// `ASR_PROVIDER=assemblyai` (or `deepgram`, once implemented) in env and get
// real acoustic diarization at the cost of latency + per-minute billing + data
// leaving the India region. Default remains Sarvam; new providers are opt-in.
//
// Deliberate choices:
//   - No new npm dependencies. AssemblyAI's HTTP API is called via `fetch`.
//   - Providers return the same `ASRResult` envelope so the route layer doesn't
//     care which backend produced the transcript. Sarvam returns a single
//     segment with no `speaker`; AssemblyAI returns one segment per utterance
//     with an inferred role.
//   - `callWithASRFallback` mirrors model-router's `callWithFallback` so ASR
//     outages degrade to the next provider in the list rather than 500'ing the
//     scribe page.

import { logAICall } from "./sarvam-logging";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ASRProvider = "sarvam" | "assemblyai" | "deepgram";

/** Canonical clinical speaker roles used throughout the scribe. */
export type SpeakerRole = "DOCTOR" | "PATIENT" | "ATTENDANT";

export interface ASRSegment {
  text: string;
  startMs: number;
  endMs: number;
  /**
   * When the backend provides acoustic diarization, this is mapped to one of
   * DOCTOR / PATIENT / ATTENDANT (see {@link mapSpeakerLabels}). Falls through
   * to the raw provider label (`"A"`, `"B"`, …) when more than three speakers
   * are present, and is left undefined for non-diarizing providers.
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
   * When true, request acoustic speaker labels from the provider. Ignored by
   * Sarvam (not supported). AssemblyAI: sets `speaker_labels: true`.
   */
  diarize?: boolean;
  /**
   * Hint used by {@link mapSpeakerLabels} — when true, the first speaker to
   * appear in the transcript is mapped to DOCTOR. Otherwise labels fall back
   * to A=DOCTOR, B=PATIENT, C=ATTENDANT in first-appearance order (which is
   * equivalent to `doctorFirst: true` for AssemblyAI, but keeping the flag
   * explicit makes the intent auditable in logs).
   */
  doctorFirst?: boolean;
}

export interface ASRClient {
  readonly provider: ASRProvider;
  transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult>;
}

// ── Speaker mapping helper ────────────────────────────────────────────────────

/**
 * Map AssemblyAI / generic `A|B|C|…` speaker labels onto MedCore's canonical
 * DOCTOR / PATIENT / ATTENDANT roles by order of first appearance.
 *
 * The heuristic:
 *   - 1st distinct speaker → DOCTOR
 *   - 2nd distinct speaker → PATIENT
 *   - 3rd distinct speaker → ATTENDANT
 *   - 4th+ distinct speaker → left as raw provider label (`"D"`, etc.); the
 *     doctor can re-tag via the per-entry dropdown in the scribe UI.
 *
 * Exported for unit tests and for any future provider that produces similar
 * alphabetic labels.
 */
export function mapSpeakerLabels<T extends { speaker?: string }>(
  segments: T[],
  _opts: { doctorFirst?: boolean } = {}
): T[] {
  // The doctorFirst hint is semantically the same as the default mapping
  // (first-to-speak becomes DOCTOR). We still accept the flag so callers can
  // make the intent explicit and so we have a hook to extend behaviour later
  // (e.g. "patient-first" for teletriage calls) without a breaking change.
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
//
// Thin wrapper around the same endpoint the old route called directly. We
// preserve backward compatibility by emitting one big segment (`startMs=0`,
// `endMs=0`) with `speaker: undefined` — callers that only read `transcript`
// see zero behaviour change.

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

// ── AssemblyAI ────────────────────────────────────────────────────────────────
//
// AssemblyAI requires a two-step flow:
//   1. POST raw bytes to /v2/upload (returns `upload_url`).
//   2. POST { audio_url, speaker_labels, language_code } to /v2/transcript and
//      poll /v2/transcript/{id} until status === "completed" or "error".
//
// The response contains `utterances` with `speaker` ("A"|"B"|…), `start`/`end`
// in ms, and `text`. We map those labels onto DOCTOR/PATIENT/ATTENDANT via
// mapSpeakerLabels() above.

const ASSEMBLYAI_UPLOAD = "https://api.assemblyai.com/v2/upload";
const ASSEMBLYAI_TRANSCRIPT = "https://api.assemblyai.com/v2/transcript";

// Cap the polling loop so a stuck transcript job can't pin the worker. 90 s is
// generous for a 30 s audio chunk (AssemblyAI typically returns in 5-15 s).
const ASSEMBLYAI_MAX_POLL_MS = 90_000;
const ASSEMBLYAI_POLL_INTERVAL_MS = 1_500;

interface AssemblyAIUtterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
  confidence?: number;
}

interface AssemblyAITranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  language_code?: string;
  utterances?: AssemblyAIUtterance[];
  error?: string;
}

class AssemblyAIASRClient implements ASRClient {
  readonly provider: ASRProvider = "assemblyai";

  async transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult> {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ASSEMBLYAI_API_KEY is not configured — set it in the environment or switch ASR_PROVIDER back to sarvam."
      );
    }

    const t0 = Date.now();
    const diarize = opts.diarize !== false; // default on for this provider
    // AssemblyAI uses 2-letter codes (`en`, `hi`, etc.). The scribe sends BCP-47
    // tags like `en-IN`; strip the region when present. Unsupported Indic
    // languages (Marathi, Tamil, Telugu, Kannada, Malayalam, …) fall through
    // to English auto-detection on AssemblyAI's side — operators should stick
    // with Sarvam for those.
    const language = (opts.language ?? "en-IN").split("-")[0];

    try {
      // 1. Upload audio bytes.
      const uploadRes = await fetch(ASSEMBLYAI_UPLOAD, {
        method: "POST",
        headers: {
          authorization: apiKey,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(audio),
      });
      if (!uploadRes.ok) {
        throw new Error(`AssemblyAI upload failed: ${uploadRes.status}`);
      }
      const uploadBody = (await uploadRes.json()) as { upload_url?: string };
      const uploadUrl = uploadBody.upload_url;
      if (!uploadUrl) {
        throw new Error("AssemblyAI upload returned no upload_url");
      }

      // 2. Request transcription.
      const createRes = await fetch(ASSEMBLYAI_TRANSCRIPT, {
        method: "POST",
        headers: {
          authorization: apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          audio_url: uploadUrl,
          speaker_labels: diarize,
          language_code: language,
        }),
      });
      if (!createRes.ok) {
        throw new Error(`AssemblyAI transcript request failed: ${createRes.status}`);
      }
      const created = (await createRes.json()) as AssemblyAITranscript;
      if (!created.id) {
        throw new Error("AssemblyAI transcript request returned no id");
      }

      // 3. Poll.
      const pollStart = Date.now();
      let final: AssemblyAITranscript | null = null;
      while (Date.now() - pollStart < ASSEMBLYAI_MAX_POLL_MS) {
        const pollRes = await fetch(`${ASSEMBLYAI_TRANSCRIPT}/${created.id}`, {
          headers: { authorization: apiKey },
        });
        if (!pollRes.ok) {
          throw new Error(`AssemblyAI poll failed: ${pollRes.status}`);
        }
        const body = (await pollRes.json()) as AssemblyAITranscript;
        if (body.status === "completed" || body.status === "error") {
          final = body;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, ASSEMBLYAI_POLL_INTERVAL_MS));
      }

      if (!final) {
        throw new Error(`AssemblyAI polling timed out after ${ASSEMBLYAI_MAX_POLL_MS}ms`);
      }
      if (final.status === "error") {
        throw new Error(`AssemblyAI returned error: ${final.error ?? "unknown"}`);
      }

      const utterances = Array.isArray(final.utterances) ? final.utterances : [];
      const rawSegments: ASRSegment[] = utterances.map((u) => ({
        text: u.text,
        startMs: u.start,
        endMs: u.end,
        speaker: u.speaker,
        confidence: u.confidence,
      }));
      const segments = mapSpeakerLabels(rawSegments, { doctorFirst: opts.doctorFirst });

      logAICall({
        feature: "asr-assemblyai",
        model: "assemblyai-universal",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - t0,
      });

      return {
        transcript: final.text ?? segments.map((s) => s.text).join(" ").trim(),
        segments,
        language: final.language_code ?? language,
        provider: "assemblyai",
      };
    } catch (err) {
      logAICall({
        feature: "asr-assemblyai",
        model: "assemblyai-universal",
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

// ── Deepgram (stub) ───────────────────────────────────────────────────────────
//
// Not yet implemented. The re-add path is:
//   1. POST audio bytes to https://api.deepgram.com/v1/listen with header
//      `Authorization: Token <DEEPGRAM_API_KEY>`, query params
//      `diarize=true&punctuate=true&language=<code>&model=nova-2-medical`.
//      No separate upload step — Deepgram accepts raw audio in the request body.
//   2. Response contains `results.channels[0].alternatives[0].words`, each with
//      `speaker: 0|1|2`, `start`/`end` (seconds, not ms), and `word`.
//   3. Group consecutive words by speaker into segments, multiply times by
//      1000, and run mapSpeakerLabels() to convert numeric ids into DOCTOR/…
//   4. Add Deepgram-specific error handling: 402 → quota exceeded, 429 → rate
//      limit; both retryable with exponential backoff on the route layer.

class DeepgramASRClient implements ASRClient {
  readonly provider: ASRProvider = "deepgram";

  async transcribe(_audio: Buffer, _opts: ASRTranscribeOptions): Promise<ASRResult> {
    throw new Error(
      "Deepgram not yet implemented. See apps/api/src/services/ai/asr-providers.ts for the re-add path (Deepgram stub section)."
    );
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Resolve an ASR client for the requested provider. When `provider` is omitted,
 * reads `ASR_PROVIDER` env var (default `"sarvam"`). Throws a descriptive error
 * for unknown providers so misconfiguration fails fast at the first request.
 */
export function getASRClient(provider?: ASRProvider): ASRClient {
  const resolved: ASRProvider = (provider ??
    (process.env.ASR_PROVIDER as ASRProvider | undefined) ??
    "sarvam") as ASRProvider;

  switch (resolved) {
    case "sarvam":
      return new SarvamASRClient();
    case "assemblyai":
      return new AssemblyAIASRClient();
    case "deepgram":
      return new DeepgramASRClient();
    default:
      throw new Error(
        `Unknown ASR_PROVIDER "${resolved}". Expected one of: sarvam, assemblyai, deepgram.`
      );
  }
}

// ── Fallback ──────────────────────────────────────────────────────────────────

export interface ASRFallbackOptions {
  /** Ordered list of providers to try. First success wins. */
  providers: ASRProvider[];
  /**
   * Feature label forwarded to `logAICall` when a provider fails. Must be one
   * of the `asr-*` variants so failover events land in the right alerting
   * bucket.
   */
  feature: "asr-sarvam" | "asr-assemblyai" | "asr-deepgram";
}

/**
 * Try each ASR provider in order; return on first success. On malformed /
 * throwing providers, emit a `failover: true` log and move to the next. If
 * every provider fails, re-throws the final error so the caller can surface a
 * 502 rather than hanging the scribe UI.
 *
 * Mirrors `callWithFallback` in model-router.ts so the observability shape is
 * consistent across LLM and ASR call paths.
 */
export async function callWithASRFallback(
  audio: Buffer,
  opts: ASRTranscribeOptions,
  fallback: ASRFallbackOptions
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
      // Guard against malformed responses: if a provider returns something that
      // doesn't look like an ASRResult, treat it as a failure and fall through
      // rather than letting garbage reach the scribe session.
      if (!result || typeof result.transcript !== "string" || !Array.isArray(result.segments)) {
        throw new Error(
          `ASR provider ${provider} returned a malformed response (missing transcript or segments).`
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
      // otherwise loop to next provider
    }
  }
  throw lastError ?? new Error("callWithASRFallback: exhausted providers");
}
