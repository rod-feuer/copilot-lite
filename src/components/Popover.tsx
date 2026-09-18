"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A small anchored surface for a form that belongs to a row control (the
// New-category form under a row's category dropdown). Portaled so it escapes
// list clipping; closed by an outside click or Escape. Clicks and keys inside
// stop at the popover so the keyboard row beneath never activates. Unlike the
// row menu it survives scrolling — someone is typing in it.
export function Popover({
  anchor,
  onClose,
  children,
  label,
}: {
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const width = Math.min(560, window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: anchor.bottom + 6, left, width }}
      className="z-50 rounded-lg border border-[var(--border)] bg-card p-3 shadow-lg"
    >
      {children}
    </div>,
    document.body
  );
}
