// Smoke tests for the Install-PWA affordance (Pearl §6.2 — gap row 168).
// Covers: hidden-when-no-event, hidden-when-standalone, render-and-click
// flow on `beforeinstallprompt`, iOS Safari instructions modal, and the
// 44px touch-target invariant. The native install dialog itself is not
// driven here (browser UI); we assert that `prompt()` was invoked and
// that the button hides after `userChoice` resolves to "accepted".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { InstallPWAButton } from "../InstallPWAButton";

// Helper — install a controllable mock for `window.matchMedia` and remember
// the original so we can restore it after each test.
function mockMatchMedia(matchesStandalone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches:
        matchesStandalone && query.includes("display-mode: standalone")
          ? true
          : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => ua,
  });
}

// Synthesize a `beforeinstallprompt`-shaped event. jsdom's `Event` constructor
// does not let us attach extra fields via init dict, so we build the Event then
// stamp on `prompt` / `userChoice` after the fact.
function makeInstallPromptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string; platform: string }>;
    platforms: string[];
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: "web" });
  event.platforms = ["web"];
  return event;
}

describe("InstallPWAButton", () => {
  const originalUA = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    "userAgent",
  );
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    // Default: non-iOS browser, NOT in standalone mode.
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/124.0",
    );
    mockMatchMedia(false);
  });

  afterEach(() => {
    if (originalUA) {
      Object.defineProperty(Navigator.prototype, "userAgent", originalUA);
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it("renders nothing when no beforeinstallprompt event has fired AND not iOS", () => {
    const { container } = render(<InstallPWAButton />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("install-pwa-button")).toBeNull();
  });

  it("renders nothing when the page is already running standalone (matchMedia matches)", async () => {
    mockMatchMedia(true);
    const { container } = render(<InstallPWAButton />);
    // Even if a prompt event were fired, we should stay hidden because
    // the page is already installed.
    await act(async () => {
      window.dispatchEvent(makeInstallPromptEvent());
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders the Install App button after a beforeinstallprompt event fires", async () => {
    render(<InstallPWAButton />);
    await act(async () => {
      window.dispatchEvent(makeInstallPromptEvent());
    });
    const btn = await screen.findByTestId("install-pwa-button");
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/install app/i);
  });

  it("calls prompt() on click and hides the button when the user accepts", async () => {
    render(<InstallPWAButton />);
    const event = makeInstallPromptEvent("accepted");
    await act(async () => {
      window.dispatchEvent(event);
    });
    const btn = await screen.findByTestId("install-pwa-button");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByTestId("install-pwa-button")).toBeNull(),
    );
  });

  it("renders the iOS Install App button + opens the instructions modal on click (iOS Safari path)", async () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
    );
    render(<InstallPWAButton />);
    const btn = screen.getByTestId("install-pwa-button");
    expect(btn).toBeTruthy();
    // Modal not yet rendered.
    expect(screen.queryByTestId("install-pwa-modal")).toBeNull();
    fireEvent.click(btn);
    const modal = screen.getByTestId("install-pwa-modal");
    expect(modal).toBeTruthy();
    expect(
      screen.getByTestId("install-pwa-ios-instructions").textContent,
    ).toMatch(/add to home screen/i);
  });

  it("Install App button meets the 44px touch-target invariant (h-11 min-w-[44px])", async () => {
    render(<InstallPWAButton />);
    await act(async () => {
      window.dispatchEvent(makeInstallPromptEvent());
    });
    const btn = await screen.findByTestId("install-pwa-button");
    const cls = btn.className;
    expect(cls).toMatch(/\bh-11\b/);
    expect(cls).toMatch(/min-w-\[44px\]/);
  });
});
