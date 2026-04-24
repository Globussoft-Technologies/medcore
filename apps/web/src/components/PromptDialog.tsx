"use client";

import { useEffect, useRef, useState } from "react";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  message?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  required?: boolean;
  multiline?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * Generic in-DOM replacement for window.prompt(). Exposes stable test hooks
 * (data-testid="prompt-dialog", "prompt-dialog-input",
 * "prompt-dialog-confirm", "prompt-dialog-cancel").
 */
export function PromptDialog({
  open,
  title,
  message,
  label,
  placeholder,
  initialValue = "",
  required = false,
  multiline = false,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // Reset value each time the dialog is opened so stale input isn't shown.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open, initialValue]);

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

  const trimmed = value.trim();
  const confirmDisabled = required && trimmed.length === 0;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirmDisabled) return;
    onConfirm(value);
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      aria-describedby={message ? "prompt-dialog-message" : undefined}
      data-testid="prompt-dialog"
      onClick={onCancel}
    >
      <form
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3
          id="prompt-dialog-title"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {title}
        </h3>
        {message && (
          <p
            id="prompt-dialog-message"
            className="mt-2 whitespace-pre-line text-sm text-gray-600 dark:text-gray-300"
          >
            {message}
          </p>
        )}

        <div className="mt-4">
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              aria-label={label}
              data-testid="prompt-dialog-input"
              rows={4}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:ring-2 focus:ring-primary focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              aria-label={label}
              data-testid="prompt-dialog-input"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:ring-2 focus:ring-primary focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="prompt-dialog-cancel"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={confirmDisabled}
            data-testid="prompt-dialog-confirm"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
