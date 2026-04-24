import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// Providers call the network via the global `fetch` — we stub it per test so
// we can assert request shape and drive response bodies without a real HTTP
// round-trip.

const logAICallSpy = vi.fn();
vi.mock("./sarvam-logging", () => ({
  logAICall: (opts: any) => logAICallSpy(opts),
}));

import {
  getASRClient,
  callWithASRFallback,
  mapSpeakerLabels,
  type ASRClient,
  type ASRResult,
} from "./asr-providers";

// Preserve original env so individual tests can safely mutate process.env.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  logAICallSpy.mockReset();
  // Reset the env vars we care about so tests don't leak into each other.
  delete process.env.ASR_PROVIDER;
  delete process.env.ASSEMBLYAI_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  process.env.SARVAM_API_KEY = "test-sarvam-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

// ── getASRClient ──────────────────────────────────────────────────────────────

describe("getASRClient", () => {
  it("defaults to sarvam when ASR_PROVIDER is unset", () => {
    const client = getASRClient();
    expect(client.provider).toBe("sarvam");
  });

  it("returns an AssemblyAI client when ASR_PROVIDER=assemblyai", () => {
    process.env.ASR_PROVIDER = "assemblyai";
    const client = getASRClient();
    expect(client.provider).toBe("assemblyai");
  });

  it("throws a clear error when ASR_PROVIDER is unknown", () => {
    expect(() => getASRClient("whispr" as any)).toThrow(/Unknown ASR_PROVIDER/i);
  });

  it("Deepgram stub throws with the documented re-add instructions", async () => {
    const client = getASRClient("deepgram");
    await expect(client.transcribe(Buffer.from([1, 2, 3]), {})).rejects.toThrow(
      /Deepgram not yet implemented/i
    );
  });
});

// ── Sarvam client ─────────────────────────────────────────────────────────────

describe("SarvamASRClient.transcribe", () => {
  it("returns a single segment with no speaker label", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ transcript: "Hello doctor", language_code: "en-IN" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = getASRClient("sarvam");
    const result = await client.transcribe(Buffer.from([1, 2, 3]), { language: "en-IN" });

    expect(result.provider).toBe("sarvam");
    expect(result.transcript).toBe("Hello doctor");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe("Hello doctor");
    expect(result.segments[0].speaker).toBeUndefined();
    expect(result.language).toBe("en-IN");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sarvam.ai/speech-to-text",
      expect.objectContaining({ method: "POST" })
    );
    expect(
      logAICallSpy.mock.calls.some((c) => c[0]?.feature === "asr-sarvam" && !c[0]?.error)
    ).toBe(true);
  });

  it("throws when SARVAM_API_KEY is missing", async () => {
    delete process.env.SARVAM_API_KEY;
    const client = getASRClient("sarvam");
    await expect(client.transcribe(Buffer.from([1]), {})).rejects.toThrow(
      /SARVAM_API_KEY is not configured/
    );
  });
});

// ── AssemblyAI client ─────────────────────────────────────────────────────────

describe("AssemblyAIASRClient.transcribe", () => {
  it("rejects when ASSEMBLYAI_API_KEY is missing", async () => {
    const client = getASRClient("assemblyai");
    await expect(client.transcribe(Buffer.from([1]), {})).rejects.toThrow(
      /ASSEMBLYAI_API_KEY is not configured/
    );
  });

  it("returns multi-speaker segments mapped to DOCTOR/PATIENT/ATTENDANT", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-aai-key";

    // Sequence: upload → create transcript → poll (completed on first poll).
    const fetchSeq: Array<() => Response> = [
      () =>
        new Response(JSON.stringify({ upload_url: "https://cdn.assemblyai.com/u/abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(JSON.stringify({ id: "tr-123", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(
          JSON.stringify({
            id: "tr-123",
            status: "completed",
            text: "Hello how are you I have a fever my son is with me",
            language_code: "en",
            utterances: [
              { text: "Hello how are you", start: 0, end: 1500, speaker: "A", confidence: 0.95 },
              { text: "I have a fever", start: 1600, end: 3200, speaker: "B", confidence: 0.92 },
              { text: "my son is with me", start: 3300, end: 4800, speaker: "C", confidence: 0.9 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ];
    let callIdx = 0;
    const fetchMock = vi.fn(async () => {
      const builder = fetchSeq[callIdx] ?? fetchSeq[fetchSeq.length - 1];
      callIdx += 1;
      return builder();
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = getASRClient("assemblyai");
    const result = await client.transcribe(Buffer.from([1, 2, 3]), {
      language: "en-IN",
      diarize: true,
    });

    expect(result.provider).toBe("assemblyai");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0].speaker).toBe("DOCTOR");
    expect(result.segments[1].speaker).toBe("PATIENT");
    expect(result.segments[2].speaker).toBe("ATTENDANT");
    expect(result.segments[0].startMs).toBe(0);
    expect(result.segments[0].endMs).toBe(1500);
    // First fetch should be the upload call with octet-stream content-type.
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstCallInit = calls[0][1];
    expect((firstCallInit.headers as any)["content-type"]).toBe("application/octet-stream");
    // Second fetch is the transcript request with speaker_labels flag.
    const secondBody = JSON.parse(calls[1][1].body as string);
    expect(secondBody.speaker_labels).toBe(true);
    expect(secondBody.audio_url).toBe("https://cdn.assemblyai.com/u/abc");
    expect(secondBody.language_code).toBe("en");
  });
});

// ── Speaker mapping helper ────────────────────────────────────────────────────

describe("mapSpeakerLabels", () => {
  it("maps first-to-speak to DOCTOR across a 3-speaker conversation", () => {
    const segments = [
      { speaker: "A", text: "Good morning" },
      { speaker: "B", text: "Morning doctor" },
      { speaker: "A", text: "Tell me about your symptoms" },
      { speaker: "C", text: "He also has a headache" },
      { speaker: "B", text: "I have fever since two days" },
    ];
    const mapped = mapSpeakerLabels(segments, { doctorFirst: true });
    expect(mapped.map((s) => s.speaker)).toEqual([
      "DOCTOR",
      "PATIENT",
      "DOCTOR",
      "ATTENDANT",
      "PATIENT",
    ]);
  });

  it("leaves 4th+ speakers as the raw label", () => {
    const segments = [
      { speaker: "A", text: "one" },
      { speaker: "B", text: "two" },
      { speaker: "C", text: "three" },
      { speaker: "D", text: "four" },
    ];
    const mapped = mapSpeakerLabels(segments);
    expect(mapped.map((s) => s.speaker)).toEqual(["DOCTOR", "PATIENT", "ATTENDANT", "D"]);
  });
});

// ── callWithASRFallback ───────────────────────────────────────────────────────

describe("callWithASRFallback", () => {
  it("tries providers in order and returns first success", async () => {
    const audio = Buffer.from([1, 2, 3]);
    const sarvamResult: ASRResult = {
      transcript: "ok",
      segments: [{ text: "ok", startMs: 0, endMs: 0 }],
      provider: "sarvam",
    };

    // Stub fetch so the sarvam client succeeds on first try.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ transcript: "ok", language_code: "en-IN" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const out = await callWithASRFallback(audio, { language: "en-IN" }, {
      providers: ["sarvam", "assemblyai"],
      feature: "asr-sarvam",
    });
    expect(out.provider).toBe("sarvam");
    expect(out.transcript).toBe(sarvamResult.transcript);
    // No failover event when the first provider succeeds.
    expect(logAICallSpy.mock.calls.some((c) => c[0]?.failover === true)).toBe(false);
  });

  it("falls through to the next provider on failure and logs failover", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-aai-key";
    process.env.SARVAM_API_KEY = "test-sarvam-key";

    // First provider (assemblyai) — upload fails with 500. Second provider
    // (sarvam) succeeds.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response("boom", { status: 500 });
        }
        return new Response(
          JSON.stringify({ transcript: "recovered", language_code: "en-IN" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const out = await callWithASRFallback(Buffer.from([1]), {}, {
      providers: ["assemblyai", "sarvam"],
      feature: "asr-assemblyai",
    });
    expect(out.provider).toBe("sarvam");
    const failovers = logAICallSpy.mock.calls.map((c) => c[0]).filter((e) => e.failover === true);
    expect(failovers).toHaveLength(1);
    expect(failovers[0].model).toBe("assemblyai");
  });
});
