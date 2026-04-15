import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSMS } from "./sms";

const ENV_KEYS = ["SMS_API_URL", "SMS_API_KEY", "SMS_SENDER_ID"] as const;
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

describe("sendSMS", () => {
  it("returns stub success when env vars are missing", async () => {
    delete process.env.SMS_API_KEY;
    delete process.env.SMS_API_URL;
    const res = await sendSMS("+91", "hi");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });

  it("POSTs to configured URL with sender id", async () => {
    process.env.SMS_API_KEY = "k";
    process.env.SMS_API_URL = "https://sms.example.com/send";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "sms-1" }), { status: 200 })
      );
    const res = await sendSMS("+9199", "hi");
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("sms-1");
  });

  it("returns error on HTTP failure", async () => {
    process.env.SMS_API_KEY = "k";
    process.env.SMS_API_URL = "https://sms.example.com/send";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 502 })
    );
    const res = await sendSMS("+9199", "hi");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 502");
  });
});
