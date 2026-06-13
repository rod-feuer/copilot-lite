"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A small "?" that explains a concept at the point of use (DESIGN.md §2 "teach at
// the point of use"). Reachable on hover, keyboard focus, AND tap (the native
// `title` is hover-only — dead on touch), so it works everywhere. Portaled so it
// isn't clipped by scroll containers / content-visibility rows.
export function InfoHint({ text, label = "What's this?" }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const show = () => {
    const el = btnRef.current;
    if (el) {
      setRect(el.getBoundingClientRect());
      setOpen(true);
    }
  };
  const hide = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true); // any scroll dismisses (portaled)
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          open ? hide() : show();
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-[var(--border)] text-[9px] font-semibold leading-none text-[var(--muted)] transition-colors hover:border-[var(--muted)] hover:text-[var(--foreground)]"
      >
        ?
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            role="tooltip"
            style={{
              // Clamp so a hint near the right edge doesn't overflow the viewport.
              left: Math.min(rect.left, window.innerWidth - 268),
              top: rect.bottom + 6,
            }}
            className="pointer-events-none fixed z-[100] max-w-[16rem] rounded-md bg-[var(--foreground)] px-2.5 py-1.5 text-xs leading-snug text-[var(--background)] shadow-lg"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
