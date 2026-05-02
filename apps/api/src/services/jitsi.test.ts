/**
 * Unit tests for the Jitsi integration helpers. Three functions, all pure
 * (env-var driven). We cover:
 *   - URL building: domain default vs override, room derivation from sessionId,
 *     URL-encoding of weird room names.
 *   - JWT generation: env-var gating (returns "" when not configured),
 *     standard claim shape, role-driven moderator + recording flags,
 *     custom JITSI_DOMAIN propagation, expiry window.
 *   - Convenience wrapper: signedJitsiRoomUrl returns the url+room+jwt
 *     triple consistent with the lower-level helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateJitsiJWT,
  buildJitsiRoomUrl,
  signedJitsiRoomUrl,
} from "./jitsi";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.JITSI_APP_ID;
  delete process.env.JITSI_APP_SECRET;
  delete process.env.JITSI_DOMAIN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildJitsiRoomUrl", () => {
  it("uses meet.jit.si as the default domain", () => {
    expect(buildJitsiRoomUrl("sess-1")).toBe("https://meet.jit.si/medcore-sess-1");
  });

  it("respects a custom JITSI_DOMAIN", () => {
    process.env.JITSI_DOMAIN = "my.jitsi.example.com";
    expect(buildJitsiRoomUrl("sess-1")).toBe(
      "https://my.jitsi.example.com/medcore-sess-1",
    );
  });

  it("appends ?jwt=<token> when a token is supplied", () => {
    const url = buildJitsiRoomUrl("sess-1", { jwt: "abc.def.ghi" });
    expect(url).toBe("https://meet.jit.si/medcore-sess-1?jwt=abc.def.ghi");
  });

  it("uses an explicit room override when provided", () => {
    expect(buildJitsiRoomUrl("sess-1", { room: "custom-room" })).toBe(
      "https://meet.jit.si/custom-room",
    );
  });

  it("URL-encodes room names with spaces / unicode", () => {
    expect(buildJitsiRoomUrl("sess-1", { room: "patient consult #1" })).toBe(
      "https://meet.jit.si/patient%20consult%20%231",
    );
  });
});

describe("generateJitsiJWT — env gating", () => {
  it("returns empty string when JITSI_APP_ID is missing", () => {
    process.env.JITSI_APP_SECRET = "secret";
    expect(
      generateJitsiJWT("room", { id: "u", name: "U" }, "moderator"),
    ).toBe("");
  });

  it("returns empty string when JITSI_APP_SECRET is missing", () => {
    process.env.JITSI_APP_ID = "app";
    expect(
      generateJitsiJWT("room", { id: "u", name: "U" }, "moderator"),
    ).toBe("");
  });

  it("returns empty string when neither is set (dev/local default)", () => {
    expect(
      generateJitsiJWT("room", { id: "u", name: "U" }, "moderator"),
    ).toBe("");
  });
});

describe("generateJitsiJWT — claim shape", () => {
  beforeEach(() => {
    process.env.JITSI_APP_ID = "test-app";
    process.env.JITSI_APP_SECRET = "test-secret";
  });

  it("emits the standard Jitsi claim shape", () => {
    const token = generateJitsiJWT(
      "medcore-sess-1",
      { id: "u-1", name: "Alice", email: "a@b.c", avatar: "https://a/x.png" },
      "moderator",
    );
    expect(token).not.toBe("");
    const decoded = jwt.verify(token, "test-secret") as Record<string, any>;
    expect(decoded.aud).toBe("jitsi");
    expect(decoded.iss).toBe("test-app");
    expect(decoded.sub).toBe("meet.jit.si");
    expect(decoded.room).toBe("medcore-sess-1");
    expect(decoded.context.user).toMatchObject({
      id: "u-1",
      name: "Alice",
      email: "a@b.c",
      avatar: "https://a/x.png",
      moderator: "true",
    });
  });

  it("flips moderator + recording flags off for participant role", () => {
    const token = generateJitsiJWT("r", { id: "u", name: "U" }, "participant");
    const decoded = jwt.verify(token, "test-secret") as Record<string, any>;
    expect(decoded.context.user.moderator).toBe("false");
    expect(decoded.context.features.recording).toBe("false");
  });

  it("turns recording on for moderator", () => {
    const token = generateJitsiJWT("r", { id: "u", name: "U" }, "moderator");
    const decoded = jwt.verify(token, "test-secret") as Record<string, any>;
    expect(decoded.context.features.recording).toBe("true");
  });

  it("uses JITSI_DOMAIN for the sub claim when set", () => {
    process.env.JITSI_DOMAIN = "self-hosted.example.com";
    const token = generateJitsiJWT("r", { id: "u", name: "U" }, "moderator");
    const decoded = jwt.verify(token, "test-secret") as Record<string, any>;
    expect(decoded.sub).toBe("self-hosted.example.com");
  });

  it("expires 4 hours after issue", () => {
    const token = generateJitsiJWT("r", { id: "u", name: "U" }, "moderator");
    const decoded = jwt.verify(token, "test-secret") as Record<string, any>;
    expect(decoded.exp - decoded.iat).toBe(4 * 60 * 60);
  });

  it("defaults email and avatar to empty string when caller omits them", () => {
    const token = generateJitsiJWT("r", { id: "u", name: "U" }, "moderator");
    const decoded = jwt.verify(token, "test-secret") as Record<string, any>;
    expect(decoded.context.user.email).toBe("");
    expect(decoded.context.user.avatar).toBe("");
  });

  it("rejects forged tokens signed with a different secret", () => {
    const token = generateJitsiJWT("r", { id: "u", name: "U" }, "moderator");
    expect(() => jwt.verify(token, "wrong-secret")).toThrow();
  });
});

describe("signedJitsiRoomUrl", () => {
  it("returns url+room+jwt with the bare URL when JWT generation is gated off", () => {
    const out = signedJitsiRoomUrl(
      "sess-1",
      { id: "u", name: "U" },
      "moderator",
    );
    expect(out.room).toBe("medcore-sess-1");
    expect(out.jwt).toBe("");
    expect(out.url).toBe("https://meet.jit.si/medcore-sess-1");
  });

  it("appends the signed JWT to the URL when configured", () => {
    process.env.JITSI_APP_ID = "test-app";
    process.env.JITSI_APP_SECRET = "test-secret";
    const out = signedJitsiRoomUrl(
      "sess-1",
      { id: "u", name: "U" },
      "moderator",
    );
    expect(out.jwt).not.toBe("");
    expect(out.url.startsWith("https://meet.jit.si/medcore-sess-1?jwt=")).toBe(true);
  });

  it("honours the room override end-to-end (URL + JWT use the same name)", () => {
    process.env.JITSI_APP_ID = "test-app";
    process.env.JITSI_APP_SECRET = "test-secret";
    const out = signedJitsiRoomUrl(
      "sess-1",
      { id: "u", name: "U" },
      "moderator",
      "private-consult",
    );
    expect(out.room).toBe("private-consult");
    expect(out.url.startsWith("https://meet.jit.si/private-consult?jwt=")).toBe(true);
    const decoded = jwt.verify(out.jwt, "test-secret") as Record<string, any>;
    expect(decoded.room).toBe("private-consult");
  });
});
