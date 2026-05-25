// Install-PWA affordance for the patient portal (Pearl §6.2 — gap #5 row 168).
// Mounted by `apps/web/src/app/patient/layout.tsx` in the topbar near "Sign in".
// Captures the browser's `beforeinstallprompt` event (Android Chrome / Edge /
// Samsung Internet) and surfaces an "Install App" button that triggers the
// native install flow. iOS Safari (which deliberately does NOT fire this event)
// gets a fallback button that opens an "Add to Home Screen" instructions modal.
// Auto-hides when the page is already running standalone — no point installing
// what's already installed. The 44px touch-target (`h-11 min-w-[44px]`) keeps
// the affordance compliant with Pearl §6.2's touch-friendly invariant.
"use client";

import { useCallback, useEffect, useState, type ReactElement } from "react";

// `BeforeInstallPromptEvent` is not yet in lib.dom.d.ts; declare the minimal
// surface we need locally to keep this component dependency-free.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches
  ) {
    return true;
  }
  // iOS Safari exposes the legacy non-standard `navigator.standalone` flag.
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return false;
}

export function InstallPWAButton(): ReactElement | null {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [iosModalOpen, setIosModalOpen] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setStandalone(isStandalone());
    setIos(isIOS());

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      // Cast: we trust the browser dispatched the right shape. Chromium/Edge/
      // Samsung Internet all carry the `prompt` method + `userChoice` Promise.
      setDeferredPrompt(event as unknown as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall as EventListener);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        onBeforeInstall as EventListener,
      );
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const onInstallClick = useCallback(async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstalled(true);
        setDeferredPrompt(null);
      }
    } catch {
      // Browser cancelled the prompt; leave the button visible so the user
      // can try again — the deferred event is single-use, so clear it.
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  // Already installed / running as installed app — no affordance needed.
  if (installed || standalone) return null;

  // Android / Chromium path — we have a captured prompt event.
  if (deferredPrompt) {
    return (
      <button
        type="button"
        onClick={onInstallClick}
        data-testid="install-pwa-button"
        className="inline-flex h-11 min-w-[44px] items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
        aria-label="Install Patient Portal app"
      >
        Install App
      </button>
    );
  }

  // iOS Safari path — `beforeinstallprompt` is never fired, so we offer
  // a button that opens manual "Add to Home Screen" guidance.
  if (ios) {
    return (
      <>
        <button
          type="button"
          onClick={() => setIosModalOpen(true)}
          data-testid="install-pwa-button"
          className="inline-flex h-11 min-w-[44px] items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
          aria-label="Install Patient Portal app on iOS"
        >
          Install App
        </button>
        {iosModalOpen ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-pwa-ios-title"
            data-testid="install-pwa-modal"
            className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 px-4 py-6 sm:items-center"
          >
            <div
              data-testid="install-pwa-ios-instructions"
              className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg"
            >
              <h2
                id="install-pwa-ios-title"
                className="text-base font-semibold text-slate-900"
              >
                Add Patient Portal to Home Screen
              </h2>
              <ol className="mt-3 space-y-2 text-sm text-slate-700">
                <li>
                  1. Tap the <strong>Share</strong> icon in Safari&apos;s toolbar.
                </li>
                <li>
                  2. Scroll and tap <strong>Add to Home Screen</strong>.
                </li>
                <li>
                  3. Tap <strong>Add</strong> in the top-right corner.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setIosModalOpen(false)}
                data-testid="install-pwa-modal-close"
                className="mt-4 inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
              >
                Got it
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  // Desktop Firefox / Safari / unsupported — render nothing.
  return null;
}
