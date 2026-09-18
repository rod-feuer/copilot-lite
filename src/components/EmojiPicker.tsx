"use client";
import { useEffect, useRef, useState } from "react";
import { Tooltip } from "@/components/Tooltip";
import { CATEGORY_EMOJIS } from "@/lib/emoji";

// The category icon picker (search or paste an emoji) and the button that
// opens it in a popover. Moved out of the categories page so the New-category
// form can be shared with the recurrings dropdown.
export function EmojiPicker({ value, onPick }: { value?: string; onPick: (emoji: string) => void }) {
  const [q, setQ] = useState("");
  const raw = q.trim();
  const ql = raw.toLowerCase();
  const shown = ql
    ? CATEGORY_EMOJIS.filter((e) => e.keywords.includes(ql) || e.char === raw)
    : CATEGORY_EMOJIS;
  // A non-empty query that's clearly an emoji (not plain ascii words) and isn't
  // in the curated list → let the user pick exactly what they pasted.
  const pasted =
    raw && !/^[\w\s]+$/.test(raw) && !CATEGORY_EMOJIS.some((e) => e.char === raw) ? raw : null;
  const tile = (char: string, key: string) => (
    <button
      key={key}
      onClick={() => onPick(char)}
      className={`flex h-7 w-7 items-center justify-center rounded-lg text-lg hover:bg-[var(--hover)] ${
        value === char ? "bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/40" : ""
      }`}
    >
      {char}
    </button>
  );
  return (
    <div className="w-full" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search or paste an emoji…"
        className="mb-2 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
      />
      <div className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto">
        {pasted && tile(pasted, "pasted")}
        {shown.map((e) => tile(e.char, e.char))}
        {!pasted && shown.length === 0 && (
          <span className="col-span-8 px-1 py-3 text-center text-[11px] text-[var(--muted)]">
            No matches — paste any emoji to use it.
          </span>
        )}
      </div>
    </div>
  );
}

// A button showing the current emoji that opens the EmojiPicker in a popover —
// used by the New-category form (where there's no badge to click).
export function EmojiButton({ value, onPick }: { value: string; onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Tooltip label="Choose icon" onlyIfTruncated={false}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="btn-ghost w-14 text-center text-lg"
          aria-label="Choose icon"
        >
          {value}
        </button>
      </Tooltip>
      {open && (
        <div className="absolute left-0 top-12 z-20 w-64 rounded-lg border border-[var(--border)] bg-card p-3 shadow-lg">
          <EmojiPicker
            value={value}
            onPick={(e) => {
              onPick(e);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
