"use client";
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "@/components/Tooltip";

// The row's ⋯ menu — the app's one pattern for secondary row actions: an
// always-visible trigger, a portaled menu (so it escapes the list's
// content-visibility clipping), closed by outside click, Escape, scroll, or
// resize. Items close the menu themselves. Extracted from the transactions
// row so the recurrings row uses the same thing instead of a row of buttons.
const CloseCtx = createContext<() => void>(() => {});

export function RowMenu({ label = "More actions", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: globalThis.MouseEvent) => {
      const node = e.target as Node;
      if (btnRef.current?.contains(node) || menuRef.current?.contains(node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true); // any ancestor scroll
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  }
  return (
    <CloseCtx.Provider value={() => setOpen(false)}>
      {/* Fixed-width trailing column; glyph biased right so its edge matches
          the avatar's left gutter. */}
      <Tooltip label={label} onlyIfTruncated={false} className="flex w-6 shrink-0 items-center justify-end">
        <button
          ref={btnRef}
          onClick={toggle}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`rounded-md px-1 py-1 text-base leading-none transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] ${
            open ? "bg-[var(--background)] text-[var(--foreground)]" : "text-[var(--muted)]"
          }`}
        >
          ⋯
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            className="z-50 w-48 rounded-xl border border-[var(--border)] bg-card p-1 shadow-lg"
          >
            {children}
          </div>,
          document.body
        )}
    </CloseCtx.Provider>
  );
}

export function RowMenuItem({ label, onSelect, className = "" }: { label: string; onSelect: () => void; className?: string }) {
  const close = useContext(CloseCtx);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        close();
        onSelect();
      }}
      className={`block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--hover)] ${className}`.trim()}
    >
      {label}
    </button>
  );
}

export const RowMenuDivider = () => <div className="my-1 border-t border-[var(--border)]" />;
