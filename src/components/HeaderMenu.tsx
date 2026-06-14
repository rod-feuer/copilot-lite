"use client";

import { useState } from "react";

// A "⋯" overflow for header actions that are too rare to earn a permanent slot
// on a phone screen (Sync, Import). Inline on desktop; behind this menu on
// mobile. One pattern, shared by every tab's header.
export function HeaderMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-ghost px-3 text-base leading-none"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            onClick={() => setOpen(false)}
            className="absolute right-0 z-40 mt-1 flex flex-col items-stretch gap-1 rounded-xl border border-[var(--border)] bg-card p-1 shadow-lg"
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
