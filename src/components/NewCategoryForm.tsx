"use client";
import { useState } from "react";
import { EmojiButton } from "@/components/EmojiPicker";
import { useToast } from "@/components/Toast";
import type { Category } from "@/lib/types";

export const PALETTE = [
  "#6366f1", "#22c55e", "#f97316", "#0ea5e9", "#a855f7",
  "#eab308", "#ec4899", "#ef4444", "#14b8a6", "#64748b",
];

// The app's one way to create a category — icon, name, type, colour, Add —
// used by the categories page (in a card) and by the recurrings category
// dropdown (in a popover, via "+ New category…"), so a bill that needs a
// category that doesn't exist yet gets it without leaving the page.
export function NewCategoryForm({
  onCreated,
  autoFocus = false,
}: {
  onCreated: (cat: Category) => void;
  autoFocus?: boolean;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏷️");
  const [color, setColor] = useState(PALETTE[0]);
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  async function create() {
    if (!name.trim() || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), icon, color, kind }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast(d.error ?? "Could not create category.", "error");
        return;
      }
      setName("");
      onCreated(d.category as Category);
    } catch {
      toast("Could not create category.", "error");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2" data-new-category-form>
      <EmojiButton value={icon} onPick={setIcon} />
      <input
        autoFocus={autoFocus}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder="New category name"
        aria-label="New category name"
        className="btn-ghost min-w-44 flex-1 font-normal focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
      />
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as "expense" | "income")}
        aria-label="Category type"
        className="btn-ghost select-caret cursor-pointer appearance-none pr-8"
      >
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
      <div className="flex items-center gap-1">
        {PALETTE.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setColor(p)}
            className={`h-6 w-6 rounded-full ${
              color === p ? "ring-2 ring-offset-2 ring-[var(--foreground)]" : ""
            }`}
            style={{ background: p }}
            aria-label={`color ${p}`}
          />
        ))}
      </div>
      <button className="btn-primary" disabled={adding || !name.trim()} onClick={create}>
        Add
      </button>
    </div>
  );
}
