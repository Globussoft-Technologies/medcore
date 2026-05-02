/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(() => {
    // Match Next.js: redirect() throws to short-circuit the render.
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

import AccountPage from "../account/page";

describe("AccountPage (alias for /dashboard/profile)", () => {
  it("calls next/navigation `redirect` to /dashboard/profile on render", () => {
    expect(() => AccountPage()).toThrow(/NEXT_REDIRECT/);
    expect(redirectMock).toHaveBeenCalledWith("/dashboard/profile");
  });

  it("invokes the redirect exactly once per render", () => {
    redirectMock.mockClear();
    expect(() => AccountPage()).toThrow();
    expect(redirectMock).toHaveBeenCalledTimes(1);
  });

  it("does not return any UI (the redirect throws first)", () => {
    redirectMock.mockClear();
    let returned: unknown = "sentinel";
    try {
      returned = AccountPage();
    } catch {
      // expected
    }
    // We never get past the redirect, so `returned` stays the sentinel.
    expect(returned).toBe("sentinel");
  });
});
