import { describe, it, expect } from "vitest";
import { signParts, signUrl, verifySignature } from "./signed-url";

describe("signed-url helper", () => {
  it("signUrl returns expires and sig params", () => {
    const qs = signUrl("doc:1", 60);
    expect(qs).toMatch(/^expires=\d+&sig=[a-f0-9]+$/);
  });

  it("verify accepts a freshly-signed token", () => {
    const parts = signParts("doc:abc", 60);
    expect(verifySignature("doc:abc", parts.expires, parts.sig)).toBe(true);
  });

  it("verify rejects an empty/garbage signature", () => {
    expect(verifySignature("doc:abc", 9999999999, "")).toBe(false);
    expect(verifySignature("doc:abc", 9999999999, "not-hex")).toBe(false);
  });

  it("verify rejects a different path with the same sig", () => {
    const parts = signParts("doc:abc", 60);
    expect(verifySignature("doc:def", parts.expires, parts.sig)).toBe(false);
  });

  it("verify rejects an expired token", () => {
    const parts = signParts("doc:abc", 1);
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(verifySignature("doc:abc", past, parts.sig)).toBe(false);
  });

  it("verify rejects a non-numeric expires", () => {
    const parts = signParts("doc:abc", 60);
    expect(verifySignature("doc:abc", "abc" as any, parts.sig)).toBe(false);
  });
});
