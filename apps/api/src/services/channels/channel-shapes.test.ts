// Channel adapter HTTP request-shape tests.
// These exercise the non-stub path: env vars are set, fetch is spied on, and
// we assert the exact URL / method / headers / body envelope that each
// provider expects.
//
// No DB required — pure unit tests.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendWhatsApp } from "./whatsapp";
import { sendSMS } from "./sms";
import { sendEmail } from "./email";
import { sendPush } from "./push";

const ALL_ENV_KEYS = [
  "WHATSAPP_API_URL",
  "WHATSAPP_API_KEY",
  "SMS_API_URL",
  "SMS_API_KEY",
  "SMS_SENDER_ID",
  "EMAIL_API_URL",
  "EMAIL_API_KEY",
  "EMAIL_FROM",
  "PUSH_API_URL",
  "PUSH_API_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ALL_ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ALL_ENV_KEYS) {
    if (savedEnv[k] == null) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  vi.restoreAllMocks();
});

function okJson(body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// ─── WhatsApp ───────────────────────────────────────────
describe("sendWhatsApp — HTTP shape", () => {
  it("POSTs to WHATSAPP_API_URL with bearer auth, JSON body, expected envelope", async () => {
    process.env.WHATSAPP_API_URL = "https://wa.example.com/messages";
    process.env.WHATSAPP_API_KEY = "wa-secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okJson({ messageId: "wa-42" }));

    const res = await sendWhatsApp("+911234567890", "Hi there");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://wa.example.com/messages");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer wa-secret");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      to: "+911234567890",
      type: "text",
      text: { body: "Hi there" },
    });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("wa-42");
  });

  it("falls back to response.id when messageId is absent", async () => {
    process.env.WHATSAPP_API_URL = "https://wa.example.com/messages";
    process.env.WHATSAPP_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(okJson({ id: "id-7" }));
    const res = await sendWhatsApp("+91", "hi");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("id-7");
  });

  it("returns {ok:false} when the provider returns 500", async () => {
    process.env.WHATSAPP_API_URL = "https://wa.example.com/messages";
    process.env.WHATSAPP_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("boom", { status: 500 })
    );
    const res = await sendWhatsApp("+91", "hi");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("HTTP 500");
  });

  it("returns {ok:false} when fetch itself throws (network error)", async () => {
    process.env.WHATSAPP_API_URL = "https://wa.example.com/messages";
    process.env.WHATSAPP_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await sendWhatsApp("+91", "hi");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ECONNRESET/);
  });
});

// ─── SMS ────────────────────────────────────────────────
describe("sendSMS — HTTP shape", () => {
  it("POSTs to SMS_API_URL with bearer auth, JSON body including sender id", async () => {
    process.env.SMS_API_URL = "https://sms.example.com/send";
    process.env.SMS_API_KEY = "sms-secret";
    process.env.SMS_SENDER_ID = "MEDCOR";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okJson({ messageId: "sms-1" }));

    const res = await sendSMS("+919999999999", "Your OTP is 123456");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://sms.example.com/send");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer sms-secret");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      to: "+919999999999",
      message: "Your OTP is 123456",
      sender: "MEDCOR",
    });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("sms-1");
  });

  it("defaults sender to 'MEDCOR' when SMS_SENDER_ID is unset", async () => {
    process.env.SMS_API_URL = "https://sms.example.com/send";
    process.env.SMS_API_KEY = "k";
    delete process.env.SMS_SENDER_ID;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okJson({ id: "x" }));
    await sendSMS("+91", "hi");
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.sender).toBe("MEDCOR");
  });

  it("returns {ok:false} on HTTP 500", async () => {
    process.env.SMS_API_URL = "https://sms.example.com/send";
    process.env.SMS_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("err", { status: 500 })
    );
    const res = await sendSMS("+91", "hi");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("HTTP 500");
  });

  it("stub path: no env vars set → ok:true with 'stub-' messageId", async () => {
    delete process.env.SMS_API_URL;
    delete process.env.SMS_API_KEY;
    const res = await sendSMS("+91", "hi");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });
});

// ─── Email ──────────────────────────────────────────────
describe("sendEmail — HTTP shape", () => {
  it("POSTs a SendGrid-style envelope with personalizations + from + content", async () => {
    process.env.EMAIL_API_URL = "https://api.sendgrid.com/v3/mail/send";
    process.env.EMAIL_API_KEY = "sg-secret";
    process.env.EMAIL_FROM = "noreply@medcore.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okJson({}, { "x-message-id": "sg-123" }));

    const res = await sendEmail("alice@example.com", "Welcome", "Hello");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sg-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      personalizations: [{ to: [{ email: "alice@example.com" }] }],
      from: { email: "noreply@medcore.test" },
      subject: "Welcome",
      content: [{ type: "text/plain", value: "Hello" }],
    });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("sg-123");
  });

  it("defaults sender to noreply@medcore.local when EMAIL_FROM is unset", async () => {
    process.env.EMAIL_API_URL = "https://api.sendgrid.com/v3/mail/send";
    process.env.EMAIL_API_KEY = "k";
    delete process.env.EMAIL_FROM;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okJson({}));
    await sendEmail("a@b.co", "S", "B");
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.from.email).toBe("noreply@medcore.local");
  });

  it("returns {ok:false} on HTTP 500", async () => {
    process.env.EMAIL_API_URL = "https://api.sendgrid.com/v3/mail/send";
    process.env.EMAIL_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("err", { status: 500 })
    );
    const res = await sendEmail("a@b.co", "s", "b");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("HTTP 500");
  });

  it("stub path: no env vars set → ok:true with stub messageId", async () => {
    delete process.env.EMAIL_API_URL;
    delete process.env.EMAIL_API_KEY;
    const res = await sendEmail("a@b.co", "s", "b");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });
});

// ─── Push (FCM-style) ───────────────────────────────────
describe("sendPush — HTTP shape", () => {
  it("POSTs an FCM-style envelope with message.topic + notification", async () => {
    process.env.PUSH_API_URL = "https://fcm.googleapis.com/v1/projects/p/messages:send";
    process.env.PUSH_API_KEY = "fcm-secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(okJson({ name: "projects/p/messages/abc" }));

    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "You have mail", "Body");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://fcm.googleapis.com/v1/projects/p/messages:send"
    );
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fcm-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      message: {
        topic: "user_user-123",
        notification: { title: "You have mail", body: "Body" },
      },
    });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("projects/p/messages/abc");
  });

  it("returns {ok:false} on HTTP 500", async () => {
    process.env.PUSH_API_URL = "https://fcm.googleapis.com/v1/projects/p/messages:send";
    process.env.PUSH_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("err", { status: 500 })
    );
    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "t", "b");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("HTTP 500");
  });

  it("returns {ok:false} when fetch throws", async () => {
    process.env.PUSH_API_URL = "https://fcm.googleapis.com/v1/projects/p/messages:send";
    process.env.PUSH_API_KEY = "k";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("DNS fail"));
    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "t", "b");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/DNS fail/);
  });

  it("stub path: no env vars set → ok:true with stub messageId", async () => {
    delete process.env.PUSH_API_URL;
    delete process.env.PUSH_API_KEY;
    const res = await sendPush(["ExponentPushToken[xxxxxx]"], "t", "b");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
  });
});
