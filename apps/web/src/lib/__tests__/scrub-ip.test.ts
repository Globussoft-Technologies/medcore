// Issue #534 — Admin Console must not surface RFC1918 / loopback IPs
// from the audit-log error breakdown. These tests pin the redaction
// boundaries so a future refactor doesn't accidentally leak internal
// network topology, and so that we don't OVER-redact public IPs (which
// would defeat the bot-detection use case the breakdown table was
// designed for).
import { describe, it, expect } from "vitest";
import { scrubInternalIp } from "../scrub-ip";

describe("scrubInternalIp — Issue #534", () => {
  it("redacts RFC1918 Class A (10.0.0.0/8)", () => {
    expect(scrubInternalIp("10.0.0.1")).toBe("[redacted internal]");
    expect(scrubInternalIp("10.42.7.13")).toBe("[redacted internal]");
    expect(scrubInternalIp("10.255.255.254")).toBe("[redacted internal]");
  });

  it("redacts RFC1918 Class B (172.16.0.0/12)", () => {
    expect(scrubInternalIp("172.16.0.1")).toBe("[redacted internal]");
    expect(scrubInternalIp("172.20.5.10")).toBe("[redacted internal]");
    expect(scrubInternalIp("172.31.255.254")).toBe("[redacted internal]");
  });

  it("redacts RFC1918 Class C (192.168.0.0/16)", () => {
    expect(scrubInternalIp("192.168.0.1")).toBe("[redacted internal]");
    expect(scrubInternalIp("192.168.4.5")).toBe("[redacted internal]");
    expect(scrubInternalIp("192.168.255.254")).toBe("[redacted internal]");
  });

  it("redacts loopback (127.0.0.0/8)", () => {
    expect(scrubInternalIp("127.0.0.1")).toBe("[redacted internal]");
    expect(scrubInternalIp("127.255.255.1")).toBe("[redacted internal]");
  });

  it("redacts IPv6 loopback and unique-local (fc00::/7)", () => {
    expect(scrubInternalIp("::1")).toBe("[redacted internal]");
    expect(scrubInternalIp("fc00::1")).toBe("[redacted internal]");
    expect(scrubInternalIp("fd12:3456:789a::1")).toBe("[redacted internal]");
  });

  it("does NOT redact 172.x outside the /12 boundary (e.g. 172.15 / 172.32)", () => {
    // 172.15.0.0 is OUTSIDE 172.16.0.0/12 — public space. 172.32.0.0
    // similarly. We must not over-redact, otherwise legitimate public
    // bot-source IPs would all show as `[redacted internal]` and ops
    // couldn't tell them apart from internal traffic.
    expect(scrubInternalIp("172.15.5.10")).toBe("172.15.5.10");
    expect(scrubInternalIp("172.32.5.10")).toBe("172.32.5.10");
  });

  it("passes public IPs through unchanged", () => {
    expect(scrubInternalIp("8.8.8.8")).toBe("8.8.8.8");
    expect(scrubInternalIp("1.1.1.1")).toBe("1.1.1.1");
    expect(scrubInternalIp("203.0.113.42")).toBe("203.0.113.42");
  });

  it("handles missing / sentinel values without crashing", () => {
    expect(scrubInternalIp(null)).toBe("");
    expect(scrubInternalIp(undefined)).toBe("");
    expect(scrubInternalIp("")).toBe("");
    expect(scrubInternalIp("(unknown)")).toBe("(unknown)");
  });

  it("redacts an IPv4-mapped-IPv6 form of a private IP", () => {
    expect(scrubInternalIp("::ffff:10.0.0.1")).toBe("[redacted internal]");
    expect(scrubInternalIp("::ffff:192.168.1.1")).toBe("[redacted internal]");
  });
});
