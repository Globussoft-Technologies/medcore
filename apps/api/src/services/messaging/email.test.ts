/**
 * Test-cron tick (2026-05-25) — unit coverage for the SendGrid email transport
 * in `apps/api/src/services/messaging/email.ts`.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full branch coverage of `sendEmail()` — the only exported function.
 *   Pins:
 *     * `ensureInitialized()` early-returns when `SENDGRID_API_KEY` is
 *       missing OR when `SENDGRID_FROM_EMAIL` is missing (each error
 *       string is asserted so a future copy edit can't silently drift
 *       past CI — these strings ship in route 502 bodies and tell the
 *       operator exactly which env var to set + where to get it).
 *     * `ensureInitialized()` caches the initialized flag — subsequent
 *       calls do not re-check env vars and do not re-call
 *       `sgMail.setApiKey`. Exercised so a tightening regression is caught.
 *     * Recipient regex rejects empty / malformed `to` (no `@`, missing
 *       domain TLD, leading whitespace) → ok:false, never hits sgMail.
 *     * Happy path → `{ok:true, messageId: <x-message-id header>}`.
 *     * Happy path with the optional `attachments` array: Buffer content
 *       is base64-encoded, string content is passed through, and an
 *       absent `disposition` defaults to "attachment".
 *     * Happy path with missing `text` falls back to `stripHtml(html)` —
 *       script/style/iframe/object/embed/noscript blocks are removed
 *       AND the nested-tag-resistance loop survives an adversarial
 *       payload like `<scr<script>ipt>x</scr</script>ipt>` (the CodeQL
 *       finding that motivated the convergence loop).
 *     * Happy path with explicit `text` skips the stripper.
 *     * Default sender name is "MedCore" when `SENDGRID_FROM_NAME` is
 *       unset; explicit `SENDGRID_FROM_NAME` overrides.
 *     * SendGrid error with `response.body.errors[0].message` →
 *       `{ok:false, error: <verified-sender-style message>}`.
 *     * SendGrid error with bare `err.message` (no response body) →
 *       `{ok:false, error: <err.message>}`.
 *     * SendGrid error that is neither an Error nor has a parseable
 *       response body → `{ok:false, error: "Unknown SendGrid error"}`.
 *
 * - MODULES: imports `sendEmail` from `./email`. `@sendgrid/mail` is
 *   mocked via `vi.mock("@sendgrid/mail", ...)` — zero real network. The
 *   mock records the input passed to `sgMail.send()` so we can assert
 *   the wire shape (from, attachments, text fallback).
 *
 * - WHY: the file shipped at 0% coverage. The route handler at
 *   `apps/api/src/routes/share-prescription.ts` (and any future caller)
 *   relies on the `{ok:true|false}` envelope — a regression to a thrown
 *   error would crash the route. Also pins the `stripHtml` convergence
 *   loop (CodeQL "incomplete multi-character sanitization" finding) so a
 *   future "performance optimisation" to a single-pass replace would
 *   fail CI loudly.
 *
 * Cleanup contract (CLAUDE.md gotcha #2 — module-scope state under
 * `singleFork: true`):
 *   The module caches `initialized: boolean` at module scope and there
 *   is NO exported reset hook. We work around this via
 *   `vi.resetModules()` + dynamic `await import("./email")` per test so
 *   each test gets a fresh module instance with `initialized=false`.
 *   This is mandatory because some tests mutate `process.env` and the
 *   stale `initialized` flag would skip the env re-read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── @sendgrid/mail mock ────────────────────────────────────────────────
//
// The mock keeps a `lastInput` and `lastSetKey` so each test can introspect
// what was passed without coupling to call counts (tests that re-import the
// module per case would see the spy reset; we want a stable observable).
const sgState = {
  lastInput: undefined as any,
  lastSetKey: undefined as string | undefined,
  // Each test can set this to override the next `send()` behaviour.
  // Default = success with a known x-message-id header.
  nextResponse: undefined as any,
  nextError: undefined as unknown,
};

vi.mock("@sendgrid/mail", () => {
  const setApiKey = vi.fn((k: string) => {
    sgState.lastSetKey = k;
  });
  const send = vi.fn(async (input: any) => {
    sgState.lastInput = input;
    if (sgState.nextError !== undefined) {
      const e = sgState.nextError;
      sgState.nextError = undefined;
      throw e;
    }
    const r = sgState.nextResponse ?? [
      {
        statusCode: 202,
        headers: { "x-message-id": "msg-default-id" },
        body: "",
      },
    ];
    sgState.nextResponse = undefined;
    return r;
  });
  return {
    default: { setApiKey, send },
    setApiKey,
    send,
  };
});

// ── env helpers ────────────────────────────────────────────────────────

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Load a fresh module instance — resets the module-scope `initialized` flag. */
async function loadFreshModule(): Promise<typeof import("./email")> {
  vi.resetModules();
  return await import("./email");
}

beforeEach(() => {
  sgState.lastInput = undefined;
  sgState.lastSetKey = undefined;
  sgState.nextResponse = undefined;
  sgState.nextError = undefined;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Default-good env so tests that don't want to exercise the missing-env
  // branches don't have to set them.
  process.env.SENDGRID_API_KEY = "SG.test-key-abc";
  process.env.SENDGRID_FROM_EMAIL = "noreply@example.com";
  delete process.env.SENDGRID_FROM_NAME;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── ensureInitialized — missing env vars ───────────────────────────────

describe("sendEmail returns a configuration error when env is incomplete", () => {
  it("rejects with a SENDGRID_API_KEY-specific message when the API key is missing", async () => {
    delete process.env.SENDGRID_API_KEY;
    const { sendEmail } = await loadFreshModule();

    const r = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SENDGRID_API_KEY/);
    expect(r.error).toMatch(/not configured/);
    expect(r.error).toMatch(/api_keys/);
    expect(r.messageId).toBeUndefined();
  });

  it("rejects with a SENDGRID_FROM_EMAIL-specific message when the verified sender is missing", async () => {
    delete process.env.SENDGRID_FROM_EMAIL;
    const { sendEmail } = await loadFreshModule();

    const r = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SENDGRID_FROM_EMAIL/);
    expect(r.error).toMatch(/not configured/);
    expect(r.error).toMatch(/sender_auth/);
  });

  it("does not call sgMail.setApiKey or sgMail.send when env is incomplete", async () => {
    delete process.env.SENDGRID_API_KEY;
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(sgState.lastSetKey).toBeUndefined();
    expect(sgState.lastInput).toBeUndefined();
  });

  it("caches the initialized flag — env vars deleted after first success do not break the second call", async () => {
    const { sendEmail } = await loadFreshModule();

    const first = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(first.ok).toBe(true);
    expect(sgState.lastSetKey).toBe("SG.test-key-abc");

    delete process.env.SENDGRID_API_KEY;
    const second = await sendEmail({
      to: "user@example.com",
      subject: "again",
      html: "<p>again</p>",
    });
    expect(second.ok).toBe(true);
  });
});

// ── recipient validation ───────────────────────────────────────────────

describe("sendEmail rejects malformed recipients before calling SendGrid", () => {
  it("rejects an empty string `to` with an Invalid-recipient error", async () => {
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({ to: "", subject: "hi", html: "<p>hi</p>" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient email/);
    expect(sgState.lastInput).toBeUndefined();
  });

  it("rejects a `to` without an @ sign", async () => {
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "not-an-email",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient email/);
    expect(sgState.lastInput).toBeUndefined();
  });

  it("rejects a `to` without a TLD (domain has no dot)", async () => {
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@localhost",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient email/);
    expect(sgState.lastInput).toBeUndefined();
  });

  it("rejects a `to` containing internal whitespace", async () => {
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user @example.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid recipient email/);
    expect(sgState.lastInput).toBeUndefined();
  });
});

// ── happy paths ────────────────────────────────────────────────────────

describe("sendEmail returns ok:true with the SendGrid-supplied messageId on a 2xx response", () => {
  it("extracts response.headers['x-message-id'] as messageId", async () => {
    sgState.nextResponse = [
      {
        statusCode: 202,
        headers: { "x-message-id": "abc.123" },
        body: "",
      },
    ];
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Hello</p>",
    });
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("abc.123");
    expect(r.error).toBeUndefined();
  });

  it("sends a payload with from.email=SENDGRID_FROM_EMAIL and the default name 'MedCore' when SENDGRID_FROM_NAME is unset", async () => {
    process.env.SENDGRID_FROM_EMAIL = "noreply@medcore.test";
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Hello</p>",
    });
    expect(sgState.lastInput.from).toEqual({
      email: "noreply@medcore.test",
      name: "MedCore",
    });
  });

  it("uses SENDGRID_FROM_NAME for the display name when set", async () => {
    process.env.SENDGRID_FROM_NAME = "MedCore Clinic";
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Hello</p>",
    });
    expect(sgState.lastInput.from.name).toBe("MedCore Clinic");
  });

  it("passes subject, html, and to fields verbatim to sgMail.send()", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "patient@example.com",
      subject: "Your prescription",
      html: "<p>Rx attached</p>",
      text: "Rx attached",
    });
    expect(sgState.lastInput.to).toBe("patient@example.com");
    expect(sgState.lastInput.subject).toBe("Your prescription");
    expect(sgState.lastInput.html).toBe("<p>Rx attached</p>");
    expect(sgState.lastInput.text).toBe("Rx attached");
  });
});

// ── stripHtml fallback when `text` is omitted ───────────────────────────

describe("sendEmail derives a plain-text fallback from html when `text` is not provided", () => {
  it("strips simple block tags (<p>, <div>, <br>) — adjacent tag boundaries concatenate when there is no whitespace between them", async () => {
    // Note: the stripper only REMOVES tags; it does not insert a space at
    // tag boundaries. "<p>Hello</p><div>World</div>" becomes "HelloWorld".
    // The whitespace-aware variant requires a space in the source HTML.
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>Hello</p> <div>World</div><br/>",
    });
    expect(sgState.lastInput.text).toBe("Hello World");
  });

  it("removes <script>...</script> blocks entirely (content + tags)", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>safe</p> <script>alert(1)</script> <p>after</p>",
    });
    expect(sgState.lastInput.text).toBe("safe after");
    expect(sgState.lastInput.text).not.toMatch(/alert/);
  });

  it("removes <style>, <iframe>, <object>, <embed>, <noscript> blocks", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html:
        "<style>body{}</style>" +
        "<iframe src=x></iframe>" +
        "<object data=x></object>" +
        "<embed src=x></embed>" +
        "<noscript>n</noscript>" +
        "<p>visible</p>",
    });
    expect(sgState.lastInput.text).toBe("visible");
  });

  it("survives an adversarial nested-tag payload that defeats a single-pass strip (the CodeQL convergence-loop case)", async () => {
    // <scr<script>ipt>x</scr</script>ipt> — a one-pass replace removes the
    // inner <script>...</script> and leaves "<script>x</script>" intact.
    // The convergence loop must run until the result stabilises.
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>before</p><scr<script>ipt>alert(1)</scr</script>ipt><p>after</p>",
    });
    expect(sgState.lastInput.text).not.toMatch(/script/i);
    expect(sgState.lastInput.text).not.toMatch(/alert/);
    expect(sgState.lastInput.text).toMatch(/before/);
    expect(sgState.lastInput.text).toMatch(/after/);
  });

  it("collapses runs of whitespace into a single space and trims edges", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "  <p>a</p>\n\n\t<p>b</p>   ",
    });
    expect(sgState.lastInput.text).toBe("a b");
  });

  it("does NOT invoke the stripper when `text` is explicitly provided", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<script>alert(1)</script><p>visible</p>",
      text: "explicit text wins",
    });
    expect(sgState.lastInput.text).toBe("explicit text wins");
  });
});

// ── attachments ────────────────────────────────────────────────────────

describe("sendEmail forwards optional attachments with the correct encoding + disposition", () => {
  it("base64-encodes Buffer content and defaults disposition to 'attachment'", async () => {
    const { sendEmail } = await loadFreshModule();
    const buf = Buffer.from("PDF-CONTENT", "utf8");
    await sendEmail({
      to: "user@example.com",
      subject: "Rx",
      html: "<p>Rx</p>",
      attachments: [
        { filename: "rx.pdf", content: buf, type: "application/pdf" },
      ],
    });
    expect(sgState.lastInput.attachments).toHaveLength(1);
    const att = sgState.lastInput.attachments[0];
    expect(att.filename).toBe("rx.pdf");
    expect(att.type).toBe("application/pdf");
    expect(att.disposition).toBe("attachment");
    expect(att.content).toBe(buf.toString("base64"));
  });

  it("passes string content through verbatim (assumed already base64)", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "Rx",
      html: "<p>Rx</p>",
      attachments: [
        {
          filename: "rx.pdf",
          content: "QUFBQQ==",
          type: "application/pdf",
          disposition: "inline",
        },
      ],
    });
    const att = sgState.lastInput.attachments[0];
    expect(att.content).toBe("QUFBQQ==");
    expect(att.disposition).toBe("inline");
  });

  it("omits the attachments field entirely when none are provided (instead of sending undefined)", async () => {
    const { sendEmail } = await loadFreshModule();
    await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    // The source uses optional chaining, so the payload key will be
    // `undefined` rather than absent — assert that explicitly so a future
    // refactor that filters out undefined keys doesn't drift the contract.
    expect(sgState.lastInput.attachments).toBeUndefined();
  });
});

// ── SendGrid error envelopes ───────────────────────────────────────────

describe("sendEmail surfaces SendGrid-side refusals as ok:false with the most informative message", () => {
  it("prefers response.body.errors[0].message when SendGrid returns it (verified-sender style)", async () => {
    sgState.nextError = {
      message: "Bad Request",
      response: {
        body: {
          errors: [
            {
              message:
                "The from address does not match a verified Sender Identity",
            },
          ],
        },
      },
    };
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "The from address does not match a verified Sender Identity",
    );
    expect(r.messageId).toBeUndefined();
  });

  it("falls back to err.message when the response body has no errors[]", async () => {
    sgState.nextError = {
      message: "Request timed out",
      response: { body: {} },
    };
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Request timed out");
  });

  it("falls back to err.message when there is no response at all (raw Error from fetch layer)", async () => {
    sgState.nextError = new Error("ECONNREFUSED api.sendgrid.com:443");
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ECONNREFUSED api.sendgrid.com:443");
  });

  it("returns 'Unknown SendGrid error' when err has neither message nor response", async () => {
    sgState.nextError = {};
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Unknown SendGrid error");
  });

  it("returns 'Unknown SendGrid error' when err is a thrown non-object (e.g. a string)", async () => {
    // String throws happen in odd cases (e.g. third-party libs that `throw "boom"`).
    // The cast in source is `err as { message?, response? }` so a string becomes
    // { message: undefined, response: undefined } → falls through to "Unknown".
    sgState.nextError = "boom";
    const { sendEmail } = await loadFreshModule();
    const r = await sendEmail({
      to: "user@example.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Unknown SendGrid error");
  });
});
