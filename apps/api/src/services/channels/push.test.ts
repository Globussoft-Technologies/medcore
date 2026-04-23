import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPush } from "./push";

const ENV_KEYS = ["PUSH_API_URL", "PUSH_API_KEY"] as const;
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

describe("sendPush", () => {
  it("returns stub success when env vars are missing", async () => {
    delete process.env.PUSH_API_KEY;
    delete process.env.PUSH_API_URL;
    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "t", "b");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });

  it("POSTs to FCM endpoint with authorization when configured", async () => {
    process.env.PUSH_API_KEY = "k";
    process.env.PUSH_API_URL = "https://fcm.example.com/send";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "projects/xxx/messages/abc" }), {
          status: 200,
        })
      );
    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "T", "B");
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("projects/xxx/messages/abc");
  });

  it("returns error on HTTP failure", async () => {
    process.env.PUSH_API_KEY = "k";
    process.env.PUSH_API_URL = "https://fcm.example.com/send";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 403 })
    );
    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "t", "b");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 403");
  });
});
