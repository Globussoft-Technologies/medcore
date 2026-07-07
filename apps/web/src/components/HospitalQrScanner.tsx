"use client";

// Hospital QR scanner (web, camera-based).
//
// Renders a "Scan Hospital QR" button that opens the device camera and decodes
// the hospital QR reception displays. On a successful decode it routes to the
// encoded destination:
//   • a same-origin URL (e.g. https://site/hospital/qr?tenantId=…) → in-app nav
//   • an external URL → full navigation
//   • a bare code/id → /hospital/qr?code=<value>
//
// Uses html5-qrcode (works on iOS Safari + Android Chrome), dynamically
// imported so it never runs during SSR and stays out of the initial bundle.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { QrCode, X, Upload } from "lucide-react";

const SCANNER_ELEMENT_ID = "hospital-qr-scanner-region";
const FILE_SCANNER_ELEMENT_ID = "hospital-qr-file-region";

export function HospitalQrScanner({ className }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Portal target (document.body) only exists on the client.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scannerRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  function handleDecoded(text: string) {
    const trimmed = text.trim();
    try {
      const url = new URL(trimmed, window.location.origin);
      // The hospital QR always points at THIS app's /hospital/qr route. The QR
      // may have been generated with a different host in it (e.g. the API
      // encoded http://localhost:3000 while we're viewing over a dev tunnel),
      // so navigating to the raw absolute URL would go nowhere. Instead we
      // keep only the PATH + QUERY (tenantId / code) and route in-app, so a
      // scan lands on the kiosk regardless of which host the QR baked in.
      const dest = (url.pathname || "/hospital/qr") + url.search;
      router.push(dest);
    } catch {
      // Not a URL — treat it as a bare hospital code/id.
      router.push(`/hospital/qr?code=${encodeURIComponent(trimmed)}`);
    }
  }

  // Fallback for no-camera / camera-blocked: decode a QR from an uploaded
  // image (screenshot or photo of the hospital QR). Uses html5-qrcode's
  // scanFile, which needs its own (hidden) render element.
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-triggers onChange.
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      await stop(); // release the camera if it was running
      const { Html5Qrcode } = await import("html5-qrcode");
      const inst = new Html5Qrcode(FILE_SCANNER_ELEMENT_ID);
      // showImage:true so the lib renders the decode canvas with real
      // dimensions — scanFile can silently fail on a zero-size container.
      const decoded = await inst.scanFile(file, true);
      try {
        await inst.clear();
      } catch {
        /* ignore */
      }
      // Navigate FIRST, then close — closing unmounts this component, and a
      // router.push racing the unmount could be dropped.
      handleDecoded(decoded);
      setOpen(false);
    } catch (err) {
      // Surface the real reason where we can — helps distinguish "no QR in
      // image" from a lib/init failure.
      const raw = err instanceof Error ? err.message : String(err ?? "");
      setError(
        /no.*code.*found|not found/i.test(raw)
          ? "No QR code found in that image. Use a clear, close-up photo of the hospital QR."
          : "Couldn't read that image. Try a sharper, well-lit photo of the QR — or use the camera.",
      );
    }
  }

  async function stop() {
    const inst = scannerRef.current;
    scannerRef.current = null;
    if (inst) {
      try {
        await inst.stop();
      } catch {
        /* already stopped */
      }
      try {
        await inst.clear();
      } catch {
        /* ignore */
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        const inst = new Html5Qrcode(SCANNER_ELEMENT_ID);
        scannerRef.current = inst;
        await inst.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          async (decodedText: string) => {
            await stop();
            if (!cancelled) {
              setOpen(false);
              handleDecoded(decodedText);
            }
          },
          () => {
            /* per-frame "no QR in view" — ignore */
          },
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Camera unavailable. Allow camera access and try again.",
        );
      }
    })();
    return () => {
      cancelled = true;
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        type="button"
        data-testid="scan-hospital-qr"
        onClick={() => setOpen(true)}
        className={
          className ??
          "inline-flex items-center justify-center gap-2 rounded-full border border-blue-300 bg-white/70 px-5 py-3 text-sm font-medium text-blue-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md dark:border-blue-800 dark:bg-gray-800/70 dark:text-blue-300"
        }
      >
        <QrCode className="h-4 w-4" />
        Scan Hospital QR
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Scan hospital QR code"
            data-testid="scan-hospital-qr-modal"
            // Portaled to <body> so `fixed` is viewport-relative (the sticky,
            // backdrop-blurred marketing header was trapping it near the top).
            // Scrollable + height-capped so it fits any screen.
            className="fixed inset-0 z-100 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:items-center"
            onClick={() => {
              setOpen(false);
              void stop();
            }}
          >
            <div
              className="my-auto max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900"
              onClick={(e) => e.stopPropagation()}
            >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Scan Hospital QR
              </h2>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void stop();
                }}
                aria-label="Close scanner"
                className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {error ? (
              <p
                role="alert"
                className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                {error}
              </p>
            ) : (
              <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
                Point your camera at the hospital&apos;s QR code at the front
                desk.
              </p>
            )}

            {/* html5-qrcode injects the camera video into this element. */}
            <div
              id={SCANNER_ELEMENT_ID}
              className="overflow-hidden rounded-xl bg-black"
            />

            {/* Fallback: upload a QR image (no camera / camera blocked). */}
            <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
              <p className="mb-2 text-center text-xs text-gray-500 dark:text-gray-400">
                No camera? Upload a photo of the QR instead.
              </p>
              <button
                type="button"
                data-testid="scan-hospital-qr-upload"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                <Upload className="h-4 w-4" />
                Upload QR image
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFile}
              />
              {/* Render target html5-qrcode needs for scanFile. Kept off-screen
                  (NOT display:none — the lib measures the container, so a
                  zero-size/hidden element makes scanFile silently fail). Given
                  a real size so the decode canvas has dimensions. */}
              <div
                id={FILE_SCANNER_ELEMENT_ID}
                aria-hidden="true"
                style={{
                  position: "fixed",
                  left: "-10000px",
                  top: 0,
                  width: 300,
                  height: 300,
                  overflow: "hidden",
                }}
              />
            </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
