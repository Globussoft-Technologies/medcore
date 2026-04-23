import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAccessToken,
  ABDMConfigError,
  ABDMError,
  _resetTokenCache,
  _peekCache,
  abdmRequest,
} from "./client";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetTokenCache();
  process.env.ABDM_CLIENT_ID = "test-client-id";
  process.env.ABDM_CLIENT_SECRET = "test-client-secret";
  process.env.ABDM_BASE_URL = "https://dev.abdm.gov.in";
  process.env.ABDM_GATEWAY_URL = "https://dev.abdm.gov.in/gateway";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  _resetTokenCache();
});

describe("getAccessToken — config validation", () => {
  it("throws ABDMConfigError when ABDM_CLIENT_ID is missing", async () => {
    delete process.env.ABDM_CLIENT_ID;
    await expect(getAccessToken()).rejects.toBeInstanceOf(ABDMConfigError);
  });

  it("throws ABDMConfigError when ABDM_CLIENT_SECRET is missing", async () => {
    delete process.env.ABDM_CLIENT_SECRET;
    await expect(getAccessToken()).rejects.toBeInstanceOf(ABDMConfigError);
  });
});

describe("getAccessToken — token caching", () => {
  it("fetches a token on first call and caches it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accessToken: "token-abc", expiresIn: 1800 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const t1 = await getAccessToken();
    expect(t1).toBe("token-abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call should hit cache, not network.
    const t2 = await getAccessToken();
    expect(t2).toBe("token-abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const cache = _peekCache();
    expect(cache?.token).toBe("token-abc");
    expect(cache?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("re-fetches after cache is reset", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      return new Response(
        JSON.stringify({ accessToken: `token-${callCount}`, expiresIn: 1800 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const t1 = await getAccessToken();
    _resetTokenCache();
    const t2 = await getAccessToken();

    expect(t1).toBe("token-1");
    expect(t2).toBe("token-2");
  });

  it("throws ABDMError when the gateway responds non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    await expect(getAccessToken()).rejects.toBeInstanceOf(ABDMError);
  });

  it("throws ABDMError when the response lacks accessToken", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ foo: "bar" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(getAccessToken()).rejects.toBeInstanceOf(ABDMError);
  });
});

describe("abdmRequest", () => {
  it("attaches Authorization header and parses JSON response", async () => {
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: any, init: any) => {
        calls.push(init);
        // First call = token, second = actual endpoint.
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({ accessToken: "tok-xyz", expiresIn: 1800 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ ok: true, echo: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    const res = await abdmRequest<{ ok: boolean; echo: string }>({
      method: "POST",
      path: "/v0.5/test",
      body: { ping: "pong" },
    });

    expect(res).toEqual({ ok: true, echo: "hello" });
    // The second call (the API call, not the token fetch) must carry Authorization.
    const apiInit = calls[1] as any;
    expect(apiInit.headers.Authorization).toBe("Bearer tok-xyz");
    expect(apiInit.headers["REQUEST-ID"]).toBeTruthy();
  });

  it("retries once on 401, refreshing the token", async () => {
    let apiCallCount = 0;
    let tokenCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/v0.5/sessions")) {
        tokenCallCount++;
        return new Response(
          JSON.stringify({ accessToken: `tok-${tokenCallCount}`, expiresIn: 1800 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      apiCallCount++;
      if (apiCallCount === 1) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await abdmRequest<{ ok: boolean }>({ path: "/v0.5/test" });
    expect(res).toEqual({ ok: true });
    expect(tokenCallCount).toBe(2); // initial + refresh after 401
    expect(apiCallCount).toBe(2);
  });

  it("throws ABDMError with upstream body on 4xx (non-401) failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/v0.5/sessions")) {
        return new Response(
          JSON.stringify({ accessToken: "tok-abc", expiresIn: 1800 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ code: "BAD_REQUEST", message: "nope" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(abdmRequest({ path: "/v0.5/bad" })).rejects.toMatchObject({
      name: "ABDMError",
      statusCode: 400,
      upstreamBody: { code: "BAD_REQUEST", message: "nope" },
    });
  });

  it("returns {} for 202 async responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/v0.5/sessions")) {
        return new Response(
          JSON.stringify({ accessToken: "tok-abc", expiresIn: 1800 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(null, { status: 202 });
    });

    const res = await abdmRequest<Record<string, never>>({ path: "/v0.5/async" });
    expect(res).toEqual({});
  });
});
