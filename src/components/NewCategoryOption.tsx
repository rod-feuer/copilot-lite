"use client";
import { useCallback, useState, type ReactNode } from "react";
import { Popover } from "@/components/Popover";
import { NewCategoryForm } from "@/components/NewCategoryForm";
import type { Category } from "@/lib/types";

// "+ New category…" as the last option of any category dropdown — the
// recurrings row, the shelf's vendor category, the shelf's per-charge picker.
// One hook owns the flow: the option is chosen → the create form opens in a
// popover under that dropdown → Add hands the new category back with whatever
// context the caller attached (the row, the charge), so it can be applied to
// the thing the user was looking at. DESIGN §2: correct on the object.
export const NEW_CATEGORY = "__new__";

export function NewCategoryOption() {
  return <option value={NEW_CATEGORY}>+ New category…</option>;
}

export function useNewCategory<T>(onCreated: (cat: Category, ctx: T) => void): {
  open: (anchor: HTMLElement, ctx: T, title?: string) => void;
  popover: ReactNode;
} {
  const [state, setState] = useState<{ anchor: DOMRect; ctx: T; title?: string } | null>(null);
  const open = useCallback(
    (anchor: HTMLElement, ctx: T, title?: string) =>
      setState({ anchor: anchor.getBoundingClientRect(), ctx, title }),
    []
  );
  const close = useCallback(() => setState(null), []);
  const popover = state ? (
    <Popover anchor={state.anchor} label="New category" onClose={close}>
      {state.title && <div className="mb-2 text-xs font-medium text-[var(--muted)]">{state.title}</div>}
      <NewCategoryForm
        autoFocus
        onCreated={(cat) => {
          const ctx = state.ctx;
          setState(null);
          onCreated(cat, ctx);
        }}
      />
    </Popover>
  ) : null;
  return { open, popover };
}
