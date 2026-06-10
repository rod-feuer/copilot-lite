"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/Toast";

// Fire a background Plaid sync when the app launches — at most once per window so
// reloads and new tabs don't spam it (client navigations don't remount the
// layout, so this only re-runs on a full load anyway). Quiet by design: a toast
// only when new data actually arrives, and silence on errors (e.g. the Plaid CLI
// isn't set up) so it never nags on launch. On success it emits `copilot:synced`
// so any open page can refresh without a full reload.
const THROTTLE_MS = 15 * 60 * 1000; // 15 minutes

export function SyncOnLaunch() {
  const toast = useToast();
  useEffect(() => {
    const KEY = "copilot:lastAutoSync";
    let last = 0;
    try {
      last = Number(localStorage.getItem(KEY) ?? 0);
    } catch {
      // localStorage unavailable — proceed without throttling.
    }
    if (Date.now() - last < THROTTLE_MS) return;
    try {
      localStorage.setItem(KEY, String(Date.now())); // throttle before awaiting
    } catch {
      // ignore
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/plaid/sync", { method: "POST" });
        if (!res.ok || cancelled) return; // Plaid not configured / errored → stay quiet
        const data = await res.json();
        const changed = (data.inserted ?? 0) + (data.updated ?? 0);
        if (changed > 0) {
          toast(`Synced ${data.inserted} new · ${data.updated} updated`, "success");
          window.dispatchEvent(new Event("copilot:synced"));
        }
      } catch {
        // network or other — silent on launch
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  return null;
}

// Re-run `onSynced` whenever a background launch sync brings in new data, so a
// page can refresh its data in place rather than waiting for the next navigation.
export function useSyncedRefresh(onSynced: () => void) {
  const ref = useRef(onSynced);
  useEffect(() => {
    ref.current = onSynced;
  });
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener("copilot:synced", handler);
    return () => window.removeEventListener("copilot:synced", handler);
  }, []);
}
