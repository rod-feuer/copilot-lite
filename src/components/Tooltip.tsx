"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Instant tooltip (no native `title` delay), rendered to a portal so it isn't
// clipped by scroll containers like the shelf. By default it only shows when the
// trigger's text is actually truncated — matching Linear's behavior.
export function Tooltip({
  label,
  className,
  children,
  onlyIfTruncated = true,
}: {
  label: string;
  className?: string;
  children: ReactNode;
  onlyIfTruncated?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  function show() {
    const el = ref.current;
    if (!el) return;
    if (onlyIfTruncated && el.scrollWidth <= el.clientWidth) return; // not cut off
    setRect(el.getBoundingClientRect());
  }

  return (
    <>
      <span
        ref={ref}
        className={className}
        onMouseEnter={show}
        onMouseLeave={() => setRect(null)}
      >
        {children}
      </span>
      {rect &&
        createPortal(
          // Prefer above; flip below when there isn't room above the trigger.
          (() => {
            const above = rect.top > 44;
            return (
              <div
                role="tooltip"
                style={{ left: rect.left, top: above ? rect.top - 6 : rect.bottom + 6 }}
                className={`pointer-events-none fixed z-[100] max-w-xs rounded-md bg-[var(--foreground)] px-2 py-1 text-xs text-[var(--background)] shadow-lg ${
                  above ? "-translate-y-full" : ""
                }`}
              >
                {label}
              </div>
            );
          })(),
          document.body
        )}
    </>
  );
}
