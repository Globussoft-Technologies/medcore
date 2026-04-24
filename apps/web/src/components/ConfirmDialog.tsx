"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Generic in-DOM replacement for window.confirm(). Exposes stable test hooks
 * (data-testid="confirm-dialog", "confirm-dialog-confirm",
 * "confirm-dialog-cancel") so Playwright / jsdom can drive it — native
 * confirm() cannot be automated by the cloud browser.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  // Autofocus the confirm button when the dialog opens so keyboard users can
  // dismiss / accept without mouse interaction.
  useEffect(() => {
    if (open) {
      // Defer to the next frame — the button isn't in the DOM until after
      // the conditional render below commits.
      const id = requestAnimationFrame(() => {
        confirmBtnRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // ESC to cancel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby={message ? "confirm-dialog-message" : undefined}
      data-testid="confirm-dialog"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="confirm-dialog-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {title}
        </h3>
        {message && (
          <p
            id="confirm-dialog-message"
            className="mt-2 whitespace-pre-line text-sm text-gray-600 dark:text-gray-300"
          >
            {message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
            className={clsx(
              "rounded-lg px-4 py-2 text-sm font-medium text-white transition focus:ring-2 focus:ring-offset-2 focus:outline-none",
              danger
                ? "bg-red-600 hover:bg-red-700 focus:ring-red-500"
                : "bg-primary hover:bg-primary/90 focus:ring-primary"
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
