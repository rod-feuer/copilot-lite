"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import type { NameCleanupSuggestion } from "@/lib/nameCleanup";

// "Names to tidy" — a reviewable recommendation (before → after) instead of a
// blind bulk button. Apply the ones you want, dismiss the rest. Undo is
// contextual: it appears only right after you tidy something (this session), not
// as a standing button. Renders nothing when there's nothing to tidy or just-did.
export function NameCleanupQueue({ onChange }: { onChange?: () => void }) {
  const [items, setItems] = useState<NameCleanupSuggestion[]>([]);
  const [tidied, setTidied] = useState(false); // a tidy happened this session (→ Undo)
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const d = await fetch("/api/name-cleanup").then((r) => r.json());
    setItems(d.suggestions);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  useSyncedRefresh(load);

  const keyOf = (s: NameCleanupSuggestion) => `${s.from} ${s.to}`;

  async function apply(s: NameCleanupSuggestion) {
    setBusy(keyOf(s));
    setItems((a) => a.filter((x) => keyOf(x) !== keyOf(s))); // optimistic
    try {
      await postJson("/api/name-cleanup", { action: "apply", from: s.from, to: s.to });
      setTidied(true);
      toast(`Tidied to “${s.to}”`, "success");
      onChange?.();
    } catch {
      toast("Couldn't tidy — please try again", "error");
      load();
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(s: NameCleanupSuggestion) {
    setItems((a) => a.filter((x) => keyOf(x) !== keyOf(s)));
    try {
      await postJson("/api/name-cleanup", { action: "dismiss", from: s.from });
    } catch {
      load();
    }
  }

  async function applyAll() {
    setBusy("__all");
    setItems([]);
    try {
      const d = (await postJson("/api/name-cleanup", { action: "applyAll" })) as { changed: number };
      setTidied(true);
      toast(`Tidied ${d.changed} name${d.changed === 1 ? "" : "s"}`, "success");
      onChange?.();
    } catch {
      toast("Couldn't tidy — please try again", "error");
      load();
    } finally {
      setBusy(null);
    }
  }

  async function undo() {
    setBusy("__undo");
    try {
      const d = await (await fetch("/api/renormalize/undo", { method: "POST" })).json();
      setTidied(false);
      toast(d.restored > 0 ? `Restored ${d.restored} name${d.restored === 1 ? "" : "s"}` : "Nothing to undo", "success");
      onChange?.();
      load();
    } catch {
      toast("Couldn't undo — please try again", "error");
    } finally {
      setBusy(null);
    }
  }

  // Nothing to tidy and nothing just-tidied → render nothing.
  if (items.length === 0 && !tidied) return null;

  // Just-tidied with no remaining suggestions → a slim, contextual Undo only.
  if (items.length === 0) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
        <span>Merchant names tidied.</span>
        <button
          onClick={undo}
          disabled={busy != null}
          className="font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
        >
          {busy === "__undo" ? "Undoing…" : "Undo"}
        </button>
      </div>
    );
  }

  return (
    <div className="card mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">Names to tidy</span>
        <span className="rounded-full bg-[var(--muted)]/15 px-2 py-0.5 text-xs text-[var(--muted)]">
          {items.length}
        </span>
        <button onClick={applyAll} disabled={busy != null} className="btn-ghost ml-auto text-xs disabled:opacity-50">
          {busy === "__all" ? "Tidying…" : "Tidy all"}
        </button>
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Cleaner names rebuilt from the original bank descriptors. Apply the ones you want, or dismiss.
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((s) => (
          <li
            key={keyOf(s)}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3"
          >
            <div className="min-w-0 text-sm">
              <span className="text-[var(--muted)] line-through">{s.from}</span>
              <span className="mx-1.5 text-[var(--muted)]">→</span>
              <span className="font-medium">{s.to}</span>
              <span className="ml-1.5 text-xs text-[var(--muted)]">({s.count})</span>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                disabled={busy === keyOf(s)}
                onClick={() => apply(s)}
                className="btn-primary text-xs disabled:opacity-50"
              >
                Apply
              </button>
              <button
                disabled={busy === keyOf(s)}
                onClick={() => dismiss(s)}
                className="btn-ghost text-xs disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
      {tidied && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>Tidied.</span>
          <button
            onClick={undo}
            disabled={busy != null}
            className="font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
          >
            {busy === "__undo" ? "Undoing…" : "Undo"}
          </button>
        </div>
      )}
    </div>
  );
}
