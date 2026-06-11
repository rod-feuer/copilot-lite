"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useSyncedRefresh } from "@/components/SyncOnLaunch";
import { postJson } from "@/lib/http";
import type { MergeSuggestion } from "@/lib/merges";

// The "possible duplicate vendors" review queue: same vendor under different
// bank descriptors (a location suffix, a rename, or just punctuation). Combining
// folds the descriptors into one vendor so recurring detection, totals, and
// display line up. Self-contained — fetches /api/merges and handles approve /
// dismiss. `onChange` lets the host page refresh its own data after a combine
// (which can re-stamp recurringId and fill a category). Renders nothing when the
// queue is empty, so it's safe to drop into any page.
export function MergeQueue({ onChange }: { onChange?: () => void }) {
  const [merges, setMerges] = useState<MergeSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const data = await fetch("/api/merges").then((r) => r.json());
    setMerges(data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  useSyncedRefresh(load);

  async function resolve(g: MergeSuggestion, action: "approve" | "dismiss") {
    setBusy(g.key);
    setMerges((ms) => ms.filter((m) => m.key !== g.key)); // optimistic
    try {
      await postJson("/api/merges", {
        action,
        keys: g.dismissKeys,
        canonical: g.canonical,
        variants: g.variants.map((v) => v.merchant),
        categoryId: g.categoryId,
      });
      if (action === "approve") {
        toast(`Combined into “${g.canonical}”`, "success");
        onChange?.();
      }
    } catch {
      toast("Couldn't update — please try again", "error");
      load(); // restore on failure
    } finally {
      setBusy(null);
    }
  }

  if (merges.length === 0) return null;

  return (
    <div className="card mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">Possible duplicate vendors</span>
        <span className="rounded-full bg-[var(--muted)]/15 px-2 py-0.5 text-xs text-[var(--muted)]">
          {merges.length}
        </span>
      </div>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Same vendor posting under different bank descriptors — a location suffix,
        a rename, or just punctuation. Combine to fix recurring detection and
        totals, or dismiss.
      </p>
      <ul className="flex flex-col gap-2">
        {merges.map((g) => (
          <li
            key={g.key}
            className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] p-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{g.canonical}</div>
              <div className="mt-0.5 text-xs text-[var(--muted)]">
                {g.variants.map((v) => `${v.merchant} (${v.count})`).join("  ·  ")}
              </div>
              {g.note && <div className="mt-1 text-xs text-[var(--accent)]">{g.note}</div>}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                disabled={busy === g.key}
                onClick={() => resolve(g, "approve")}
                className="btn-primary text-xs disabled:opacity-50"
              >
                Combine
              </button>
              <button
                disabled={busy === g.key}
                onClick={() => resolve(g, "dismiss")}
                className="btn-ghost text-xs disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
