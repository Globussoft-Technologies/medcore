import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// Sarvam is called via the global `fetch` — we stub it per test so we can
// assert request shape and drive response bodies without a real HTTP round-trip.

const logAICallSpy = vi.fn();
vi.mock("./sarvam-logging", () => ({
  logAICall: (opts: any) => logAICallSpy(opts),
}));

import {
  getASRClient,
  callWithASRFallback,
  mapSpeakerLabels,
} from "./asr-providers";

// Preserve original env so individual tests can safely mutate process.env.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  logAICallSpy.mockReset();
  delete process.env.ASR_PROVIDER;
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

  it("returns the Sarvam client when ASR_PROVIDER=sarvam", () => {
    process.env.ASR_PROVIDER = "sarvam";
    const client = getASRClient();
    expect(client.provider).toBe("sarvam");
  });

  it("throws a clear error for legacy AssemblyAI / Deepgram values", () => {
    expect(() => getASRClient("assemblyai" as any)).toThrow(
      /Only "sarvam" is supported/i,
    );
    expect(() => getASRClient("deepgram" as any)).toThrow(
      /Only "sarvam" is supported/i,
    );
  });

  it("throws for any other unknown ASR_PROVIDER", () => {
    expect(() => getASRClient("whispr" as any)).toThrow(/Only "sarvam" is supported/i);
  });
});

// ── Sarvam client ─────────────────────────────────────────────────────────────

describe("SarvamASRClient.transcribe", () => {
  it("returns a single segment with no speaker label", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ transcript: "Hello doctor", language_code: "en-IN" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
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
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      logAICallSpy.mock.calls.some((c) => c[0]?.feature === "asr-sarvam" && !c[0]?.error),
    ).toBe(true);
  });

  it("throws when SARVAM_API_KEY is missing", async () => {
    delete process.env.SARVAM_API_KEY;
    const client = getASRClient("sarvam");
    await expect(client.transcribe(Buffer.from([1]), {})).rejects.toThrow(
      /SARVAM_API_KEY is not configured/,
    );
  });

  it("returns an empty segments array when the transcript is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ transcript: "", language_code: "en-IN" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = getASRClient("sarvam");
    const result = await client.transcribe(Buffer.from([1]), { language: "en-IN" });
    expect(result.transcript).toBe("");
    expect(result.segments).toEqual([]);
  });
});

// ── mapSpeakerLabels ──────────────────────────────────────────────────────────

describe("mapSpeakerLabels", () => {
  it("maps the first three distinct labels to DOCTOR/PATIENT/ATTENDANT", () => {
    const segments = [
      { speaker: "A", text: "hello" },
      { speaker: "B", text: "hi" },
      { speaker: "A", text: "again" },
      { speaker: "C", text: "third" },
      { speaker: "B", text: "fourth" },
    ];
    const mapped = mapSpeakerLabels(segments);
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
  it("returns the Sarvam result when the providers list is just sarvam", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ transcript: "ok", language_code: "en-IN" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const out = await callWithASRFallback(
      Buffer.from([1, 2, 3]),
      { language: "en-IN" },
      { providers: ["sarvam"], feature: "asr-sarvam" },
    );
    expect(out.provider).toBe("sarvam");
    expect(out.transcript).toBe("ok");
    // No failover event when the only provider succeeds.
    expect(logAICallSpy.mock.calls.some((c) => c[0]?.failover === true)).toBe(false);
  });

  it("re-throws the underlying error when the only provider fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    await expect(
      callWithASRFallback(
        Buffer.from([1]),
        {},
        { providers: ["sarvam"], feature: "asr-sarvam" },
      ),
    ).rejects.toThrow();

    const failovers = logAICallSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.failover === true);
    expect(failovers).toHaveLength(1);
    expect(failovers[0].model).toBe("sarvam");
  });

  it("rejects an empty providers array", async () => {
    await expect(
      callWithASRFallback(
        Buffer.from([1]),
        {},
        { providers: [], feature: "asr-sarvam" },
      ),
    ).rejects.toThrow(/providers array must not be empty/i);
  });
});
