import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWhatsApp } from "./whatsapp";

const ENV_KEYS = ["WHATSAPP_API_URL", "WHATSAPP_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  vi.restoreAllMocks();
});

describe("sendWhatsApp", () => {
  it("returns a stub success when env vars are missing", async () => {
    delete process.env.WHATSAPP_API_KEY;
    delete process.env.WHATSAPP_API_URL;
    const res = await sendWhatsApp("+911234567890", "Hello");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });

  it("calls fetch with bearer Authorization when configured", async () => {
    process.env.WHATSAPP_API_KEY = "k";
    process.env.WHATSAPP_API_URL = "https://example.com/wa";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messageId: "wa-1" }), { status: 200 })
      );
    const res = await sendWhatsApp("+9199", "hi");
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("wa-1");
  });

  it("returns error on HTTP failure", async () => {
    process.env.WHATSAPP_API_KEY = "k";
    process.env.WHATSAPP_API_URL = "https://example.com/wa";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("bad", { status: 500 })
    );
    const res = await sendWhatsApp("+9199", "hi");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 500");
  });
});
