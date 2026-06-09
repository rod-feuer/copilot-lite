"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; message: string; type: ToastType };

const ToastCtx = createContext<(message: string, type?: ToastType) => void>(
  () => {}
);

export const useToast = () => useContext(ToastCtx);

let nextId = 1;
const DOT: Record<ToastType, string> = {
  success: "bg-emerald-500",
  error: "bg-rose-500",
  info: "bg-[var(--accent)]",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = nextId++;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-[var(--border)] bg-card px-3.5 py-2.5 text-sm shadow-[0_8px_24px_rgba(16,24,40,0.16)]"
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[t.type]}`} />
            <span className="text-[var(--foreground)]">{t.message}</span>
            <button
              onClick={() => setToasts((arr) => arr.filter((x) => x.id !== t.id))}
              className="ml-auto shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
