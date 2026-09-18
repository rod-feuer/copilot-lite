"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useMutation } from "@/components/useMutation";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import { CategoryProperty } from "@/components/RowCells";
import type { CategorySuggestion } from "@/lib/categorizeSuggest";
import type { Category } from "@/lib/types";

// A proposal the user may have redirected: the category to apply is the
// row's current choice, and a redirected one says so.
type Proposal = CategorySuggestion & { edited?: boolean };

// "Suggested categories" — reviewable proposals for uncategorized vendors instead
// of a blind Auto-categorize button. Rules/history load free; the model's guesses
// are fetched on demand and badged "AI" so they get a look before they're
// committed (Rule 5). Apply learns the choice as a rule. Renders nothing when
// everything's categorized.
export function CategorizeQueue({
  onChange,
  onShowUncategorized,
}: {
  onChange?: () => void;
  onShowUncategorized?: () => void; // filter the list below to the uncategorized charges
}) {
  const [items, setItems] = useState<Proposal[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [needsModel, setNeedsModel] = useState(0);
  const [modelEnabled, setModelEnabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [d, cs] = await Promise.all([
      fetch("/api/category-suggestions").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
    ]);
    setItems(d.suggestions);
    setCats(cs);
    setNeedsModel(d.needsModelCount);
    setModelEnabled(d.modelEnabled);
  }, []);
  // Redirect a proposal: the row keeps the vendor, takes the chosen category,
  // and Apply (or Apply all) commits that choice. Uncategorized is not a
  // choice here — that is Dismiss.
  function redirect(merchant: string, categoryId: number | null) {
    const c = cats.find((x) => x.id === categoryId);
    if (!c) return;
    setItems((a) => a.map((x) => (x.merchant === merchant ? { ...x, categoryId: c.id, categoryName: c.name, categoryIcon: c.icon, edited: true } : x)));
  }
  const mutate = useMutation(load);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  useSyncedRefresh(load);

  async function apply(s: CategorySuggestion) {
    setBusy(s.merchant);
    setItems((a) => a.filter((x) => x.merchant !== s.merchant)); // optimistic
    const ok = await mutate(
      () =>
        postJson("/api/category-suggestions", { action: "apply", merchant: s.merchant, categoryId: s.categoryId }),
      {
        success: `Categorized “${s.merchant}” as ${s.categoryName}`,
        error: "Couldn't categorize — please try again",
      },
      { refresh: "error" } // restore the optimistic removal on failure
    );
    if (ok) onChange?.();
    setBusy(null);
  }

  async function dismiss(s: CategorySuggestion) {
    setItems((a) => a.filter((x) => x.merchant !== s.merchant)); // optimistic
    await mutate(
      () => postJson("/api/category-suggestions", { action: "dismiss", merchant: s.merchant }),
      { error: "Couldn't dismiss — please try again" },
      { refresh: "error" }
    );
  }

  async function applyAll() {
    setBusy("__all");
    const batch = items.map((s) => ({ merchant: s.merchant, categoryId: s.categoryId }));
    setItems([]); // optimistic
    const ok = await mutate(
      () => postJson("/api/category-suggestions", { action: "applyAll", items: batch }),
      {
        success: `Categorized ${batch.length} vendor${batch.length === 1 ? "" : "s"}`,
        error: "Couldn't categorize — please try again",
      },
      { refresh: "error" }
    );
    if (ok) onChange?.();
    setBusy(null);
  }

  async function suggestAI() {
    setBusy("__ai");
    await mutate(
      async () => {
        const d = (await postJson("/api/category-suggestions", { action: "suggestAI" })) as {
          suggestions: CategorySuggestion[];
        };
        setNeedsModel(0);
        setItems((a) => {
          const have = new Set(a.map((x) => x.merchant));
          return [...a, ...d.suggestions.filter((x) => !have.has(x.merchant))];
        });
        // An empty result is "info", not a success toast — it stays in the write.
        if (d.suggestions.length === 0) toast("The model had no suggestions for these vendors", "info");
      },
      { error: "Couldn't reach the model — please try again" },
      { refresh: "never" } // nothing to restore: the list only ever gained rows
    );
    setBusy(null);
  }

  if (items.length === 0 && needsModel === 0) return null;

  return (
    <div className="card mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">Suggested categories</span>
        {items.length > 0 && (
          <span className="rounded-full bg-[var(--muted)]/15 px-2 py-0.5 text-xs text-[var(--muted)]">
            {items.length}
          </span>
        )}
        {items.length > 0 && (
          <button onClick={applyAll} disabled={busy != null} className="btn-ghost ml-auto text-xs disabled:opacity-50">
            {busy === "__all" ? "Applying…" : "Apply all"}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Proposed categories for vendors with none yet. Apply the ones you want, or dismiss.
      </p>

      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((s) => (
            <li
              key={s.merchant}
              data-suggestion
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3"
            >
              {/* The proposed category is the quiet property, so it can be
                  changed in place before it is applied — not only taken or
                  left. A redirected proposal wears the edited tag. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <span className="truncate font-medium">{s.merchant}</span>
                <span className="text-[var(--muted)]">→</span>
                <CategoryProperty
                  categoryId={s.categoryId}
                  categoryName={s.categoryName}
                  categoryIcon={s.categoryIcon}
                  cats={cats}
                  onChange={(id) => redirect(s.merchant, id)}
                  ariaLabel={`Category for ${s.merchant}`}
                  className="-ml-1.5"
                />
                <span className="shrink-0 text-xs text-[var(--muted)]">({s.count})</span>
                {s.edited ? (
                  <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 text-[11px] font-medium text-[var(--accent)]">edited</span>
                ) : (
                  <SourceTag source={s.source} />
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  disabled={busy === s.merchant}
                  onClick={() => apply(s)}
                  className="btn-primary text-xs disabled:opacity-50"
                >
                  Apply
                </button>
                <button
                  disabled={busy === s.merchant}
                  onClick={() => dismiss(s)}
                  className="btn-ghost text-xs disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {needsModel > 0 && (
        <div className={`flex items-center gap-2 text-xs text-[var(--muted)] ${items.length > 0 ? "mt-3" : ""}`}>
          {modelEnabled ? (
            <>
              <span>
                {needsModel} vendor{needsModel === 1 ? "" : "s"} need a closer look.
              </span>
              <button onClick={suggestAI} disabled={busy != null} className="btn-ghost py-1 text-xs">
                {busy === "__ai" ? "Asking AI…" : "Suggest with AI"}
              </button>
              {/* The hand-work path: when the model has nothing to offer, the
                  list itself, filtered to what needs a category. */}
              {onShowUncategorized && (
                <button onClick={onShowUncategorized} className="btn-link" data-show-uncategorized>
                  Show all uncategorized →
                </button>
              )}
            </>
          ) : (
            <span>
              {needsModel} vendor{needsModel === 1 ? "" : "s"} need the model — set ANTHROPIC_API_KEY to get AI suggestions.{" "}
              {onShowUncategorized && (
                <button onClick={onShowUncategorized} className="btn-link" data-show-uncategorized>
                  Show all uncategorized →
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SourceTag({ source }: { source: CategorySuggestion["source"] }) {
  if (source === "ai")
    return (
      <span className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 text-[10px] font-medium text-[var(--accent)]">
        AI
      </span>
    );
  return (
    <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
      {source === "history" ? "history" : "rule"}
    </span>
  );
}
