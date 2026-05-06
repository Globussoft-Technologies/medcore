"use client";

import { useToastStore, ToastKind } from "@/lib/toast";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

const styles: Record<
  ToastKind,
  { bg: string; border: string; icon: React.ElementType; iconColor: string }
> = {
  success: {
    bg: "bg-white dark:bg-gray-800",
    border: "border-l-4 border-green-500",
    icon: CheckCircle2,
    iconColor: "text-green-500",
  },
  error: {
    bg: "bg-white dark:bg-gray-800",
    border: "border-l-4 border-red-500",
    icon: XCircle,
    iconColor: "text-red-500",
  },
  warning: {
    bg: "bg-white dark:bg-gray-800",
    border: "border-l-4 border-yellow-500",
    icon: AlertTriangle,
    iconColor: "text-yellow-500",
  },
  info: {
    bg: "bg-white dark:bg-gray-800",
    border: "border-l-4 border-blue-500",
    icon: Info,
    iconColor: "text-blue-500",
  },
};

export function ToastContainer() {
  const { toasts, dismiss } = useToastStore();

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="no-print pointer-events-none fixed bottom-4 right-4 z-[9999] flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => {
        const s = styles[t.kind];
        const Icon = s.icon;
        // Error toasts use role="alert" (implicit aria-live="assertive")
        // so screen readers interrupt the current utterance — the canonical
        // a11y contract for failure announcements. Other kinds stay role="status"
        // (polite) to queue behind whatever the SR is reading.
        const role = t.kind === "error" ? "alert" : "status";
        return (
          <div
            key={t.id}
            role={role}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg ${s.bg} ${s.border} p-3 shadow-lg animate-in slide-in-from-right`}
          >
            <Icon size={18} className={`mt-0.5 flex-shrink-0 ${s.iconColor}`} />
            <p className="flex-1 text-sm text-gray-800 dark:text-gray-100">
              {t.message}
            </p>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:ring-2 focus:ring-primary focus:ring-offset-1 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
