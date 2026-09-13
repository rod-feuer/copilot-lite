"use client";
import { useCallback } from "react";
import { useToast } from "@/components/Toast";

// The one shape of a write from the UI: run it, toast the outcome, refresh.
// Every handler used to spell this out as its own try/catch — about thirty of
// them — and they disagreed on when to refresh. The policy is now one word per
// call, next to the write it applies to:
//   "success" (default) — re-read after a successful write
//   "always"            — re-read either way (an optimistic change that must
//                         re-sync, or a figure elsewhere on the page that moves)
//   "error"             — re-read only on failure (revert an optimistic change)
//   "never"             — the caller refreshes itself or nothing on screen changes
// Returns whether the write succeeded, for callers that chain on it.
export type RefreshPolicy = "success" | "always" | "error" | "never";

export function useMutation(refresh?: () => void) {
  const toast = useToast();
  return useCallback(
    async (
      write: () => Promise<unknown>,
      messages: { success?: string; error: string },
      opts: { refresh?: RefreshPolicy } = {}
    ): Promise<boolean> => {
      const policy = opts.refresh ?? "success";
      try {
        await write();
        if (messages.success) toast(messages.success, "success");
        if (policy === "success" || policy === "always") refresh?.();
        return true;
      } catch {
        toast(messages.error, "error");
        if (policy === "error" || policy === "always") refresh?.();
        return false;
      }
    },
    [refresh, toast]
  );
}
