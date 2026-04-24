"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PromptDialog } from "@/components/PromptDialog";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  required?: boolean;
  multiline?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmState extends ConfirmOptions {
  id: number;
  resolve: (v: boolean) => void;
}

interface PromptState extends PromptOptions {
  id: number;
  resolve: (v: string | null) => void;
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

/**
 * Provider that owns a single ConfirmDialog and a single PromptDialog and
 * queues requests so concurrent callers get resolved one at a time. Mount
 * once near the root of the authenticated tree.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  // Each queue keeps pending requests; the head renders the visible dialog.
  const [confirmQueue, setConfirmQueue] = useState<ConfirmState[]>([]);
  const [promptQueue, setPromptQueue] = useState<PromptState[]>([]);
  const idRef = useRef(0);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const id = ++idRef.current;
      setConfirmQueue((q) => [...q, { ...opts, id, resolve }]);
    });
  }, []);

  const prompt = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      const id = ++idRef.current;
      setPromptQueue((q) => [...q, { ...opts, id, resolve }]);
    });
  }, []);

  const value = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);

  const currentConfirm = confirmQueue[0];
  const currentPrompt = promptQueue[0];

  const handleConfirm = useCallback(() => {
    if (!currentConfirm) return;
    currentConfirm.resolve(true);
    setConfirmQueue((q) => q.slice(1));
  }, [currentConfirm]);

  const handleConfirmCancel = useCallback(() => {
    if (!currentConfirm) return;
    currentConfirm.resolve(false);
    setConfirmQueue((q) => q.slice(1));
  }, [currentConfirm]);

  const handlePromptConfirm = useCallback(
    (v: string) => {
      if (!currentPrompt) return;
      currentPrompt.resolve(v);
      setPromptQueue((q) => q.slice(1));
    },
    [currentPrompt]
  );

  const handlePromptCancel = useCallback(() => {
    if (!currentPrompt) return;
    currentPrompt.resolve(null);
    setPromptQueue((q) => q.slice(1));
  }, [currentPrompt]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={!!currentConfirm}
        title={currentConfirm?.title ?? ""}
        message={currentConfirm?.message}
        confirmLabel={currentConfirm?.confirmLabel}
        cancelLabel={currentConfirm?.cancelLabel}
        danger={currentConfirm?.danger}
        onConfirm={handleConfirm}
        onCancel={handleConfirmCancel}
      />
      <PromptDialog
        open={!!currentPrompt}
        title={currentPrompt?.title ?? ""}
        message={currentPrompt?.message}
        label={currentPrompt?.label ?? ""}
        placeholder={currentPrompt?.placeholder}
        initialValue={currentPrompt?.initialValue}
        required={currentPrompt?.required}
        multiline={currentPrompt?.multiline}
        confirmLabel={currentPrompt?.confirmLabel}
        cancelLabel={currentPrompt?.cancelLabel}
        onConfirm={handlePromptConfirm}
        onCancel={handlePromptCancel}
      />
    </DialogContext.Provider>
  );
}

function useDialogContext(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error(
      "useConfirm / usePrompt must be used inside a <DialogProvider>"
    );
  }
  return ctx;
}

/**
 * Hook returning an async confirm() function. Usage:
 *
 *   const confirm = useConfirm();
 *   if (!await confirm({ title: "Delete invoice?", danger: true })) return;
 */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useDialogContext().confirm;
}

/**
 * Hook returning an async prompt() function resolving to the entered string
 * or null if cancelled. Usage:
 *
 *   const promptUser = usePrompt();
 *   const reason = await promptUser({ title: "Reason?", label: "Reason", required: true });
 *   if (reason === null) return;
 */
export function usePrompt(): (opts: PromptOptions) => Promise<string | null> {
  return useDialogContext().prompt;
}
