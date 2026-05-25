/**
 * Test-cron tick (2026-05-25) — unit coverage for the WhatsApp Cloud API
 * transport in `apps/api/src/services/messaging/whatsapp.ts`.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full branch coverage of `sendWhatsApp()` — the only exported
 *   function. Pins:
 *     * `ensureInitialized()` early-returns when `WHATSAPP_ACCESS_TOKEN`
 *       is missing OR when `WHATSAPP_PHONE_NUMBER_ID` is missing (each
 *       error string is asserted so a future copy edit can't silently
 *       drift past CI — these strings ship in route 502 bodies).
 *     * `normalisePhone()` — every internal branch via `to`:
 *         - empty string                → invalid-recipient error
 *         - whitespace/punct only       → invalid-recipient error
 *         - bare 10-digit Indian mobile → "+91…" prefix added
 *         - 11+ digit with country code → "+…" prepended
 *         - already-E.164 input         → digits kept, "+" preserved
 *         - sub-10-digit (e.g. 7-digit) → invalid-recipient error
 *     * Wire-contract pin: URL is `https://graph.facebook.com/v20.0/<id>/messages`,
 *       method POST, `Authorization: Bearer <token>`, `Content-Type:
 *       application/json`, body shape `{messaging_product:"whatsapp",
 *       to, type:"text", text:{preview_url:true, body}}`. Drift in any
 *       of these silently breaks delivery against Meta — assert per
 *       request.
 *     * Happy path → `{ok:true, messageId: <messages[0].id>}`.
 *     * Happy path with empty `messages[]` → `ok:true` but `messageId`
 *       is `undefined` (the optional-chain `body.messages?.[0]?.id`
 *       branch — exercised so a future tightening that requires a
 *       message id won't ship silently).
 *     * Non-2xx with `error.message` in body → `{ok:false, error: <body
 *       message>}` (e.g. "Recipient phone number not in allowed list").
 *     * Non-2xx WITHOUT `error.message` in body → falls back to
 *       `"WhatsApp Cloud API returned <status> <statusText>"`.
 *     * `res.json()` rejects (non-JSON body) → caught by `.catch(() => ({}))`,
 *       error path still surfaces a clean message.
 *     * `fetch` throws (DNS/TLS/network) → `{ok:false, error:
 *       "WhatsApp transport error: <msg>"}` for both `Error` instances
 *       and non-Error throws (the `String(err)` branch).
 *
 * - MODULES: imports `sendWhatsApp` directly. `fetch` is stubbed via
 *   `vi.stubGlobal` — zero real network calls (the per-test fetch stub
 *   also records the `(url, init)` tuple so we can assert the wire
 *   contract). No Prisma, no @medcore/db, no DB.
 *
 * - WHY: this file shipped at 0% coverage. The route handler at
 *   `apps/api/src/routes/share-prescription.ts` (and any future caller)
 *   relies on the `{ok:true|false}` envelope — a regression to a thrown
 *   error or a missing `error` field would crash the route handler.
 *   Also pins the wire contract (URL + headers + body) so any
 *   accidental Meta-API version bump or payload shape change fails CI
 *   loudly rather than silently breaking patient WhatsApp delivery.
 *
 * Cleanup contract (CLAUDE.md gotcha #2 — module-scope state under
 * `singleFork: true`):
 *   The module caches `initialized: boolean` at module scope and there
 *   is NO exported reset hook. We work around this via
 *   `vi.resetModules()` + dynamic `await import("./whatsapp")` per test
 *   so each test gets a fresh module instance with `initialized=false`.
 *   This is mandatory because some tests mutate `process.env` and the
 *   stale `initialized` flag would skip the env re-read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── env + fetch helpers ────────────────────────────────────────────────

const ENV_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];

function stubFetchOk(body: unknown, status = 200): void {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(json, {
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function stubFetchStatus(status: number, statusText: string, body: unknown): void {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(json, {
        status,
        statusText,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/** Returns a Response whose `.json()` throws — exercises the `.catch(() => ({}))` branch. */
function stubFetchNonJson(status: number, statusText: string, text: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      const res = new Response(text, {
        status,
        statusText,
        headers: { "content-type": "text/html" },
      });
      // Force .json() to throw — Response.text() body of "<html>" yields a
      // SyntaxError in the real Response, but be explicit to keep the test
      // deterministic across runtimes.
      (res as any).json = () => Promise.reject(new Error("not json"));
      return res;
    }),
  );
}

function stubFetchThrow(err: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw err;
    }),
  );
}

function lastFetch(): FetchCall {
  if (fetchCalls.length === 0) throw new Error("no fetch call was recorded");
  return fetchCalls[fetchCalls.length - 1];
}

/** Load a fresh module instance — resets the module-scope `initialized` flag. */
async function loadFreshModule(): Promise<typeof import("./whatsapp")> {
  vi.resetModules();
  return await import("./whatsapp");
}

beforeEach(() => {
  fetchCalls = [];
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Default-good env so tests that don't want to exercise the missing-env
  // branches don't have to set them.
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token-abc";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "111222333444555";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── ensureInitialized — missing env vars ────────────────────────────────

describe("sendWhatsApp returns a configuration error when env is incomplete", () => {
  it("rejects with a WHATSAPP_ACCESS_TOKEN-specific message when the access token is missing", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/WHATSAPP_ACCESS_TOKEN/);
    expect(r.error).toMatch(/not configured/);
    expect(r.messageId).toBeUndefined();
  });

  it("rejects with a WHATSAPP_PHONE_NUMBER_ID-specific message when the phone number id is missing", async () => {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/WHATSAPP_PHONE_NUMBER_ID/);
    expect(r.error).toMatch(/not configured/);
  });

  it("caches the initialized flag — a second successful call does not re-check env vars", async () => {
    // First call boots the module with both vars present; second call must
    // succeed even if the access token were deleted after the first call,
    // because `initialized` is true. Proves the cache hit branch of
    // `ensureInitialized`.
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.1" }] });

    const first = await sendWhatsApp({ to: "+919876543210", body: "first" });
    expect(first.ok).toBe(true);

    delete process.env.WHATSAPP_ACCESS_TOKEN;
    // Re-stub fetch since the second call still issues a request.
    stubFetchOk({ messages: [{ id: "wamid.2" }] });

    const second = await sendWhatsApp({ to: "+919876543210", body: "second" });
    expect(second.ok).toBe(true);
  });
});

// ── normalisePhone — every branch surfaced via the `to` arg ─────────────

describe("sendWhatsApp normalises the recipient phone number to E.164", () => {
  it("rejects an empty `to` with an invalid-recipient error and never hits the network", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "ignored" }] });

    const r = await sendWhatsApp({ to: "", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient phone number/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects a purely non-digit `to` (whitespace + punctuation) with an invalid-recipient error", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "ignored" }] });

    const r = await sendWhatsApp({ to: "  ---  ", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient phone number/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects a sub-10-digit number with an invalid-recipient error", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "ignored" }] });

    const r = await sendWhatsApp({ to: "12345", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient phone number/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("prepends +91 to a bare 10-digit Indian mobile", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.IN" }] });

    const r = await sendWhatsApp({ to: "9876543210", body: "hi" });
    expect(r.ok).toBe(true);
    const sent = JSON.parse(String(lastFetch().init.body));
    expect(sent.to).toBe("+919876543210");
  });

  it("preserves an already-E.164 number (digits-only inside, '+' restored on output)", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.E164" }] });

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(String(lastFetch().init.body)).to).toBe("+919876543210");
  });

  it("strips formatting from a '+91 98765-43210' style input and yields +919876543210", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.FMT" }] });

    const r = await sendWhatsApp({ to: "+91 98765-43210", body: "hi" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(String(lastFetch().init.body)).to).toBe("+919876543210");
  });

  it("prepends '+' to an 11+ digit raw number (e.g. US 1XXXXXXXXXX)", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.US" }] });

    const r = await sendWhatsApp({ to: "12025550100", body: "hi" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(String(lastFetch().init.body)).to).toBe("+12025550100");
  });
});

// ── Wire-contract pin (URL + headers + body) ────────────────────────────

describe("sendWhatsApp issues a Meta Cloud API v20.0 POST with the expected wire contract", () => {
  it("POSTs to https://graph.facebook.com/v20.0/<WHATSAPP_PHONE_NUMBER_ID>/messages", async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "987654321098765";
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.URL" }] });

    await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(lastFetch().url).toBe(
      "https://graph.facebook.com/v20.0/987654321098765/messages",
    );
    expect(lastFetch().init.method).toBe("POST");
  });

  it("sets Authorization: Bearer <WHATSAPP_ACCESS_TOKEN> and Content-Type: application/json", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "super-secret-token-xyz";
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.H" }] });

    await sendWhatsApp({ to: "+919876543210", body: "hi" });
    const headers = lastFetch().init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer super-secret-token-xyz");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends a {messaging_product, to, type:'text', text:{preview_url:true, body}} payload", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.B" }] });

    await sendWhatsApp({ to: "+919876543210", body: "Hello https://example.com" });
    const payload = JSON.parse(String(lastFetch().init.body));
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      to: "+919876543210",
      type: "text",
      text: { preview_url: true, body: "Hello https://example.com" },
    });
  });
});

// ── Success envelope ────────────────────────────────────────────────────

describe("sendWhatsApp returns ok:true with the Meta-supplied messageId on a 200 response", () => {
  it("extracts messages[0].id as messageId", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({ messages: [{ id: "wamid.HBgL919876543210ABC=" }] });

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("wamid.HBgL919876543210ABC=");
    expect(r.error).toBeUndefined();
  });

  it("returns ok:true with messageId=undefined when the response omits the messages array", async () => {
    const { sendWhatsApp } = await loadFreshModule();
    stubFetchOk({}); // Meta theoretically can return 200 with no messages

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(true);
    expect(r.messageId).toBeUndefined();
  });
});

// ── Non-2xx error branches ──────────────────────────────────────────────

describe("sendWhatsApp surfaces Meta-side refusals as ok:false with the most informative message", () => {
  it("prefers body.error.message when Meta returns it (e.g. 'Recipient phone number not in allowed list')", async () => {
    stubFetchStatus(400, "Bad Request", {
      error: {
        message: "Recipient phone number not in allowed list",
        code: 131030,
      },
    });
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Recipient phone number not in allowed list");
  });

  it("falls back to '<status> <statusText>' when body.error.message is absent", async () => {
    stubFetchStatus(500, "Internal Server Error", {});
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/WhatsApp Cloud API returned 500/);
    expect(r.error).toMatch(/Internal Server Error/);
  });

  it("falls back gracefully when the body is non-JSON (res.json() throws)", async () => {
    stubFetchNonJson(502, "Bad Gateway", "<html>upstream down</html>");
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    // body parses to {} so the message-fallback path engages.
    expect(r.error).toMatch(/WhatsApp Cloud API returned 502/);
  });

  it("surfaces an OAuth token rotation message verbatim (the canonical 401 case)", async () => {
    stubFetchStatus(401, "Unauthorized", {
      error: { message: "Invalid OAuth access token.", code: 190 },
    });
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid OAuth access token.");
  });
});

// ── Network-layer (catch) branches ──────────────────────────────────────

describe("sendWhatsApp catches network-layer failures and surfaces them as transport errors", () => {
  it("returns 'WhatsApp transport error: <err.message>' when fetch throws an Error", async () => {
    stubFetchThrow(new Error("ECONNREFUSED graph.facebook.com:443"));
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("WhatsApp transport error: ECONNREFUSED graph.facebook.com:443");
  });

  it("returns 'WhatsApp transport error: <String(err)>' when fetch throws a non-Error value", async () => {
    stubFetchThrow("boom-as-string");
    const { sendWhatsApp } = await loadFreshModule();

    const r = await sendWhatsApp({ to: "+919876543210", body: "hi" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("WhatsApp transport error: boom-as-string");
  });
});
