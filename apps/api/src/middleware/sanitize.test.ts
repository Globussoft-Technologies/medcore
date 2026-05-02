/**
 * Unit tests for the body-sanitization middleware. Stripping HTML at the edge
 * is one of the cheap-but-broad XSS defences we have, so we cover the
 * recursive cases (objects, arrays, deep nesting) and the no-op cases (null,
 * non-object body, primitives).
 */

import { describe, it, expect, vi } from "vitest";
import { sanitize } from "./sanitize";

function run(body: unknown) {
  const req: any = { body };
  const next = vi.fn();
  sanitize(req, {} as any, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req.body;
}

describe("sanitize — string handling", () => {
  it("strips simple <script> tags", () => {
    const out = run({ comment: "Hello <script>alert(1)</script> world" });
    expect(out).toEqual({ comment: "Hello alert(1) world" });
  });

  it("strips paired and self-closing tags", () => {
    const out = run({ html: "a<br/>b<hr>c<i>d</i>" });
    expect(out).toEqual({ html: "abcd" });
  });

  it("strips tags with attributes", () => {
    const out = run({
      html: '<a href="javascript:evil()" onclick="x()">link</a>',
    });
    expect(out).toEqual({ html: "link" });
  });

  it("leaves plain strings untouched", () => {
    const out = run({ name: "Alice O'Hara" });
    expect(out).toEqual({ name: "Alice O'Hara" });
  });

  it("leaves emojis and unicode untouched", () => {
    const out = run({ note: "Vitals stable 🩺 — patient OK" });
    expect(out).toEqual({ note: "Vitals stable 🩺 — patient OK" });
  });
});

describe("sanitize — recursive structures", () => {
  it("recurses into nested objects", () => {
    const out = run({
      user: { name: "<b>Alice</b>", profile: { bio: "<i>hi</i>" } },
    });
    expect(out).toEqual({
      user: { name: "Alice", profile: { bio: "hi" } },
    });
  });

  it("recurses into arrays of strings", () => {
    const out = run({ tags: ["<b>a</b>", "b", "<i>c</i>"] });
    expect(out).toEqual({ tags: ["a", "b", "c"] });
  });

  it("recurses into arrays of objects", () => {
    const out = run({
      contacts: [
        { name: "<b>A</b>", email: "a@x.com" },
        { name: "<i>B</i>", email: "b@x.com" },
      ],
    });
    expect(out).toEqual({
      contacts: [
        { name: "A", email: "a@x.com" },
        { name: "B", email: "b@x.com" },
      ],
    });
  });
});

describe("sanitize — non-string passthrough", () => {
  it("preserves numbers, booleans, null inside objects", () => {
    const out = run({ age: 42, isActive: true, nickname: null });
    expect(out).toEqual({ age: 42, isActive: true, nickname: null });
  });

  it("does nothing when req.body is null", () => {
    const out = run(null);
    expect(out).toBeNull();
  });

  it("does nothing when req.body is undefined", () => {
    const out = run(undefined);
    expect(out).toBeUndefined();
  });

  it("does nothing when req.body is a primitive (string)", () => {
    // The middleware's `typeof === 'object'` guard means raw bodies
    // passed as strings (e.g. text/plain) are NOT walked. We deliberately
    // assert this so the boundary is documented.
    const out = run("<b>not walked</b>");
    expect(out).toBe("<b>not walked</b>");
  });

  it("does nothing when req.body is a primitive (number)", () => {
    const out = run(42);
    expect(out).toBe(42);
  });
});

describe("sanitize — middleware contract", () => {
  it("always calls next() exactly once even on empty body", () => {
    const req: any = { body: {} };
    const next = vi.fn();
    sanitize(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not touch other request fields", () => {
    const req: any = {
      body: { x: "<b>1</b>" },
      headers: { foo: "<b>untouched</b>" },
      query: { q: "<i>untouched</i>" },
    };
    const next = vi.fn();
    sanitize(req, {} as any, next);
    expect(req.body).toEqual({ x: "1" });
    // Headers/query stay literal — the middleware is body-only.
    expect(req.headers).toEqual({ foo: "<b>untouched</b>" });
    expect(req.query).toEqual({ q: "<i>untouched</i>" });
  });
});
