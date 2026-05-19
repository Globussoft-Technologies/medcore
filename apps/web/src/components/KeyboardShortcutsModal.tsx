"use client";

import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const shortcuts: Array<{ keys: string; label: string }> = [
  { keys: "Ctrl + K", label: "Open search palette" },
  { keys: "?", label: "Show this help" },
  { keys: "g h", label: "Go to Dashboard home" },
  { keys: "g a", label: "Go to Appointments" },
  { keys: "g p", label: "Go to Patients" },
  { keys: "g q", label: "Go to Queue" },
  { keys: "n", label: "New item (context-aware)" },
  { keys: "Esc", label: "Close any open modal" },
];

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h3
            id="shortcuts-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Keyboard Shortcuts
          </h3>
          <button
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {shortcuts.map((s) => (
            <li key={s.keys} className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {s.label}
              </span>
              <kbd className="rounded bg-gray-100 px-2 py-0.5 text-xs font-mono font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
          Sequence shortcuts (like <kbd>g</kbd> then <kbd>h</kbd>) must be pressed
          within 2 seconds.
        </p>
      </div>
    </div>
  );
}
