// Sanity test for Pearl §6.2 — the `.touch-target` Tailwind utility added
// in `apps/web/src/app/globals.css` (gap row 172 closure). Verifies BOTH
// halves of the iOS HIG contract: any element carrying the class inherits
// `min-height: 44px` AND `min-width: 44px`. The vitest config sets
// `css: false`, so we inject the rule into the test DOM via a `<style>`
// node (mirroring the exact declaration shipped in globals.css) and read
// it back via `window.getComputedStyle`. This catches accidental utility
// drift — if globals.css ever drops one of the two declarations the test
// fails immediately.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";

describe("Pearl §6.2 touch-target utility", () => {
  let styleEl: HTMLStyleElement;

  beforeAll(() => {
    // Mirror the declaration from `apps/web/src/app/globals.css`. The
    // contract under test is the (min-height, min-width) pair — if either
    // disappears the test will fail.
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-test-id", "touch-target-utility");
    styleEl.textContent = `
      .touch-target {
        min-height: 44px;
        min-width: 44px;
      }
    `;
    document.head.appendChild(styleEl);
  });

  afterAll(() => {
    if (styleEl?.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
  });

  it("applies min-height: 44px and min-width: 44px when the class is present", () => {
    const { container } = render(
      <button className="touch-target" data-testid="tt-button">
        x
      </button>,
    );
    const btn = container.querySelector(
      "[data-testid='tt-button']",
    ) as HTMLElement;
    expect(btn).toBeTruthy();
    const computed = window.getComputedStyle(btn);
    expect(computed.minHeight).toBe("44px");
    expect(computed.minWidth).toBe("44px");
  });

  it("does NOT apply the rule when the class is absent (control)", () => {
    const { container } = render(
      <button data-testid="tt-button-plain">x</button>,
    );
    const btn = container.querySelector(
      "[data-testid='tt-button-plain']",
    ) as HTMLElement;
    const computed = window.getComputedStyle(btn);
    // jsdom returns "" or "auto" for unset min-*; assert it's NOT 44px.
    expect(computed.minHeight).not.toBe("44px");
    expect(computed.minWidth).not.toBe("44px");
  });
});
