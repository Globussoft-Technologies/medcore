import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSMS } from "./sms";

const ENV_KEYS = [
  "SMS_API_URL",
  "SMS_API_KEY",
  "SMS_SENDER_ID",
  "SMS_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Start every test from a clean env so unrelated provider settings don't leak in.
  for (const k of ENV_KEYS) delete process.env[k];
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

describe("sendSMS — Twilio adapter", () => {
  it("falls back to stub mode (with warning) when SMS_PROVIDER=twilio but Twilio env vars are unset", async () => {
    process.env.SMS_PROVIDER = "twilio";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await sendSMS("+919999999999", "hi");
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^stub-/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SMS_PROVIDER=twilio")
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to Twilio Messages.json with Basic Auth + form-encoded body when fully configured", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123abc";
    process.env.TWILIO_AUTH_TOKEN = "tok-secret";
    process.env.TWILIO_FROM_NUMBER = "+15551234567";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sid: "SM-twilio-1" }), { status: 201 })
      );

    const res = await sendSMS("+919876543210", "hello from twilio");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    // URL points at the right Twilio resource for THIS account
    expect(String(url)).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC123abc/Messages.json"
    );
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("POST");

    const headers = reqInit.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // Basic Auth is base64(AccountSid:AuthToken)
    const expectedBasic = Buffer.from("AC123abc:tok-secret").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expectedBasic}`);

    // Body is x-www-form-urlencoded with To/From/Body
    const body = String(reqInit.body);
    const parsed = new URLSearchParams(body);
    expect(parsed.get("To")).toBe("+919876543210");
    expect(parsed.get("From")).toBe("+15551234567");
    expect(parsed.get("Body")).toBe("hello from twilio");

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("SM-twilio-1");
  });

  it("prefixes bare Indian numbers with +91 for E.164 compliance", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123abc";
    process.env.TWILIO_AUTH_TOKEN = "tok-secret";
    process.env.TWILIO_FROM_NUMBER = "+15551234567";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sid: "SM-2" }), { status: 201 })
      );

    await sendSMS("9876543210", "hi");

    const [, init] = fetchSpy.mock.calls[0];
    const parsed = new URLSearchParams(String((init as RequestInit).body));
    expect(parsed.get("To")).toBe("+919876543210");
  });

  it("throws-as-error with unauthorized hint on Twilio 401", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123abc";
    process.env.TWILIO_AUTH_TOKEN = "tok-bad";
    process.env.TWILIO_FROM_NUMBER = "+15551234567";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Authenticate", code: 20003 }),
        { status: 401 }
      )
    );

    const res = await sendSMS("+919876543210", "hi");
    expect(res.ok).toBe(false);
    expect(res.error?.toLowerCase()).toContain("unauthorized");
    expect(res.error).toContain("Authenticate");
  });

  it("surfaces Twilio error body 'message' field on non-2xx (non-401)", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123abc";
    process.env.TWILIO_AUTH_TOKEN = "tok-secret";
    process.env.TWILIO_FROM_NUMBER = "+15551234567";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Invalid 'To' Phone Number", code: 21211 }),
        { status: 400 }
      )
    );

    const res = await sendSMS("+919876543210", "hi");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid 'To' Phone Number");
  });

  it("provider routing: SMS_PROVIDER=twilio invokes Twilio API (not MSG91/generic)", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.TWILIO_ACCOUNT_SID = "AC123abc";
    process.env.TWILIO_AUTH_TOKEN = "tok-secret";
    process.env.TWILIO_FROM_NUMBER = "+15551234567";
    // Also set MSG91/generic envs to prove they're NOT chosen when provider=twilio
    process.env.SMS_API_KEY = "msg91-key";
    process.env.SMS_API_URL = "https://api.msg91.com/api/v5/flow/";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sid: "SM-routed" }), { status: 201 })
      );

    await sendSMS("+919876543210", "hi");

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("api.twilio.com");
    expect(String(url)).not.toContain("msg91.com");
  });
});
