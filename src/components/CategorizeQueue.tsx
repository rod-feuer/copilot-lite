"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import type { CategorySuggestion } from "@/lib/categorizeSuggest";

// "Suggested categories" — reviewable proposals for uncategorized vendors instead
// of a blind Auto-categorize button. Rules/history load free; the model's guesses
// are fetched on demand and badged "AI" so they get a look before they're
// committed (Rule 5). Apply learns the choice as a rule. Renders nothing when
// everything's categorized.
export function CategorizeQueue({ onChange }: { onChange?: () => void }) {
  const [items, setItems] = useState<CategorySuggestion[]>([]);
  const [needsModel, setNeedsModel] = useState(0);
  const [modelEnabled, setModelEnabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const d = await fetch("/api/category-suggestions").then((r) => r.json());
    setItems(d.suggestions);
    setNeedsModel(d.needsModelCount);
    setModelEnabled(d.modelEnabled);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  useSyncedRefresh(load);

  async function apply(s: CategorySuggestion) {
    setBusy(s.merchant);
    setItems((a) => a.filter((x) => x.merchant !== s.merchant));
    try {
      await postJson("/api/category-suggestions", { action: "apply", merchant: s.merchant, categoryId: s.categoryId });
      toast(`Categorized “${s.merchant}” as ${s.categoryName}`, "success");
      onChange?.();
    } catch {
      toast("Couldn't categorize — please try again", "error");
      load();
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(s: CategorySuggestion) {
    setItems((a) => a.filter((x) => x.merchant !== s.merchant));
    try {
      await postJson("/api/category-suggestions", { action: "dismiss", merchant: s.merchant });
    } catch {
      load();
    }
  }

  async function applyAll() {
    setBusy("__all");
    const batch = items.map((s) => ({ merchant: s.merchant, categoryId: s.categoryId }));
    setItems([]);
    try {
      await postJson("/api/category-suggestions", { action: "applyAll", items: batch });
      toast(`Categorized ${batch.length} vendor${batch.length === 1 ? "" : "s"}`, "success");
      onChange?.();
    } catch {
      toast("Couldn't categorize — please try again", "error");
      load();
    } finally {
      setBusy(null);
    }
  }

  async function suggestAI() {
    setBusy("__ai");
    try {
      const d = (await postJson("/api/category-suggestions", { action: "suggestAI" })) as {
        suggestions: CategorySuggestion[];
      };
      setNeedsModel(0);
      setItems((a) => {
        const have = new Set(a.map((x) => x.merchant));
        return [...a, ...d.suggestions.filter((x) => !have.has(x.merchant))];
      });
      if (d.suggestions.length === 0) toast("No confident suggestions from the model", "info");
    } catch {
      toast("Couldn't reach the model — please try again", "error");
    } finally {
      setBusy(null);
    }
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
              className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3"
            >
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate font-medium">{s.merchant}</span>
                <span className="text-[var(--muted)]">→</span>
                <span className="shrink-0">
                  {s.categoryIcon} {s.categoryName}
                </span>
                <span className="shrink-0 text-xs text-[var(--muted)]">({s.count})</span>
                <SourceTag source={s.source} />
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
              <button
                onClick={suggestAI}
                disabled={busy != null}
                className="font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
              >
                {busy === "__ai" ? "Asking AI…" : "Suggest with AI"}
              </button>
            </>
          ) : (
            <span>
              {needsModel} vendor{needsModel === 1 ? "" : "s"} need the model — set ANTHROPIC_API_KEY to get AI suggestions.
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
