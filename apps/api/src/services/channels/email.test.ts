import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmail } from "./email";

const ENV_KEYS = ["EMAIL_API_URL", "EMAIL_API_KEY", "EMAIL_FROM"] as const;
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

describe("sendEmail", () => {
  it("returns stub success when env vars are missing", async () => {
    delete process.env.EMAIL_API_KEY;
    delete process.env.EMAIL_API_URL;
    const res = await sendEmail("x@y.com", "Hi", "body");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });

  it("posts to provider endpoint with JSON body when configured", async () => {
    process.env.EMAIL_API_KEY = "k";
    process.env.EMAIL_API_URL = "https://mail.example.com/send";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("", {
          status: 202,
          headers: { "x-message-id": "mid-42" },
        })
      );
    const res = await sendEmail("to@x.io", "Subj", "Body");
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("mid-42");
  });

  it("returns error on HTTP failure", async () => {
    process.env.EMAIL_API_KEY = "k";
    process.env.EMAIL_API_URL = "https://mail.example.com/send";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 400 })
    );
    const res = await sendEmail("to@x.io", "s", "b");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 400");
  });
});
