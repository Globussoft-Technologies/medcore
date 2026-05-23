// Pearl ERP Stage 1 §6.1 (gap row 167) — pure-function unit coverage for
// the WhatsApp provider adapter.
//
// What / which modules / why:
//   - Targets apps/api/src/services/whatsapp-providers.ts.
//   - The integration test (apps/api/src/test/integration/whatsapp-inbox.test.ts)
//     exercises end-to-end OUTBOUND through Gupshup only; the other four
//     providers' send branches + signature/parse helpers were not directly
//     covered, which pushed function coverage under the 68% gate after the
//     +274 LOC adapter landed (commit 751ae3b).
//   - This file mocks `fetch` via vi.stubGlobal so no real network is
//     touched. We assert the request shape (URL / method / headers / body)
//     each branch issues so a future regression in the wire contract is
//     caught immediately. We then exercise the non-2xx and network-throw
//     paths to lock the error-surface contract that whatsapp-inbox.ts
//     depends on (FAILED row + 502 in strict mode).
//
// Tests run in WHATSAPP_OUTBOUND_STRICT=true so sendOutboundMessage()'s
// stub-fallback branch doesn't swallow the assertions.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createHmac } from "node:crypto";
import {
  sendOutboundMessage,
  parseInboundMessage,
  verifyInboundSignature,
  canonicalizePhone,
  extractDestinationPhone,
} from "./whatsapp-providers";

// ── fetch mock plumbing ──────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let prevStrict: string | undefined;

/** Install a fetch stub that records each call and returns the given body/status. */
function stubFetchOk(body: unknown, status = 200): void {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    return new Response(json, {
      status,
      headers: { "content-type": "application/json" },
    });
  }));
}

function stubFetchThrow(message = "network down"): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error(message);
  }));
}

function lastFetch(): FetchCall {
  if (fetchCalls.length === 0) throw new Error("no fetch call recorded");
  return fetchCalls[fetchCalls.length - 1];
}

beforeEach(() => {
  fetchCalls = [];
  prevStrict = process.env.WHATSAPP_OUTBOUND_STRICT;
  // Force strict mode so non-2xx + thrown branches surface real errors
  // instead of falling back to the dev stub id.
  process.env.WHATSAPP_OUTBOUND_STRICT = "true";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (prevStrict === undefined) delete process.env.WHATSAPP_OUTBOUND_STRICT;
  else process.env.WHATSAPP_OUTBOUND_STRICT = prevStrict;
});

// ──────────────────────────────────────────────────────────────────────
// canonicalizePhone — small but heavily reused; locks the contract.
// ──────────────────────────────────────────────────────────────────────

describe("canonicalizePhone normalizes the many inbound shapes to E.164", () => {
  it("strips the whatsapp: prefix and keeps a + number intact", () => {
    expect(canonicalizePhone("whatsapp:+919876500001")).toBe("+919876500001");
  });

  it("treats a bare 10-digit number as Indian (+91)", () => {
    expect(canonicalizePhone("9876500001")).toBe("+919876500001");
  });

  it("prepends + to an 11-15 digit raw number", () => {
    expect(canonicalizePhone("919876500001")).toBe("+919876500001");
  });

  it("returns null on garbage / empty / sub-7-digit input", () => {
    expect(canonicalizePhone(null)).toBeNull();
    expect(canonicalizePhone("")).toBeNull();
    expect(canonicalizePhone("12345")).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// sendOutboundMessage — one provider per describe block, each covering
// happy path + non-2xx (throws) + network throw (throws).
// ──────────────────────────────────────────────────────────────────────

describe("sendOutboundMessage GUPSHUP issues a form-encoded POST with apikey + src.name", () => {
  const config = {
    apiKey: "gs-test-key",
    appName: "MedCoreApp",
    sourcePhone: "+919811111111",
  };
  const phone = "+919876500001";
  const body = "Hello from Gupshup";

  it("posts the right URL/method/headers/body and returns providerMessageId on 200", async () => {
    stubFetchOk({ messageId: "gs-msg-123" });
    const result = await sendOutboundMessage("GUPSHUP", config, phone, body);
    expect(result.providerMessageId).toBe("gs-msg-123");
    expect(result.sentAt).toBeInstanceOf(Date);

    const call = lastFetch();
    expect(call.url).toBe("https://api.gupshup.io/sm/api/v1/msg");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.apikey).toBe("gs-test-key");

    const params = new URLSearchParams(String(call.init.body));
    expect(params.get("channel")).toBe("whatsapp");
    expect(params.get("source")).toBe("919811111111"); // + stripped
    expect(params.get("destination")).toBe("919876500001");
    expect(params.get("src.name")).toBe("MedCoreApp");
    expect(JSON.parse(params.get("message")!)).toEqual({
      type: "text",
      text: body,
    });
  });

  it("falls back to data.id then a stub id when messageId is absent", async () => {
    stubFetchOk({ id: "alt-id-456" });
    const result = await sendOutboundMessage("GUPSHUP", config, phone, body);
    expect(result.providerMessageId).toBe("alt-id-456");
  });

  it("throws with the provider's error message on non-2xx in strict mode", async () => {
    stubFetchOk({ message: "Bad shared key" }, 401);
    await expect(
      sendOutboundMessage("GUPSHUP", config, phone, body),
    ).rejects.toThrow(/Bad shared key/);
  });

  it("surfaces the network error in strict mode", async () => {
    stubFetchThrow("ECONNRESET");
    await expect(
      sendOutboundMessage("GUPSHUP", config, phone, body),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("throws a descriptive config error when apiKey/appName/sourcePhone missing", async () => {
    stubFetchOk({});
    await expect(
      sendOutboundMessage("GUPSHUP", {}, phone, body),
    ).rejects.toThrow(/Gupshup config missing/);
  });
});

describe("sendOutboundMessage WATI uses Bearer + tenantUrl/sendSessionMessage", () => {
  const config = {
    bearerToken: "wati-bearer-xyz",
    tenantUrl: "https://live-server-12345.wati.io/",
  };
  const phone = "+919876500001";
  const body = "Hello from WATI";

  it("builds /api/v1/sendSessionMessage/<digits>?messageText=<urlencoded> with Bearer", async () => {
    stubFetchOk({ id: "wati-msg-1" });
    const result = await sendOutboundMessage("WATI", config, phone, body);
    expect(result.providerMessageId).toBe("wati-msg-1");

    const call = lastFetch();
    expect(call.url).toMatch(
      /^https:\/\/live-server-12345\.wati\.io\/api\/v1\/sendSessionMessage\/919876500001\?messageText=Hello%20from%20WATI$/,
    );
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer wati-bearer-xyz");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("picks data.message.id when top-level id missing", async () => {
    stubFetchOk({ message: { id: "wati-nested-id" } });
    const result = await sendOutboundMessage("WATI", config, phone, body);
    expect(result.providerMessageId).toBe("wati-nested-id");
  });

  it("throws on non-2xx with the provider's error in strict mode", async () => {
    stubFetchOk({ error: "Tenant suspended" }, 403);
    await expect(
      sendOutboundMessage("WATI", config, phone, body),
    ).rejects.toThrow(/Tenant suspended/);
  });

  it("throws on network failure in strict mode", async () => {
    stubFetchThrow("ETIMEDOUT");
    await expect(
      sendOutboundMessage("WATI", config, phone, body),
    ).rejects.toThrow(/ETIMEDOUT/);
  });

  it("throws when bearerToken/tenantUrl missing", async () => {
    stubFetchOk({});
    await expect(
      sendOutboundMessage("WATI", { bearerToken: "t" }, phone, body),
    ).rejects.toThrow(/WATI config missing/);
  });
});

describe("sendOutboundMessage AISENSEI posts JSON {to,text} with apiKey header", () => {
  const config = {
    apiKey: "ai-key",
    baseUrl: "https://api.aisensei.test/v1/",
  };
  const phone = "+919876500001";
  const body = "Hello from AiSensei";

  it("posts to <baseUrl>/messages with apiKey + JSON body, returns message_id", async () => {
    stubFetchOk({ message_id: "ai-msg-1" });
    const result = await sendOutboundMessage("AISENSEI", config, phone, body);
    expect(result.providerMessageId).toBe("ai-msg-1");

    const call = lastFetch();
    expect(call.url).toBe("https://api.aisensei.test/v1/messages");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.apiKey).toBe("ai-key");
    expect(JSON.parse(String(call.init.body))).toEqual({
      to: phone,
      text: body,
    });
  });

  it("falls back to data.id then stub when message_id missing", async () => {
    stubFetchOk({ id: "ai-alt-id" });
    const result = await sendOutboundMessage("AISENSEI", config, phone, body);
    expect(result.providerMessageId).toBe("ai-alt-id");
  });

  it("throws on non-2xx with the provider's error", async () => {
    stubFetchOk({ errorMessage: "Quota exceeded" }, 429);
    await expect(
      sendOutboundMessage("AISENSEI", config, phone, body),
    ).rejects.toThrow(/Quota exceeded/);
  });

  it("throws on network failure", async () => {
    stubFetchThrow("ENETUNREACH");
    await expect(
      sendOutboundMessage("AISENSEI", config, phone, body),
    ).rejects.toThrow(/ENETUNREACH/);
  });

  it("throws when apiKey/baseUrl missing", async () => {
    stubFetchOk({});
    await expect(
      sendOutboundMessage("AISENSEI", { apiKey: "k" }, phone, body),
    ).rejects.toThrow(/AiSensei config missing/);
  });
});

describe("sendOutboundMessage INTERAKT posts Basic-auth JSON with countryCode/phoneNumber split", () => {
  const config = { apiKey: "ik-key" };
  const phone = "+919876500001";
  const body = "Hello from Interakt";

  it("Basic-auths with apiKey, splits +91NNNNNNNNNN into countryCode=91 / phoneNumber=NNNNNNNNNN", async () => {
    stubFetchOk({ id: "ik-msg-1" });
    const result = await sendOutboundMessage("INTERAKT", config, phone, body);
    expect(result.providerMessageId).toBe("ik-msg-1");

    const call = lastFetch();
    expect(call.url).toBe("https://api.interakt.ai/v1/public/message/");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    // Basic auth of "ik-key:" → base64
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("ik-key:").toString("base64")}`,
    );

    const json = JSON.parse(String(call.init.body));
    expect(json).toEqual({
      countryCode: "91",
      phoneNumber: "9876500001",
      type: "Text",
      data: { message: body },
    });
  });

  it("falls back to data.result.id then a stub when data.id missing", async () => {
    stubFetchOk({ result: { id: "ik-nested-id" } });
    const result = await sendOutboundMessage("INTERAKT", config, phone, body);
    expect(result.providerMessageId).toBe("ik-nested-id");
  });

  it("throws on non-2xx", async () => {
    stubFetchOk({ message: "Invalid api key" }, 401);
    await expect(
      sendOutboundMessage("INTERAKT", config, phone, body),
    ).rejects.toThrow(/Invalid api key/);
  });

  it("throws on network failure", async () => {
    stubFetchThrow("ECONNREFUSED");
    await expect(
      sendOutboundMessage("INTERAKT", config, phone, body),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws when apiKey missing", async () => {
    stubFetchOk({});
    await expect(
      sendOutboundMessage("INTERAKT", {}, phone, body),
    ).rejects.toThrow(/Interakt config missing/);
  });
});

describe("sendOutboundMessage META posts to graph.facebook.com/v18.0/<id>/messages", () => {
  const config = {
    accessToken: "meta-access-token-xyz",
    phoneNumberId: "1234567890",
  };
  const phone = "+919876500001";
  const body = "Hello from Meta";

  it("Bearer-auths with accessToken, posts JSON with messaging_product:whatsapp", async () => {
    stubFetchOk({ messages: [{ id: "wamid.abc123" }] });
    const result = await sendOutboundMessage("META", config, phone, body);
    expect(result.providerMessageId).toBe("wamid.abc123");

    const call = lastFetch();
    expect(call.url).toBe(
      "https://graph.facebook.com/v18.0/1234567890/messages",
    );
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer meta-access-token-xyz");
    expect(headers["Content-Type"]).toBe("application/json");

    const json = JSON.parse(String(call.init.body));
    expect(json).toEqual({
      messaging_product: "whatsapp",
      to: "919876500001", // + stripped
      type: "text",
      text: { body },
    });
  });

  it("falls back to a stub id when messages[0].id is absent", async () => {
    stubFetchOk({ messages: [{}] });
    const result = await sendOutboundMessage("META", config, phone, body);
    expect(result.providerMessageId).toMatch(/^stub-/);
  });

  it("throws with the Meta error.message on non-2xx", async () => {
    stubFetchOk({ error: { message: "Invalid OAuth token" } }, 401);
    await expect(
      sendOutboundMessage("META", config, phone, body),
    ).rejects.toThrow(/Invalid OAuth token/);
  });

  it("falls back to a generic HTTP message on non-2xx with no error.message", async () => {
    stubFetchOk({}, 500);
    await expect(
      sendOutboundMessage("META", config, phone, body),
    ).rejects.toThrow(/Meta HTTP 500/);
  });

  it("throws on network failure", async () => {
    stubFetchThrow("EHOSTUNREACH");
    await expect(
      sendOutboundMessage("META", config, phone, body),
    ).rejects.toThrow(/EHOSTUNREACH/);
  });

  it("throws when accessToken/phoneNumberId missing", async () => {
    stubFetchOk({});
    await expect(
      sendOutboundMessage("META", { accessToken: "x" }, phone, body),
    ).rejects.toThrow(/Meta config missing/);
  });
});

describe("sendOutboundMessage non-strict mode swallows errors into a stub id", () => {
  it("returns a stub id when the provider HTTP fails in non-strict mode", async () => {
    delete process.env.WHATSAPP_OUTBOUND_STRICT;
    stubFetchOk({ error: "down" }, 500);
    const result = await sendOutboundMessage(
      "GUPSHUP",
      { apiKey: "k", appName: "a", sourcePhone: "+919811111111" },
      "+919876500001",
      "body",
    );
    expect(result.providerMessageId).toMatch(/^stub-/);
  });

  it("returns a stub id when the network throws in non-strict mode", async () => {
    delete process.env.WHATSAPP_OUTBOUND_STRICT;
    stubFetchThrow("DNS");
    const result = await sendOutboundMessage(
      "META",
      { accessToken: "t", phoneNumberId: "id" },
      "+919876500001",
      "body",
    );
    expect(result.providerMessageId).toMatch(/^stub-/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseInboundMessage — one happy + one ignored-shape per provider.
// ──────────────────────────────────────────────────────────────────────

describe("parseInboundMessage META normalizes the Cloud-API webhook envelope", () => {
  it("parses a text message with phone, body, providerMessageId and sentAt", () => {
    const out = parseInboundMessage("META", {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "919876500001",
                    id: "wamid.text1",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hi there" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.phone).toBe("+919876500001");
    expect(out!.body).toBe("hi there");
    expect(out!.providerMessageId).toBe("wamid.text1");
    expect(out!.sentAt.getTime()).toBe(1700000000 * 1000);
  });

  it("parses an image message with mediaUrl from image.link", () => {
    const out = parseInboundMessage("META", {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "919876500001",
                    id: "wamid.img1",
                    timestamp: "1700000000",
                    image: { link: "https://x/img.jpg", caption: "see" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(out!.mediaUrl).toBe("https://x/img.jpg");
    expect(out!.body).toBe("see");
  });

  it("returns null on a status-update payload (no messages)", () => {
    expect(
      parseInboundMessage("META", {
        entry: [{ changes: [{ value: { statuses: [{}] } }] }],
      }),
    ).toBeNull();
  });
});

describe("parseInboundMessage GUPSHUP normalizes the message envelope", () => {
  it("parses a text payload via payload.payload.text", () => {
    const out = parseInboundMessage("GUPSHUP", {
      type: "message",
      payload: {
        id: "gs-msg-1",
        source: "919876500001",
        type: "text",
        payload: { text: "yo" },
        timestamp: 1700000000000,
      },
    });
    expect(out).not.toBeNull();
    expect(out!.phone).toBe("+919876500001");
    expect(out!.body).toBe("yo");
    expect(out!.providerMessageId).toBe("gs-msg-1");
  });

  it("parses an image payload with caption + url", () => {
    const out = parseInboundMessage("GUPSHUP", {
      type: "message",
      payload: {
        id: "gs-img-1",
        source: "919876500001",
        type: "image",
        payload: { url: "https://x/i.jpg", caption: "look" },
      },
    });
    expect(out!.mediaUrl).toBe("https://x/i.jpg");
    expect(out!.body).toBe("look");
  });

  it("returns null on a delivery receipt (type=message-event)", () => {
    expect(
      parseInboundMessage("GUPSHUP", { type: "message-event", payload: {} }),
    ).toBeNull();
  });
});

describe("parseInboundMessage WATI normalizes the eventType=message envelope", () => {
  it("parses a text message", () => {
    const out = parseInboundMessage("WATI", {
      eventType: "message",
      waId: "919876500001",
      text: "hello wati",
      id: "wati-1",
      timestamp: 1700000000000,
    });
    expect(out!.phone).toBe("+919876500001");
    expect(out!.body).toBe("hello wati");
    expect(out!.providerMessageId).toBe("wati-1");
  });

  it("returns null on a non-message event", () => {
    expect(
      parseInboundMessage("WATI", { eventType: "status", waId: "x" }),
    ).toBeNull();
  });
});

describe("parseInboundMessage AISENSEI normalizes the incoming_message envelope", () => {
  it("parses a text + media payload from data.*", () => {
    const out = parseInboundMessage("AISENSEI", {
      event: "incoming_message",
      data: {
        from: "919876500001",
        text: "hi ai",
        message_id: "ai-1",
        timestamp: 1700000000000,
        media_url: "https://x/m.jpg",
      },
    });
    expect(out!.phone).toBe("+919876500001");
    expect(out!.body).toBe("hi ai");
    expect(out!.mediaUrl).toBe("https://x/m.jpg");
    expect(out!.providerMessageId).toBe("ai-1");
  });

  it("returns null on a non incoming_message event", () => {
    expect(
      parseInboundMessage("AISENSEI", { event: "delivered", data: {} }),
    ).toBeNull();
  });
});

describe("parseInboundMessage INTERAKT normalizes the message_received envelope", () => {
  it("parses customer.phone_number + message.message", () => {
    const out = parseInboundMessage("INTERAKT", {
      type: "message_received",
      data: {
        customer: { phone_number: "919876500001" },
        message: {
          message: "hi ik",
          id: "ik-1",
          timestamp: 1700000000000,
          media: { url: "https://x/v.mp4" },
        },
      },
    });
    expect(out!.phone).toBe("+919876500001");
    expect(out!.body).toBe("hi ik");
    expect(out!.mediaUrl).toBe("https://x/v.mp4");
  });

  it("returns null on a non message_received event", () => {
    expect(
      parseInboundMessage("INTERAKT", { type: "status", data: {} }),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// verifyInboundSignature — HMAC-good + tampered + missing per provider.
// ──────────────────────────────────────────────────────────────────────

describe("verifyInboundSignature META validates X-Hub-Signature-256 HMAC-SHA256", () => {
  const appSecret = "meta-app-secret";
  const body = Buffer.from(JSON.stringify({ entry: [{}] }));

  it("accepts a correctly signed body", () => {
    const sig =
      "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
    expect(
      verifyInboundSignature("META", body, { "x-hub-signature-256": sig }, {
        appSecret,
      }),
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const sig =
      "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
    const bad = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(
      verifyInboundSignature("META", body, { "x-hub-signature-256": bad }, {
        appSecret,
      }),
    ).toBe(false);
  });

  it("rejects when the header is missing", () => {
    expect(
      verifyInboundSignature("META", body, {}, { appSecret }),
    ).toBe(false);
  });

  it("rejects when the appSecret is missing from config", () => {
    expect(
      verifyInboundSignature("META", body, { "x-hub-signature-256": "x" }, {}),
    ).toBe(false);
  });

  it("rejects a malformed sha256 header", () => {
    expect(
      verifyInboundSignature(
        "META",
        body,
        { "x-hub-signature-256": "md5=zzz" },
        { appSecret },
      ),
    ).toBe(false);
  });
});

describe("verifyInboundSignature GUPSHUP validates x-gs-signature OR static apikey", () => {
  const apiKey = "gupshup-key";
  const body = Buffer.from(JSON.stringify({ type: "message" }));

  it("accepts a correctly HMAC-signed body via x-gs-signature", () => {
    const sig = createHmac("sha256", apiKey).update(body).digest("hex");
    expect(
      verifyInboundSignature("GUPSHUP", body, { "x-gs-signature": sig }, {
        apiKey,
      }),
    ).toBe(true);
  });

  it("accepts a static apikey header that matches config.apiKey", () => {
    expect(
      verifyInboundSignature("GUPSHUP", body, { apikey: apiKey }, { apiKey }),
    ).toBe(true);
  });

  it("rejects a wrong static apikey header", () => {
    expect(
      verifyInboundSignature(
        "GUPSHUP",
        body,
        { apikey: "wrong-and-different-length" },
        { apiKey },
      ),
    ).toBe(false);
  });

  it("rejects when both headers are missing", () => {
    expect(verifyInboundSignature("GUPSHUP", body, {}, { apiKey })).toBe(false);
  });

  it("rejects when config.apiKey missing", () => {
    expect(
      verifyInboundSignature("GUPSHUP", body, { apikey: "x" }, {}),
    ).toBe(false);
  });
});

describe("verifyInboundSignature WATI validates Authorization: Bearer <bearerToken>", () => {
  const bearerToken = "wati-bearer-xyz";
  const body = Buffer.from("{}");

  it("accepts a matching Bearer header", () => {
    expect(
      verifyInboundSignature(
        "WATI",
        body,
        { authorization: `Bearer ${bearerToken}` },
        { bearerToken },
      ),
    ).toBe(true);
  });

  it("rejects a wrong Bearer token", () => {
    expect(
      verifyInboundSignature(
        "WATI",
        body,
        { authorization: "Bearer wrong-token-but-same-len-xyz" },
        { bearerToken },
      ),
    ).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(
      verifyInboundSignature(
        "WATI",
        body,
        { authorization: `Basic ${bearerToken}` },
        { bearerToken },
      ),
    ).toBe(false);
  });

  it("rejects when authorization header missing", () => {
    expect(
      verifyInboundSignature("WATI", body, {}, { bearerToken }),
    ).toBe(false);
  });

  it("rejects when config.bearerToken missing", () => {
    expect(
      verifyInboundSignature(
        "WATI",
        body,
        { authorization: "Bearer x" },
        {},
      ),
    ).toBe(false);
  });
});

describe("verifyInboundSignature AISENSEI + INTERAKT respect WHATSAPP_WEBHOOK_STRICT", () => {
  const body = Buffer.from("{}");
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.WHATSAPP_WEBHOOK_STRICT;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.WHATSAPP_WEBHOOK_STRICT;
    else process.env.WHATSAPP_WEBHOOK_STRICT = prev;
  });

  it("returns true for AISENSEI in non-strict mode (default test env)", () => {
    delete process.env.WHATSAPP_WEBHOOK_STRICT;
    expect(verifyInboundSignature("AISENSEI", body, {}, {})).toBe(true);
  });

  it("returns false for AISENSEI when strict is enabled", () => {
    process.env.WHATSAPP_WEBHOOK_STRICT = "true";
    expect(verifyInboundSignature("AISENSEI", body, {}, {})).toBe(false);
  });

  it("returns true for INTERAKT in non-strict mode", () => {
    delete process.env.WHATSAPP_WEBHOOK_STRICT;
    expect(verifyInboundSignature("INTERAKT", body, {}, {})).toBe(true);
  });

  it("returns false for INTERAKT when strict is enabled", () => {
    process.env.WHATSAPP_WEBHOOK_STRICT = "true";
    expect(verifyInboundSignature("INTERAKT", body, {}, {})).toBe(false);
  });

  it("returns false for an unknown provider regardless of strict mode", () => {
    expect(
      verifyInboundSignature(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "UNKNOWN" as any,
        body,
        {},
        {},
      ),
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractDestinationPhone — one happy per provider, exercises the switch.
// ──────────────────────────────────────────────────────────────────────

describe("extractDestinationPhone pulls the tenant-facing number from each envelope", () => {
  it("META prefers metadata.display_phone_number canonicalised", () => {
    expect(
      extractDestinationPhone("META", {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: {
                    display_phone_number: "919811111111",
                    phone_number_id: "1234567890",
                  },
                },
              },
            ],
          },
        ],
      }),
    ).toBe("+919811111111");
  });

  it("META falls back to phone_number_id when display_phone_number missing", () => {
    expect(
      extractDestinationPhone("META", {
        entry: [
          {
            changes: [
              {
                value: { metadata: { phone_number_id: "1234567890" } },
              },
            ],
          },
        ],
      }),
    ).toBe("1234567890");
  });

  it("GUPSHUP pulls payload.destination", () => {
    expect(
      extractDestinationPhone("GUPSHUP", {
        payload: { destination: "919811111111" },
      }),
    ).toBe("+919811111111");
  });

  it("WATI pulls top-level to", () => {
    expect(extractDestinationPhone("WATI", { to: "919811111111" })).toBe(
      "+919811111111",
    );
  });

  it("AISENSEI pulls data.to", () => {
    expect(
      extractDestinationPhone("AISENSEI", { data: { to: "919811111111" } }),
    ).toBe("+919811111111");
  });

  it("INTERAKT pulls data.tenant.phone_number", () => {
    expect(
      extractDestinationPhone("INTERAKT", {
        data: { tenant: { phone_number: "919811111111" } },
      }),
    ).toBe("+919811111111");
  });

  it("returns null for an unknown provider", () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractDestinationPhone("UNKNOWN" as any, {}),
    ).toBeNull();
  });
});
